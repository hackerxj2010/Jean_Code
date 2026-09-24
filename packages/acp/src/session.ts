import { Connection, ErrorCode } from './connection.ts'

/**
 * ACP session serving (architecture §6.22).
 *
 * Binds the JSON-RPC transport to an agent. The shape of the protocol is
 * editor-driven: the editor owns the UI, so permission prompts and streaming
 * output are *requests back to the client* rather than terminal writes. That
 * inversion is the whole reason this cannot reuse the CLI's session loop.
 */

export interface AgentSession {
  /** Runs a turn, streaming text through `onChunk`. */
  prompt: (text: string, onChunk: (chunk: string) => void) => Promise<string>
  cancel: () => void
  /** Files the session has modified. */
  touchedFiles: () => string[]
}

export interface ServeOptions {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  /** Creates a session for a working directory. */
  createSession: (cwd: string) => Promise<AgentSession> | AgentSession
  /** Agent name reported in the handshake. */
  name?: string
  version?: string
  onError?: (message: string) => void
}

interface SessionRecord {
  id: string
  cwd: string
  agent: AgentSession
}

/**
 * Serves the Agent Client Protocol over a stream pair.
 *
 * Returns once the connection closes.
 */
export function serve(options: ServeOptions): { connection: Connection; stop: () => void } {
  const connection = new Connection(options.input, options.output)
  const sessions = new Map<string, SessionRecord>()
  let counter = 0

  connection.on('initialize', (params) => {
    const request = params as { protocolVersion?: number } | undefined
    return {
      protocolVersion: request?.protocolVersion ?? 1,
      agentInfo: {
        name: options.name ?? 'jean-code',
        version: options.version ?? '0.1.0',
      },
      agentCapabilities: {
        // Only what is actually implemented below. Advertising more makes the
        // editor send requests nothing handles, which reads as a hang.
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        loadSession: false,
      },
    }
  })

  connection.on('session/new', async (params) => {
    const request = params as { cwd?: string } | undefined
    const cwd = request?.cwd ?? process.cwd()

    const id = `sess_${++counter}`
    sessions.set(id, { id, cwd, agent: await options.createSession(cwd) })
    return { sessionId: id }
  })

  connection.on('session/prompt', async (params) => {
    const request = params as
      | { sessionId?: string; prompt?: { type: string; text?: string }[] }
      | undefined

    const session = request?.sessionId ? sessions.get(request.sessionId) : undefined
    if (!session) {
      throw Object.assign(new Error('unknown session'), { code: ErrorCode.InvalidParams })
    }

    // The prompt arrives as content blocks; only text is handled, matching what
    // the handshake advertised.
    const text = (request?.prompt ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim()

    if (!text) return { stopReason: 'end_turn' }

    try {
      await session.agent.prompt(text, (chunk) => {
        // Streamed as a notification: the editor renders it as it arrives, and
        // waiting for the whole turn would make the agent look frozen.
        connection.notify('session/update', {
          sessionId: session.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: chunk },
          },
        })
      })

      const touched = session.agent.touchedFiles()
      if (touched.length > 0) {
        connection.notify('session/update', {
          sessionId: session.id,
          update: { sessionUpdate: 'files_changed', files: touched },
        })
      }

      return { stopReason: 'end_turn' }
    } catch (err) {
      options.onError?.(err instanceof Error ? err.message : String(err))
      return { stopReason: 'error' }
    }
  })

  connection.on('session/cancel', (params) => {
    const request = params as { sessionId?: string } | undefined
    const session = request?.sessionId ? sessions.get(request.sessionId) : undefined
    session?.agent.cancel()
    return null
  })

  return {
    connection,
    stop: () => {
      for (const session of sessions.values()) session.agent.cancel()
      sessions.clear()
      connection.shutdown?.('server stopped')
    },
  }
}
