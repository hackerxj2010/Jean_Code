import { PassThrough } from 'node:stream'
import { describe, expect, test } from 'bun:test'
import { describeExposure, serveMcp, type ServerTool } from '../packages/mcp/src/index.ts'

/**
 * The server is driven over a real stream pair, so framing and dispatch are
 * exercised together rather than by calling handlers directly.
 */

function tool(name: string, risk: ServerTool['risk'] = 'read'): ServerTool {
  return {
    name,
    risk,
    description: `the ${name} tool`,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    execute: (args) => `${name} ran with ${JSON.stringify(args)}`,
  }
}

function server(tools: ServerTool[], allowMutations = false) {
  const input = new PassThrough()
  const output = new PassThrough()
  const received: Record<string, unknown>[] = []

  output.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) received.push(JSON.parse(line) as Record<string, unknown>)
    }
  })

  const handle = serveMcp({ input, output, tools, allowMutations })

  const call = async (
    id: number,
    method: string,
    params?: unknown,
  ): Promise<Record<string, unknown> | undefined> => {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    for (let i = 0; i < 50; i++) {
      const response = received.find((m) => m.id === id)
      if (response) return response
      await new Promise((r) => setTimeout(r, 20))
    }
    return undefined
  }

  return { call, received, input, stop: handle.stop }
}

describe('the MCP server handshake', () => {
  test('reports its protocol version and identity', async () => {
    const { call, stop } = server([tool('read')])
    const response = await call(1, 'initialize', {})
    const result = response?.result as {
      protocolVersion: string
      serverInfo: { name: string }
      capabilities: { tools: unknown }
    }

    expect(result.protocolVersion).toBe('2024-11-05')
    expect(result.serverInfo.name).toBe('jean-code')
    expect(result.capabilities.tools).toBeDefined()
    stop()
  })

  test('answers ping', async () => {
    const { call, stop } = server([])
    expect((await call(1, 'ping'))?.result).toBeDefined()
    stop()
  })
})

describe('tool exposure', () => {
  test('lists only read tools by default', async () => {
    const { call, stop } = server([tool('read'), tool('write', 'write'), tool('bash', 'execute')])
    const response = await call(1, 'tools/list')
    const names = (response?.result as { tools: { name: string }[] }).tools.map((t) => t.name)

    // A client connecting here decides what to call, and there is no way from
    // this side to know whether a human is reviewing it.
    expect(names).toEqual(['read'])
    stop()
  })

  test('exposes mutating tools when explicitly allowed', async () => {
    const { call, stop } = server([tool('read'), tool('write', 'write')], true)
    const response = await call(1, 'tools/list')
    const names = (response?.result as { tools: { name: string }[] }).tools.map((t) => t.name)

    expect(names).toEqual(['read', 'write'])
    stop()
  })

  test('distinguishes a withheld tool from one that does not exist', async () => {
    const { call, stop } = server([tool('write', 'write')])

    const withheld = await call(1, 'tools/call', { name: 'write', arguments: {} })
    const missing = await call(2, 'tools/call', { name: 'nonexistent', arguments: {} })

    // The caller can tell "you cannot do this here" from "that is not a thing".
    expect((withheld?.error as { message: string }).message).toContain('read-only')
    expect((missing?.error as { message: string }).message).toContain('no tool named')
    stop()
  })

  test('describeExposure reports both sides of the split', () => {
    const tools = [tool('read'), tool('write', 'write'), tool('bash', 'execute')]

    expect(describeExposure(tools, false)).toEqual({
      exposed: ['read'],
      withheld: ['write', 'bash'],
    })
    expect(describeExposure(tools, true).withheld).toEqual([])
  })
})

describe('tool calls', () => {
  test('runs a tool and returns its output', async () => {
    const { call, stop } = server([tool('read')])
    const response = await call(1, 'tools/call', {
      name: 'read',
      arguments: { value: 'x' },
    })

    const result = response?.result as { content: { type: string; text: string }[] }
    expect(result.content[0]!.type).toBe('text')
    expect(result.content[0]!.text).toContain('read ran')
    stop()
  })

  test('a failing tool reports as a tool error, not a protocol error', async () => {
    const failing: ServerTool = {
      name: 'boom',
      description: 'always fails',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        throw new Error('it exploded')
      },
    }

    const { call, stop } = server([failing])
    const response = await call(1, 'tools/call', { name: 'boom', arguments: {} })

    // The client should show this to its model, not conclude the server broke.
    expect(response?.error).toBeUndefined()
    const result = response?.result as { isError: boolean; content: { text: string }[] }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('it exploded')
    stop()
  })

  test('awaits an async tool', async () => {
    const slow: ServerTool = {
      name: 'slow',
      description: 'takes a moment',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        await new Promise((r) => setTimeout(r, 30))
        return 'finished'
      },
    }

    const { call, stop } = server([slow])
    const response = await call(1, 'tools/call', { name: 'slow', arguments: {} })
    expect((response?.result as { content: { text: string }[] }).content[0]!.text).toBe('finished')
    stop()
  })
})

describe('protocol handling', () => {
  test('reports an unsupported method', async () => {
    const { call, stop } = server([])
    const response = await call(1, 'resources/list')
    expect((response?.error as { message: string }).message).toContain('unsupported method')
    stop()
  })

  test('reports a malformed frame without closing the connection', async () => {
    const { call, input, received, stop } = server([tool('read')])

    input.write('{not json\n')
    await new Promise((r) => setTimeout(r, 50))
    expect(received.some((m) => (m.error as { code: number } | undefined)?.code === -32700)).toBe(true)

    // One bad frame must not take the connection down.
    expect((await call(1, 'initialize', {}))?.result).toBeDefined()
    stop()
  })

  test('ignores a notification, which expects no reply', async () => {
    const { input, received, stop } = server([tool('read')])

    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    await new Promise((r) => setTimeout(r, 50))

    expect(received).toHaveLength(0)
    stop()
  })

  test('handles several messages in one chunk', async () => {
    const { input, received, stop } = server([tool('read')])

    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`,
    )
    await new Promise((r) => setTimeout(r, 80))

    expect(received.map((m) => m.id).sort()).toEqual([1, 2])
    stop()
  })

  test('writes nothing after being stopped', async () => {
    const { input, received, stop } = server([tool('read')])
    stop()

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`)
    await new Promise((r) => setTimeout(r, 60))

    expect(received).toHaveLength(0)
  })
})
