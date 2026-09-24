/**
 * The Agent Client Protocol transport.
 *
 * Newline-delimited JSON-RPC with request/response correlation and notification
 * dispatch. Split from `index.ts` so `session.ts` can import it without a cycle.
 */

export interface Request {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

export interface Response {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** Standard JSON-RPC error codes. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const

export type Handler = (params: unknown) => Promise<unknown> | unknown

/**
 * Newline-delimited JSON-RPC over a pair of streams.
 *
 * Transport-agnostic on purpose: the same class serves stdio for an editor and
 * a socket for a remote client.
 */
export class Connection {
  private buffer = ''
  private nextId = 1
  private readonly handlers = new Map<string, Handler>()
  private readonly pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >()

  private closed = false

  constructor(
    input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
  ) {
    input.on('data', (chunk: Buffer | string) => this.onData(chunk.toString()))
    // A closed stream must reject what is outstanding: an editor that
    // disconnects mid-request would otherwise leave the caller waiting out the
    // full timeout for an answer that can never arrive.
    input.on('end', () => this.shutdown('the peer disconnected'))
    input.on('error', (err: Error) => this.shutdown(err.message))
  }

  /** Registers a method handler. */
  on(method: string, handler: Handler): void {
    this.handlers.set(method, handler)
  }

  /** Rejects everything outstanding. Safe to call more than once. */
  shutdown(reason: string): void {
    if (this.closed) return
    this.closed = true
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id)
      waiter.reject(new Error(reason))
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Sends a request and resolves with its result. */
  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })

      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Sends a notification, which expects no reply. */
  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(message: unknown): void {
    this.output.write(`${JSON.stringify(message)}\n`)
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')

    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      if (line) void this.dispatch(line)
    }
  }

  private async dispatch(line: string): Promise<void> {
    let message: Partial<Request & Response>
    try {
      message = JSON.parse(line) as Partial<Request & Response>
    } catch {
      this.write({
        jsonrpc: '2.0',
        id: null,
        error: { code: ErrorCode.ParseError, message: 'invalid JSON' },
      })
      return
    }

    // A response to something this side sent.
    if (message.id !== undefined && message.id !== null && message.method === undefined) {
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
      return
    }

    if (!message.method) return

    const handler = this.handlers.get(message.method)
    if (!handler) {
      // A missing handler for a *notification* is not an error worth replying to.
      if (message.id !== undefined && message.id !== null) {
        this.write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: ErrorCode.MethodNotFound, message: `no handler for ${message.method}` },
        })
      }
      return
    }

    try {
      const result = await handler(message.params)
      if (message.id !== undefined && message.id !== null) {
        this.write({ jsonrpc: '2.0', id: message.id, result })
      }
    } catch (err) {
      if (message.id !== undefined && message.id !== null) {
        this.write({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: ErrorCode.InternalError,
            message: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
  }
}
