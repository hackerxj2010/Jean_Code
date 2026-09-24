/**
 * The Chrome DevTools Protocol client (architecture §18).
 *
 * CDP is JSON-RPC over a WebSocket, which Bun and modern Node both provide, so
 * driving a real browser needs no dependency at all. That is worth stating
 * because the usual approach — Puppeteer or Playwright — pulls in a browser
 * download and a native binding, and neither is necessary to send
 * `Page.navigate` down a socket.
 */

export interface CdpEvent {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

export class CdpError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly code?: number,
  ) {
    super(message)
    this.name = 'CdpError'
  }
}

type Waiter = { resolve: (value: unknown) => void; reject: (err: Error) => void; method: string }

export class CdpConnection {
  private socket?: WebSocket
  private nextId = 1
  private closed = false

  private readonly pending = new Map<number, Waiter>()
  private readonly listeners: ((event: CdpEvent) => void)[] = []
  /** Buffered until a listener asks for them, so early events are not lost. */
  private readonly recent: CdpEvent[] = []

  constructor(private readonly url: string) {}

  async connect(timeoutMs = 10_000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url)
      const timer = setTimeout(() => {
        socket.close()
        reject(new CdpError(`could not connect to ${this.url} within ${timeoutMs}ms`, 'connect'))
      }, timeoutMs)

      socket.addEventListener('open', () => {
        clearTimeout(timer)
        this.socket = socket
        resolve()
      })

      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new CdpError(`the WebSocket to ${this.url} failed`, 'connect'))
      })

      socket.addEventListener('close', () => {
        this.shutdown('the browser closed the connection')
      })

      socket.addEventListener('message', (message: MessageEvent) => {
        this.onMessage(String(message.data))
      })
    })
  }

  private onMessage(raw: string): void {
    let message: {
      id?: number
      result?: unknown
      error?: { message: string; code?: number }
      method?: string
      params?: Record<string, unknown>
      sessionId?: string
    }

    try {
      message = JSON.parse(raw) as typeof message
    } catch {
      return
    }

    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)

      if (message.error) {
        waiter.reject(new CdpError(message.error.message, waiter.method, message.error.code))
      } else {
        waiter.resolve(message.result)
      }
      return
    }

    if (!message.method) return

    const event: CdpEvent = {
      method: message.method,
      params: message.params ?? {},
      sessionId: message.sessionId,
    }

    // Kept in a ring so a listener attached after navigation can still see the
    // console errors that navigation produced.
    this.recent.push(event)
    if (this.recent.length > 500) this.recent.shift()

    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // One bad listener must not stop the others.
      }
    }
  }

  /** Sends a command and resolves with its result. */
  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.closed || !this.socket) {
      return Promise.reject(new CdpError('the connection is closed', method))
    }

    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(`${method} timed out after ${timeoutMs}ms`, method))
      }, timeoutMs)

      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })

      this.socket!.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.push(listener)
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index >= 0) this.listeners.splice(index, 1)
    }
  }

  /** Events seen so far, optionally filtered by method prefix. */
  buffered(prefix?: string): CdpEvent[] {
    return prefix ? this.recent.filter((event) => event.method.startsWith(prefix)) : [...this.recent]
  }

  clearBuffer(): void {
    this.recent.length = 0
  }

  /**
   * Waits for one event.
   *
   * The listener is attached before the caller's action runs, which is why this
   * returns a promise rather than taking a callback: attaching after would race
   * with a fast page load and wait forever for an event already delivered.
   */
  waitFor(method: string, timeoutMs = 30_000): Promise<CdpEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        remove()
        reject(new CdpError(`${method} did not fire within ${timeoutMs}ms`, method))
      }, timeoutMs)

      const remove = this.onEvent((event) => {
        if (event.method !== method) return
        clearTimeout(timer)
        remove()
        resolve(event)
      })
    })
  }

  shutdown(reason: string): void {
    if (this.closed) return
    this.closed = true

    for (const [id, waiter] of this.pending) {
      this.pending.delete(id)
      waiter.reject(new CdpError(reason, waiter.method))
    }

    try {
      this.socket?.close()
    } catch {
      // Already gone.
    }
    this.socket = undefined
  }

  get isClosed(): boolean {
    return this.closed
  }
}
