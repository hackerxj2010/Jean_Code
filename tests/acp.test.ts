import { PassThrough } from 'node:stream'
import { describe, expect, test } from 'bun:test'
import { Connection, serve, type AgentSession } from '../packages/acp/src/index.ts'

/**
 * Driven over a real stream pair rather than by calling handlers directly, so
 * the framing and correlation are exercised alongside the session logic.
 */

/** Wires a client and a server through two in-memory pipes. */
function pair() {
  const toServer = new PassThrough()
  const toClient = new PassThrough()

  const received: Record<string, unknown>[] = []
  toClient.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) received.push(JSON.parse(line) as Record<string, unknown>)
    }
  })

  return { toServer, toClient, received }
}

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    prompt: async (text, onChunk) => {
      onChunk(`echo: ${text}`)
      return `echo: ${text}`
    },
    cancel: () => undefined,
    touchedFiles: () => [],
    ...overrides,
  }
}

/** Sends a request and waits for its response to appear. */
async function call(
  toServer: PassThrough,
  received: Record<string, unknown>[],
  id: number,
  method: string,
  params?: unknown,
): Promise<Record<string, unknown> | undefined> {
  toServer.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)

  for (let i = 0; i < 60; i++) {
    const response = received.find((m) => m.id === id)
    if (response) return response
    await new Promise((r) => setTimeout(r, 20))
  }
  return undefined
}

describe('the ACP handshake', () => {
  test('reports the agent and only the capabilities it implements', async () => {
    const { toServer, toClient, received } = pair()
    const server = serve({
      input: toServer,
      output: toClient,
      createSession: () => session(),
      name: 'jean-code',
      version: '1.2.3',
    })

    const response = await call(toServer, received, 1, 'initialize', { protocolVersion: 1 })
    const result = response?.result as {
      agentInfo: { name: string; version: string }
      agentCapabilities: { loadSession: boolean }
    }

    expect(result.agentInfo.name).toBe('jean-code')
    expect(result.agentInfo.version).toBe('1.2.3')
    // Advertising a capability nothing handles makes the editor send requests
    // that never get answered, which reads as a hang.
    expect(result.agentCapabilities.loadSession).toBe(false)

    server.stop()
  })

  test('creates a session for a directory', async () => {
    const { toServer, toClient, received } = pair()
    const roots: string[] = []
    const server = serve({
      input: toServer,
      output: toClient,
      createSession: (cwd) => {
        roots.push(cwd)
        return session()
      },
    })

    const response = await call(toServer, received, 1, 'session/new', { cwd: '/projects/app' })
    expect((response?.result as { sessionId: string }).sessionId).toMatch(/^sess_/)
    expect(roots).toEqual(['/projects/app'])

    server.stop()
  })
})

