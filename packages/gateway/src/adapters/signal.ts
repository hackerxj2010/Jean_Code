import { splitMessage, type IncomingMessage, type OutgoingMessage, type PlatformAdapter } from '../adapter.ts'

/**
 * Signal, through `signal-cli`'s daemon.
 *
 * Signal has no bot API; the account is a real one, registered or linked
 * with `signal-cli`, and run as `signal-cli -a +15551234567 daemon --http
 * 127.0.0.1:8080`. Messages arrive as `receive` notifications on the
 * daemon's server-sent event stream; replies go out as JSON-RPC `send`
 * calls. A group message is answered in the group.
 *
 * Only listed senders — phone numbers or Signal UUIDs — reach the agent,
 * and they still need a link code.
 */

const MESSAGE_LIMIT = 6000

export interface SignalOptions {
  /** The daemon's HTTP address. Default `http://127.0.0.1:8080`. */
  url?: string
  /** The bot's own number, when the daemon serves several accounts. */
  account?: string
  /** Numbers (E.164) or UUIDs that may use the agent. */
  allowedAccounts?: string[]
  onError?: (message: string) => void
}

interface Envelope {
  source?: string
  sourceNumber?: string
  sourceUuid?: string
  sourceName?: string
  dataMessage?: { message?: string | null; groupInfo?: { groupId?: string } }
}

const GROUP = 'group:'
const EVENT_END = /\r?\n\r?\n/

export class SignalAdapter implements PlatformAdapter {
  readonly platform = 'signal'
  private running = false
  private controller?: AbortController
  private rpcId = 0

  constructor(private readonly options: SignalOptions = {}) {}

  private get base(): string {
    return (this.options.url ?? 'http://127.0.0.1:8080').replace(/\/+$/, '')
  }

  isConfigured(): boolean {
    return (this.options.allowedAccounts ?? []).length > 0
  }

  private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.base}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++this.rpcId,
        method,
        params: { ...params, ...(this.options.account ? { account: this.options.account } : {}) },
      }),
    })
    const payload = (await response.json().catch(() => ({}))) as { result?: T; error?: { message?: string } }
    if (!response.ok || payload.error) throw new Error(payload.error?.message ?? `HTTP ${response.status}`)
    return payload.result as T
  }

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    let check: Response
    try {
      check = await fetch(`${this.base}/api/v1/check`)
    } catch (err) {
      throw new Error(
        `signal-cli's daemon is not reachable at ${this.base} (${err instanceof Error ? err.message : String(err)}); start it with \`signal-cli -a <number> daemon --http 127.0.0.1:8080\``,
      )
    }
    if (!check.ok) throw new Error(`signal-cli's daemon answered ${check.status} at ${this.base}`)
    this.running = true
    void this.listen(onMessage)
  }

  /** Reads the event stream, reconnecting when it drops. */
  private async listen(onMessage: (message: IncomingMessage) => void): Promise<void> {
    const query = this.options.account ? `?account=${encodeURIComponent(this.options.account)}` : ''
    while (this.running) {
      this.controller = new AbortController()
      try {
        const response = await fetch(`${this.base}/api/v1/events${query}`, {
          headers: { accept: 'text/event-stream' },
          signal: this.controller.signal,
        })
        if (!response.ok || !response.body) throw new Error(`event stream answered ${response.status}`)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          // Events end with a blank line; their payload is on `data:` lines.
          for (let end = EVENT_END.exec(buffer); end; end = EVENT_END.exec(buffer)) {
            const block = buffer.slice(0, end.index)
            buffer = buffer.slice(end.index + end[0].length)
            const data = block
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n')
            if (data) this.receive(data, onMessage)
          }
        }
      } catch (err) {
        if (!this.running) return
        this.options.onError?.(`Signal event stream failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (this.running) await sleep(3000)
    }
  }

  private receive(data: string, onMessage: (message: IncomingMessage) => void): void {
    let event: { params?: { envelope?: Envelope }; envelope?: Envelope }
    try {
      event = JSON.parse(data)
    } catch {
      return
    }
    const envelope = event.params?.envelope ?? event.envelope
    const text = envelope?.dataMessage?.message?.trim()
    if (!envelope || !text) return
    const allowed = this.options.allowedAccounts ?? []
    const ids = [envelope.sourceNumber, envelope.source, envelope.sourceUuid].filter((id): id is string => Boolean(id))
    if (!ids.some((id) => allowed.includes(id))) return
    const sender = ids[0]!
    const group = envelope.dataMessage?.groupInfo?.groupId
    onMessage({
      platform: this.platform,
      accountId: sender,
      conversationId: group ? `${GROUP}${group}` : sender,
      text,
      senderLabel: envelope.sourceName ?? sender,
      receivedAt: Date.now(),
    })
  }

  async send(message: OutgoingMessage): Promise<void> {
    const target = message.conversationId.startsWith(GROUP)
      ? { groupId: message.conversationId.slice(GROUP.length) }
      : { recipient: [message.conversationId] }
    for (const part of splitMessage(message.text, MESSAGE_LIMIT)) {
      try {
        await this.rpc('send', { ...target, message: part })
      } catch (err) {
        this.options.onError?.(`Signal send failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false
    this.controller?.abort()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
