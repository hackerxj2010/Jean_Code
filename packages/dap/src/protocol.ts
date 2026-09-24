import type { ChildProcess } from 'node:child_process'

/**
 * The Debug Adapter Protocol wire layer (architecture §8.3).
 *
 * DAP uses the same `Content-Length` framing as LSP but a different message
 * envelope: `{type: "request"|"response"|"event", seq, ...}` rather than
 * JSON-RPC. The `seq` counter is shared across every message kind, and a
 * response correlates by `request_seq`, not by `id`.
 */

export interface Request {
  seq: number
  type: 'request'
  command: string
  arguments?: unknown
}

export interface Response {
  seq: number
  type: 'response'
  request_seq: number
  success: boolean
  command: string
  message?: string
  body?: unknown
}

export interface Event {
  seq: number
  type: 'event'
  event: string
  body?: unknown
}

export type Message = Request | Response | Event

/** Thrown when an adapter answers a request with `success: false`. */
export class DapError extends Error {
  constructor(
    message: string,
    readonly command: string,
  ) {
    super(message)
    this.name = 'DapError'
  }
}

export type EventHandler = (event: string, body: unknown) => void
export type ReverseRequestHandler = (command: string, args: unknown) => Promise<unknown> | unknown

/**
 * Content-Length framed DAP over a child process's stdio.
 *
 * Structured like `@jean/lsp`'s connection but not shared with it: the two
 * protocols agree on framing and on nothing else, and a common abstraction
 * over both would be a type union pretending to be a design.
 */
export class Connection {
  private buffer = Buffer.alloc(0)
  private seq = 1
  private closed = false

  private readonly pending = new Map<
    number,
    { resolve: (body: unknown) => void; reject: (err: Error) => void; command: string }
  >()
  private readonly eventHandlers: EventHandler[] = []
  private readonly reverseHandlers = new Map<string, ReverseRequestHandler>()

  constructor(private readonly process: ChildProcess) {
    process.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
    process.on('exit', () => this.shutdown('the debug adapter exited'))
    process.on('error', (err) => this.shutdown(err.message))
    // An unhandled stream error is a process-level crash in Node; a pipe to a
    // dying adapter reliably emits one.
    process.stdin?.on('error', () => this.shutdown('the debug adapter closed its input'))
    process.stdout?.on('error', () => this.shutdown('the debug adapter closed its output'))
  }

  /** Subscribes to adapter events: `stopped`, `output`, `terminated`, … */
  onEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler)
  }

  /** Handles a reverse request — adapters ask the client to run things. */
  onReverseRequest(command: string, handler: ReverseRequestHandler): void {
    this.reverseHandlers.set(command, handler)
  }

  /**
   * Sends a request and resolves with its body.
   *
   * The default timeout is generous because several DAP commands legitimately
   * block: `launch` waits for a process to start, and `continue` returns only
   * once the debuggee is running again.
   */
  request(command: string, args?: unknown, timeoutMs = 20_000): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new DapError('the connection is closed', command))
    }

    const seq = this.seq++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new DapError(`${command} timed out after ${timeoutMs}ms`, command))
      }, timeoutMs)

      this.pending.set(seq, {
        command,
        resolve: (body) => {
          clearTimeout(timer)
          resolve(body)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })

      this.send({ seq, type: 'request', command, arguments: args })
    })
  }

  private send(message: unknown): void {
    const stdin = this.process.stdin
    if (!stdin || stdin.destroyed || !stdin.writable) {
      this.shutdown('the debug adapter is no longer accepting input')
      return
    }

    const body = Buffer.from(JSON.stringify(message), 'utf8')
    try {
      stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
      stdin.write(body)
    } catch (err) {
      this.shutdown(err instanceof Error ? err.message : 'the write failed')
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])

    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return

      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const match = /content-length:\s*(\d+)/i.exec(header)
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }

      const length = Number(match[1])
      const start = headerEnd + 4
      if (this.buffer.length < start + length) return

      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      this.dispatch(body)
    }
  }

  private dispatch(body: string): void {
    let message: Message
    try {
      message = JSON.parse(body) as Message
    } catch {
      return
    }

    switch (message.type) {
      case 'response': {
        const waiter = this.pending.get(message.request_seq)
        if (!waiter) return
        this.pending.delete(message.request_seq)

        if (message.success) {
          waiter.resolve(message.body)
        } else {
          waiter.reject(
            new DapError(message.message ?? `${message.command} failed`, message.command),
          )
        }
        return
      }

      case 'event':
        for (const handler of this.eventHandlers) {
          try {
            handler(message.event, message.body)
          } catch {
            // One bad listener must not stop the others.
          }
        }
        return

      case 'request': {
        // A reverse request: the adapter asking the client to do something,
        // most often `runInTerminal` to start the debuggee.
        const handler = this.reverseHandlers.get(message.command)
        const requestSeq = message.seq

        if (!handler) {
          this.send({
            seq: this.seq++,
            type: 'response',
            request_seq: requestSeq,
            success: false,
            command: message.command,
            message: `no handler for ${message.command}`,
          })
          return
        }

        void Promise.resolve(handler(message.command, message.arguments))
          .then((result) =>
            this.send({
              seq: this.seq++,
              type: 'response',
              request_seq: requestSeq,
              success: true,
              command: message.command,
              body: result,
            }),
          )
          .catch((err: unknown) =>
            this.send({
              seq: this.seq++,
              type: 'response',
              request_seq: requestSeq,
              success: false,
              command: message.command,
              message: err instanceof Error ? err.message : String(err),
            }),
          )
        return
      }
    }
  }

  /** Rejects everything outstanding. Safe to call more than once. */
  shutdown(reason: string): void {
    if (this.closed) return
    this.closed = true
    for (const [seq, waiter] of this.pending) {
      this.pending.delete(seq)
      waiter.reject(new DapError(reason, waiter.command))
    }
  }

  get isClosed(): boolean {
    return this.closed
  }
}