describe('prompting', () => {
  async function withSession(agent: AgentSession) {
    const { toServer, toClient, received } = pair()
    const server = serve({ input: toServer, output: toClient, createSession: () => agent })

    const created = await call(toServer, received, 1, 'session/new', { cwd: '/p' })
    const sessionId = (created?.result as { sessionId: string }).sessionId
    return { toServer, received, sessionId, server }
  }

  test('runs a turn and reports the stop reason', async () => {
    const prompts: string[] = []
    const { toServer, received, sessionId, server } = await withSession(
      session({
        prompt: async (text, onChunk) => {
          prompts.push(text)
          onChunk('working')
          return 'done'
        },
      }),
    )

    const response = await call(toServer, received, 2, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'fix the bug' }],
    })

    expect(prompts).toEqual(['fix the bug'])
    expect((response?.result as { stopReason: string }).stopReason).toBe('end_turn')
    server.stop()
  })

  test('streams output as notifications rather than one final blob', async () => {
    const { toServer, received, sessionId, server } = await withSession(
      session({
        prompt: async (_text, onChunk) => {
          onChunk('first ')
          onChunk('second')
          return 'first second'
        },
      }),
    )

    await call(toServer, received, 2, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    })

    // Waiting for the whole turn before sending anything makes the agent look
    // frozen in the editor.
    const chunks = received
      .filter((m) => m.method === 'session/update')
      .map((m) => (m.params as { update: { content?: { text?: string } } }).update.content?.text)
      .filter(Boolean)

    expect(chunks).toEqual(['first ', 'second'])
    server.stop()
  })

  test('notifies which files changed', async () => {
    const { toServer, received, sessionId, server } = await withSession(
      session({ touchedFiles: () => ['/p/src/a.ts', '/p/src/b.ts'] }),
    )

    await call(toServer, received, 2, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'edit' }],
    })

    const changed = received.find(
      (m) =>
        m.method === 'session/update' &&
        (m.params as { update: { sessionUpdate: string } }).update.sessionUpdate === 'files_changed',
    )
    expect(changed).toBeDefined()
    server.stop()
  })

  test('rejects an unknown session', async () => {
    const { toServer, toClient, received } = pair()
    const server = serve({ input: toServer, output: toClient, createSession: () => session() })

    const response = await call(toServer, received, 1, 'session/prompt', {
      sessionId: 'nonexistent',
      prompt: [{ type: 'text', text: 'x' }],
    })

    expect(response?.error).toBeDefined()
    server.stop()
  })

  test('an empty prompt ends the turn without running anything', async () => {
    let ran = false
    const { toServer, received, sessionId, server } = await withSession(
      session({
        prompt: async () => {
          ran = true
          return 'x'
        },
      }),
    )

    const response = await call(toServer, received, 2, 'session/prompt', { sessionId, prompt: [] })
    expect(ran).toBe(false)
    expect((response?.result as { stopReason: string }).stopReason).toBe('end_turn')
    server.stop()
  })

  test('a failing turn reports an error stop reason rather than throwing', async () => {
    const errors: string[] = []
    const { toServer, toClient, received } = pair()
    const server = serve({
      input: toServer,
      output: toClient,
      createSession: () =>
        session({
          prompt: async () => {
            throw new Error('the model refused')
          },
        }),
      onError: (message) => errors.push(message),
    })

    const created = await call(toServer, received, 1, 'session/new', { cwd: '/p' })
    const sessionId = (created?.result as { sessionId: string }).sessionId

    const response = await call(toServer, received, 2, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    })

    expect((response?.result as { stopReason: string }).stopReason).toBe('error')
    expect(errors[0]).toContain('the model refused')
    server.stop()
  })

  test('cancel reaches the session', async () => {
    let cancelled = false
    const { toServer, received, sessionId, server } = await withSession(
      session({ cancel: () => { cancelled = true } }),
    )

    await call(toServer, received, 2, 'session/cancel', { sessionId })
    expect(cancelled).toBe(true)
    server.stop()
  })
})

describe('the transport', () => {
  test('rejects outstanding requests when the peer disconnects', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const connection = new Connection(input, output)

    const pending = connection.request('never/answered', {}, 10_000)
    // Without this the caller waits out the full timeout for an answer that can
    // never arrive.
    input.end()

    await expect(pending).rejects.toThrow(/disconnected/)
    expect(connection.isClosed).toBe(true)
  })

  test('reports an unknown method', async () => {
    const { toServer, toClient, received } = pair()
    serve({ input: toServer, output: toClient, createSession: () => session() })

    const response = await call(toServer, received, 1, 'nonexistent/method')
    expect((response?.error as { message: string }).message).toContain('no handler')
  })

  test('ignores a malformed line without closing the connection', async () => {
    const { toServer, toClient, received } = pair()
    const server = serve({ input: toServer, output: toClient, createSession: () => session() })

    toServer.write('{not json\n')
    const response = await call(toServer, received, 1, 'initialize', {})

    // One bad frame must not take the editor's connection down.
    expect(response?.result).toBeDefined()
    server.stop()
  })
})
