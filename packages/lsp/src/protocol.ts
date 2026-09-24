import type { ChildProcess } from 'node:child_process'

/**
 * The Language Server Protocol wire layer (architecture §11).
 *
 * LSP frames messages with a `Content-Length` header and a blank line, not the
 * newline delimiting `@jean/acp` and `@jean/mcp` use. That difference is the
 * whole reason this transport exists separately: a header-framed reader has to
 * handle a body split across chunk boundaries, and a body that contains
 * newlines of its own.
 */

export interface RequestMessage {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

export interface ResponseMessage {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: ResponseError
}

export interface ResponseError {
  code: number
  message: string
  data?: unknown
}

export interface NotificationMessage {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

/** LSP error codes, including the protocol's own additions to JSON-RPC. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerNotInitialized: -32002,
  RequestCancelled: -32800,
  ContentModified: -32801,
} as const

export type NotificationHandler = (method: string, params: unknown) => void
export type RequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown

/** Thrown when a server answers a request with an error. */
export class LspError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly method: string,
  ) {
    super(message)
    this.name = 'LspError'
  }
}

/**
 * Content-Length framed JSON-RPC over a child process's stdio.
 *
 * Owns nothing but the framing and request correlation: what the messages
 * *mean* is [`LspClient`]'s problem.
 */
export class Connection {
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private closed = false

  private readonly pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; method: string }
  >()
  private readonly notificationHandlers: NotificationHandler[] = []
  private readonly requestHandlers = new Map<string, RequestHandler>()

  constructor(private readonly process: ChildProcess) {
    process.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
    process.on('exit', () => this.shutdown('the language server exited'))
    process.on('error', (err) => this.shutdown(err.message))

    // An unhandled 'error' on a stream is a process-level crash in Node, and a
    // pipe to a dying child reliably emits one. Listening is what makes it a
    // recoverable condition instead.
    process.stdin?.on('error', () => this.shutdown('the language server closed its input'))
    process.stdout?.on('error', () => this.shutdown('the language server closed its output'))
  }

  /** Registers a listener for server-initiated notifications. */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler)
  }

  /** Registers a handler for server-initiated requests. */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler)
  }

  /**
   * Sends a request and resolves with its result.
   *
   * Every request carries a timeout. A language server that stops answering —
   * indexing a huge repository, or simply wedged — must not hang the agent
   * turn that is waiting on it.
   */
  request(method: string, params?: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new LspError('the connection is closed', ErrorCode.InternalError, method))
    }

    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // Tell the server to stop working on it; a cancelled request that keeps
        // running costs CPU for an answer nobody will read.
        this.notify('$/cancelRequest', { id })
        reject(new LspError(`${method} timed out after ${timeoutMs}ms`, ErrorCode.RequestCancelled, method))
      }, timeoutMs)

      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })

      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Sends a notification, which expects no reply. */
  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.send({ jsonrpc: '2.0', method, params })
  }

  /**
   * Frames and writes one message.
   *
   * Every write is guarded, because a language server can exit at any moment —
   * crashed, killed, or shut down by us — and writing to its closed stdin
   * throws EPIPE. Unguarded, that turns a dead language server into a dead
   * agent, which is a wildly disproportionate failure for an optional feature.
   */
  private send(message: unknown): void {
    const stdin = this.process.stdin
    if (!stdin || stdin.destroyed || !stdin.writable) {
      this.shutdown('the language server is no longer accepting input')
      return
    }

    const body = Buffer.from(JSON.stringify(message), 'utf8')
    try {
      // The header length is in bytes, not characters — a body with any
      // non-ASCII content would otherwise be truncated by the reader.
      stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
      stdin.write(body)
    } catch (err) {
      this.shutdown(err instanceof Error ? err.message : 'the write failed')
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])

    // Each pass consumes exactly one complete message, so a chunk carrying
    // several (or half of one) is handled the same way.
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return

      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const match = /content-length:\s*(\d+)/i.exec(header)
      if (!match) {
        // An unparseable header means the stream is desynchronized; dropping to
        // just past it is the only way to resynchronize.
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }

      const length = Number(match[1])
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + length) return // body still arriving

      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
      this.buffer = this.buffer.subarray(bodyStart + length)
      this.dispatch(body)
    }
  }

  private dispatch(body: string): void {
    let message: Partial<RequestMessage & ResponseMessage>
    try {
      message = JSON.parse(body) as Partial<RequestMessage & ResponseMessage>
    } catch {
      return // a malformed message is not worth tearing the connection down for
    }

    // A response to something this side sent.
    if (message.id !== undefined && message.id !== null && message.method === undefined) {
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error) {
        waiter.reject(new LspError(message.error.message, message.error.code, waiter.method))
      } else {
        waiter.resolve(message.result)
      }
      return
    }

    if (!message.method) return

    // A server-initiated request.
    if (message.id !== undefined && message.id !== null) {
      const handler = this.requestHandlers.get(message.method)
      const id = message.id
      if (!handler) {
        this.send({
          jsonrpc: '2.0',
          id,
          error: { code: ErrorCode.MethodNotFound, message: `no handler for ${message.method}` },
        })
        return
      }
      void Promise.resolve(handler(message.method, message.params))
        .then((result) => this.send({ jsonrpc: '2.0', id, result }))
        .catch((err: unknown) =>
          this.send({
            jsonrpc: '2.0',
            id,
            error: {
              code: ErrorCode.InternalError,
              message: err instanceof Error ? err.message : String(err),
            },
          }),
        )
      return
    }

    for (const handler of this.notificationHandlers) {
      try {
        handler(message.method, message.params)
      } catch {
        // One bad listener must not stop the others.
      }
    }
  }

  /** Rejects everything outstanding. Safe to call more than once. */
  shutdown(reason: string): void {
    if (this.closed) return
    this.closed = true
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id)
      waiter.reject(new LspError(reason, ErrorCode.InternalError, waiter.method))
    }
  }

  get isClosed(): boolean {
    return this.closed
  }
}

/**
 * Converts an absolute path to the `file://` URI servers expect.
 *
 * Segments are encoded individually so separators survive, with one exception:
 * the colon after a Windows drive letter must stay literal. Percent-encoding it
 * produces `file:///C%3A/...`, which servers accept without complaint and then
 * silently fail to match against any document they know about — so the symptom
 * is not an error but an empty answer to every request.
 */
export function pathToUri(path: string): string {
  let normalized = path.replace(/\\/g, '/')
  // A Windows path needs the extra slash: C:/x becomes file:///C:/x.
  if (!normalized.startsWith('/')) normalized = `/${normalized}`

  const encoded = normalized
    .split('/')
    .map((segment) =>
      // `C:` is the only place a bare colon is legal in the path.
      /^[a-zA-Z]:$/.test(segment) ? segment : encodeURIComponent(segment),
    )
    .join('/')

  return `file://${encoded}`
}

/** Converts a `file://` URI back to a filesystem path. */
export function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri
  const decoded = decodeURIComponent(uri.slice('file://'.length))
  // Restore the Windows drive form that `pathToUri` padded.
  return /^\/[a-zA-Z]:/.test(decoded) ? decoded.slice(1).replace(/\//g, '\\') : decoded
}
