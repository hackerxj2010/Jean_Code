import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ServerEvent,
  createServer,
  serverEvents,
} from '../packages/cli/src/commands/server.ts'

/**
 * `jean serve`: sessions over HTTP, streamed as events, with a tool's
 * permission question sent to the client that is watching — driven by a
 * stand-in model speaking Chat Completions, so nothing leaves the machine.
 */

const temps: string[] = []
const saved: Record<string, string | undefined> = {}
const KEYS = ['JEAN_HOME', 'JEAN_CONFIG_CONTENT', 'JEAN_AUTH_FILE', 'JEAN_MODEL_STATE']

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jean-serve-')))
  temps.push(dir)
  return dir
}

/** Streams one Chat Completions answer: a `bash` call when asked to run, words otherwise. */
function model() {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: unknown }[] }
      const last = body.messages[body.messages.length - 1]!
      const frames: unknown[] = []
      if (last.role === 'tool') {
        frames.push({ choices: [{ delta: { content: `done: ${String(last.content).trim()}` } }] })
        frames.push({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 4 },
        })
      } else if (JSON.stringify(last.content).includes('run it')) {
        frames.push({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'bash', arguments: '{"command":"echo served-output"}' },
                  },
                ],
              },
            },
          ],
        })
        frames.push({
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        })
      } else {
        frames.push({ choices: [{ delta: { content: 'hello from ' } }] })
        frames.push({ choices: [{ delta: { content: 'the server' } }] })
        frames.push({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        })
      }
      const text = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`
      return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
}

let stub: ReturnType<typeof model>
let project: string

beforeAll(() => {
  for (const key of KEYS) saved[key] = process.env[key]
  const home = workspace()
  project = workspace()
  stub = model()
  process.env.JEAN_HOME = home
  process.env.JEAN_AUTH_FILE = join(home, 'auth.json')
  process.env.JEAN_MODEL_STATE = join(home, 'models.json')
  process.env.JEAN_CONFIG_CONTENT = JSON.stringify({
    model: { modelId: 'stub:echo-1' },
    providers: { stub: { baseUrl: `http://127.0.0.1:${stub.port}/v1`, name: 'Stub' } },
    permissionMode: 'ask',
    autoCompact: false,
  })
})

afterAll(() => {
  stub.stop(true)
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('jean serve', () => {
  test('a session streams its answer, relays a permission question, and is saved', async () => {
    const server = createServer({ cwd: project })
    const http = Bun.serve({ port: 0, idleTimeout: 0, fetch: server.handle })
    const base = `http://127.0.0.1:${http.port}`
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    try {
      expect(((await (await fetch(`${base}/health`)).json()) as { ok: boolean }).ok).toBe(true)

      const opened = await post('/sessions', { cwd: project })
      expect(opened.status).toBe(201)
      const session = (await opened.json()) as { id: string; model: string }
      expect(session.model).toBe('stub:echo-1')

      // Words, streamed.
      const events: ServerEvent[] = []
      for await (const event of serverEvents(
        await post(`/sessions/${session.id}/prompt`, { text: 'say hi' }),
      )) {
        events.push(event)
        if (event.type === 'done') break
      }
      const said = events
        .filter((event) => event.type === 'text')
        .map((event) => (event as { delta: string }).delta)
        .join('')
      expect(said).toBe('hello from the server')
      expect(events.at(-1)).toMatchObject({ type: 'done', result: { stopReason: 'complete' } })

      // A command: when a question comes, it comes to this client, which says yes.
      let output = ''
      let finalText = ''
      for await (const event of serverEvents(
        await post(`/sessions/${session.id}/prompt`, { text: 'run it' }),
      )) {
        if (event.type === 'permission') {
          expect(event.tool).toBe('bash')
          await post(`/sessions/${session.id}/permissions/${event.id}`, { allow: true })
        }
        if (event.type === 'tool_end') output = event.result.output
        if (event.type === 'done') {
          finalText = event.result.text
          break
        }
      }
      expect(output).toContain('served-output')
      expect(finalText).toContain('done:')

      // Open and saved sessions are both listed.
      const listed = (await (await fetch(`${base}/sessions`)).json()) as {
        live: { id: string }[]
        saved: { id: string }[]
      }
      expect(listed.live.map((entry) => entry.id)).toContain(session.id)
      expect(listed.saved.map((entry) => entry.id)).toContain(session.id)

      const closed = await fetch(`${base}/sessions/${session.id}`, { method: 'DELETE' })
      expect(closed.status).toBe(200)
      expect((await fetch(`${base}/sessions/${session.id}`)).status).toBe(404)
    } finally {
      server.closeAll()
      http.stop(true)
    }
  }, 60_000)

  test('a password is required when one is set', async () => {
    process.env.JEAN_SERVER_PASSWORD = 's3cret'
    const server = createServer({ cwd: project })
    try {
      expect((await server.handle(new Request('http://x/health'))).status).toBe(401)
      const ok = await server.handle(
        new Request('http://x/health', {
          headers: { authorization: `Basic ${Buffer.from('jean:s3cret').toString('base64')}` },
        }),
      )
      expect(ok.status).toBe(200)
    } finally {
      delete process.env.JEAN_SERVER_PASSWORD
    }
  })

  test('`jean -p … --attach` runs the prompt on the server', async () => {
    const server = createServer({ cwd: project })
    const http = Bun.serve({ port: 0, idleTimeout: 0, fetch: server.handle })
    try {
      const child = Bun.spawn(
        [
          'bun',
          join(import.meta.dir, '..', 'packages', 'cli', 'src', 'index.ts'),
          '-p',
          'say hi',
          '--attach',
          `http://127.0.0.1:${http.port}`,
          '--no-import',
        ],
        {
          cwd: project,
          env: { ...process.env, NO_COLOR: '1' },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(out + err).toContain('hello from the server')
      expect(code).toBe(0)
    } finally {
      server.closeAll()
      http.stop(true)
    }
  }, 60_000)

  test('`jean serve mcp` lists only the tools that read, unless told otherwise', async () => {
    const child = Bun.spawn(
      [
        'bun',
        join(import.meta.dir, '..', 'packages', 'cli', 'src', 'index.ts'),
        'serve',
        'mcp',
        '--no-import',
      ],
      {
        cwd: project,
        env: { ...process.env, NO_COLOR: '1' },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
    )
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
    child.stdin.flush()

    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const deadline = Date.now() + 45_000
    while (!text.includes('"id":2') && Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value)
    }
    child.stdin.end()
    await child.exited

    const listing = text
      .split('\n')
      .filter(Boolean)
      .map((row) => JSON.parse(row) as { id?: number; result?: { tools?: { name: string }[] } })
      .find((message) => message.id === 2)
    const names = listing?.result?.tools?.map((tool) => tool.name) ?? []
    expect(names).toContain('read')
    expect(names).toContain('grep')
    expect(names).not.toContain('bash')
    expect(names).not.toContain('write')
  }, 60_000)
})
