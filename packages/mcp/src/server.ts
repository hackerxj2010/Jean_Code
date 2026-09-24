/**
 * MCP server mode (architecture §20.1).
 *
 * The mirror of `client.ts`: instead of Jean Code consuming other agents'
 * tools, this exposes Jean Code's own tools to any MCP client — Claude Desktop,
 * another agent, an editor extension.
 *
 * The asymmetry worth noting: as a client, Jean Code gates what a remote tool
 * may do. As a server, it is the one being gated by someone else's policy, and
 * has no way to know what that policy is. So the tools exposed here are
 * restricted to reads by default, and anything that writes must be opted into
 * explicitly by whoever starts the server.
 */

export interface ServerTool {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  /** Risk, used to decide what the default read-only surface includes. */
  risk?: 'read' | 'write' | 'execute'
  execute: (args: Record<string, unknown>) => Promise<string> | string
}

export interface ServerOptions {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  tools: ServerTool[]
  name?: string
  version?: string
  /**
   * Expose tools that write or execute.
   *
   * Off by default: a client connecting to this server decides what to call,
   * and there is no way from here to know whether a human is reviewing it.
   */
  allowMutations?: boolean
  onError?: (message: string) => void
}

interface Message {
  jsonrpc: '2.0'
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const

/** Runs an MCP server over a stream pair. Returns a stop function. */
export function serveMcp(options: ServerOptions): { stop: () => void } {
  const exposed = options.allowMutations
    ? options.tools
    : options.tools.filter((tool) => (tool.risk ?? 'read') === 'read')

  let buffer = ''
  let stopped = false

  const write = (message: Message): void => {
    if (stopped) return
    options.output.write(`${JSON.stringify(message)}\n`)
  }

  const respond = (id: number | string, result: unknown): void => {
    write({ jsonrpc: '2.0', id, result })
  }

  const respondError = (id: number | string, code: number, message: string): void => {
    write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  const handle = async (message: Message): Promise<void> => {
    const { id, method, params } = message
    if (!method) return

    // A notification carries no id and expects no reply.
    if (id === undefined || id === null) return

    switch (method) {
      case 'initialize':
        respond(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: options.name ?? 'jean-code',
            version: options.version ?? '0.1.0',
          },
        })
        return

      case 'tools/list':
        respond(id, {
          tools: exposed.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        })
        return

      case 'tools/call': {
        const request = params as { name?: string; arguments?: Record<string, unknown> } | undefined
        const tool = exposed.find((t) => t.name === request?.name)

        if (!tool) {
          // A tool hidden by the mutation policy reports as unavailable rather
          // than as nonexistent, so the caller can tell the difference.
          const hidden = options.tools.some((t) => t.name === request?.name)
          respondError(
            id,
            ErrorCode.MethodNotFound,
            hidden
              ? `${request?.name} exists but is not exposed: this server was started read-only`
              : `no tool named ${request?.name}`,
          )
          return
        }

        try {
          const output = await tool.execute(request?.arguments ?? {})
          respond(id, { content: [{ type: 'text', text: output }] })
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          options.onError?.(`${tool.name}: ${detail}`)
          // Reported as a tool-level error rather than a protocol error: the
          // client should show it to its model, not treat the server as broken.
          respond(id, { content: [{ type: 'text', text: detail }], isError: true })
        }
        return
      }

      case 'ping':
        respond(id, {})
        return

      default:
        respondError(id, ErrorCode.MethodNotFound, `unsupported method ${method}`)
    }
  }

  options.input.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString()

    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line) continue

      let message: Message
      try {
        message = JSON.parse(line) as Message
      } catch {
        write({
          jsonrpc: '2.0',
          id: null,
          error: { code: ErrorCode.ParseError, message: 'invalid JSON' },
        })
        continue
      }

      void handle(message).catch((err: unknown) => {
        options.onError?.(err instanceof Error ? err.message : String(err))
      })
    }
  })

  return {
    stop: () => {
      stopped = true
    },
  }
}

/** The tools exposed by default, for `jean mcp serve`. */
export function describeExposure(
  tools: ServerTool[],
  allowMutations: boolean,
): { exposed: string[]; withheld: string[] } {
  const exposed: string[] = []
  const withheld: string[] = []

  for (const tool of tools) {
    if (allowMutations || (tool.risk ?? 'read') === 'read') exposed.push(tool.name)
    else withheld.push(tool.name)
  }

  return { exposed, withheld }
}
