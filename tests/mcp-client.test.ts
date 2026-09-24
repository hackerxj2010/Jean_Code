import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpClient, connectAll } from '../packages/mcp/src/index.ts'

/**
 * The MCP client over each transport, against small real servers: a stdio
 * process, a Streamable HTTP endpoint, and an old-style HTTP + SSE endpoint.
 */

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn()
    } catch {
      // Best effort.
    }
  }
})

/** The answers every test server gives, keyed by method. */
function answer(message: {
  id?: number
  method?: string
  params?: { name?: string; arguments?: unknown }
}) {
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 't', version: '1' },
      }
    case 'tools/list':
      return {
        tools: [
          {
            name: 'echo',
            description: 'Echo it',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          },
          { name: 'Hidden-Tool', description: 'x' },
        ],
      }
    case 'tools/call':
      return {
        content: [{ type: 'text', text: `echo: ${JSON.stringify(message.params?.arguments)}` }],
      }
    default:
      return {}
  }
}

describe('stdio transport', () => {
  test('connects, lists tools, and calls one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jean-mcp-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const script = join(dir, 'server.ts')
    writeFileSync(
      script,
      `const answer = ${answer.toString()}
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString()
  let i
  while ((i = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.id === undefined) continue
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: answer(message) }) + '\\n')
  }
})
`,
    )

    const client = new McpClient('local', { command: 'bun', args: [script], deny: ['Hidden-Tool'] })
    cleanups.push(() => client.close())
    await client.connect()
    expect(client.transportName).toBe('stdio')
    const tools = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['echo'])
    expect(await client.callTool('echo', { text: 'hi' })).toBe('echo: {"text":"hi"}')
  }, 30_000)
})

describe('Streamable HTTP transport', () => {
  test('uses the session id, and reads replies sent as JSON or as SSE', async () => {
    const seen: { session: string | null; version: string | null; auth: string | null }[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method === 'DELETE') return new Response(null, { status: 204 })
        const message = (await request.json()) as Parameters<typeof answer>[0]
        seen.push({
          session: request.headers.get('mcp-session-id'),
          version: request.headers.get('mcp-protocol-version'),
          auth: request.headers.get('authorization'),
        })
        if (message.id === undefined) return new Response(null, { status: 202 })
        const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: answer(message) })
        if (message.method === 'tools/list') {
          // Streamed replies arrive as SSE frames.
          return new Response(`event: message\ndata: ${body}\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          })
        }
        return new Response(body, {
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-123' },
        })
      },
    })
    cleanups.push(() => server.stop(true))

    process.env.JEAN_TEST_MCP_TOKEN = 'secret-token'
    const client = new McpClient('remote', {
      url: `http://localhost:${server.port}/mcp`,
      headers: { Authorization: 'Bearer ${JEAN_TEST_MCP_TOKEN}' },
    })
    cleanups.push(() => client.close())
    await client.connect()
    expect(client.transportName).toBe('http')
    expect((await client.listTools()).map((t) => t.name)).toContain('echo')
    expect(await client.callTool('echo', { n: 1 })).toBe('echo: {"n":1}')

    // Everything after initialize carries the session and the protocol version.
    expect(seen[0]!.session).toBeNull()
    expect(seen.slice(1).every((s) => s.session === 'session-123')).toBe(true)
    expect(seen.every((s) => s.version === '2025-06-18')).toBe(true)
    // `${VAR}` in a header reads the environment.
    expect(seen[0]!.auth).toBe('Bearer secret-token')
  }, 30_000)
})

describe('HTTP + SSE transport', () => {
  function legacyServer() {
    let push: ((text: string) => void) | undefined
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (request.method === 'GET' && url.pathname === '/sse') {
          const stream = new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder()
              push = (text) => controller.enqueue(encoder.encode(text))
              push('event: endpoint\ndata: /messages?sid=1\n\n')
            },
          })
          return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
        }
        if (request.method === 'POST' && url.pathname === '/messages') {
          const message = (await request.json()) as Parameters<typeof answer>[0]
          if (message.id !== undefined) {
            push?.(
              `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: answer(message) })}\n\n`,
            )
          }
          return new Response(null, { status: 202 })
        }
        // The old transport does not accept a POST at the stream URL.
        return new Response('method not allowed', { status: 405 })
      },
    })
    return server
  }

  test('works when named explicitly', async () => {
    const server = legacyServer()
    cleanups.push(() => server.stop(true))
    const client = new McpClient('old', { type: 'sse', url: `http://localhost:${server.port}/sse` })
    cleanups.push(() => client.close())
    await client.connect()
    expect(client.transportName).toBe('sse')
    expect(await client.callTool('echo', { a: 1 })).toBe('echo: {"a":1}')
  }, 30_000)

  test('an untyped url falls back to it when Streamable HTTP is refused', async () => {
    const server = legacyServer()
    cleanups.push(() => server.stop(true))
    const client = new McpClient('old', { url: `http://localhost:${server.port}/sse` })
    cleanups.push(() => client.close())
    await client.connect()
    expect(client.transportName).toBe('sse')
    expect((await client.listTools()).length).toBe(2)
  }, 30_000)
})

describe('connectAll', () => {
  test('connects in parallel and reports a broken server without failing the rest', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const message = (await request.json()) as Parameters<typeof answer>[0]
        if (message.id === undefined) return new Response(null, { status: 202 })
        return Response.json({ jsonrpc: '2.0', id: message.id, result: answer(message) })
      },
    })
    cleanups.push(() => server.stop(true))
    const result = await connectAll(
      {
        good: { type: 'http', url: `http://localhost:${server.port}/` },
        broken: { command: 'definitely-not-a-real-binary-xyz' },
      },
      { timeoutMs: 5000 },
    )
    cleanups.push(() => result.clients.forEach((c) => c.close()))
    expect(Object.keys(result.tools)).toEqual(['good'])
    expect(result.tools.good!.map((t) => t.name)).toEqual(['echo', 'hidden_tool'])
    expect(result.warnings.some((w) => w.includes('broken'))).toBe(true)
  }, 30_000)
})
