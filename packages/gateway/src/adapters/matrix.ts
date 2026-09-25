import { splitMessage, type IncomingMessage, type OutgoingMessage, type PlatformAdapter } from '../adapter.ts'

/**
 * Matrix, over the client-server API.
 *
 * Plain HTTP, like Telegram: `/sync` long-polls for new events and a message
 * is one `PUT`. The first sync only takes the position — answering the
 * backlog of every room the bot is in would reply to messages from last
 * week. Invitations are accepted only from allowed accounts, so the bot
 * cannot be pulled into rooms by strangers; in a room, only allowed senders
 * are heard, and they still need a link code.
 */

const MESSAGE_LIMIT = 30_000
const API = '/_matrix/client/v3'

export interface MatrixOptions {
  /** The homeserver's base URL, e.g. `https://matrix.org`. */
  homeserver: string
  /** The bot account's access token. */
  accessToken: string
  /** Matrix user ids (`@you:example.org`) that may use the agent. */
  allowedAccounts?: string[]
  onError?: (message: string) => void
}

interface SyncResponse {
  next_batch: string
  rooms?: {
    join?: Record<string, { timeline?: { events?: MatrixEvent[] } }>
    invite?: Record<string, { invite_state?: { events?: MatrixEvent[] } }>
  }
}

interface MatrixEvent {
  type: string
  sender: string
  state_key?: string
  content?: { msgtype?: string; body?: string; membership?: string }
}

/** What the sync asks for: messages and invitations, nothing else. */
const FILTER = JSON.stringify({
  presence: { types: [] },
  account_data: { types: [] },
  room: {
    timeline: { limit: 50, types: ['m.room.message'] },
    state: { types: [] },
    ephemeral: { types: [] },
    account_data: { types: [] },
  },
})

export class MatrixAdapter implements PlatformAdapter {
  readonly platform = 'matrix'
  private userId?: string
  private since?: string
  private running = false
  private controller?: AbortController
  private txn = 0

  constructor(private readonly options: MatrixOptions) {}

  isConfigured(): boolean {
    return Boolean(this.options.homeserver && this.options.accessToken)
  }

  private url(path: string): string {
    return `${this.options.homeserver.replace(/\/+$/, '')}${API}${path}`
  }

  private async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(this.url(path), {
      method,
      headers: {
        authorization: `Bearer ${this.options.accessToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    const payload = (await response.json().catch(() => ({}))) as T & { error?: string; errcode?: string }
    if (!response.ok) throw new Error(payload.error ?? payload.errcode ?? `HTTP ${response.status}`)
    return payload
  }

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    if (!this.isConfigured()) throw new Error('Matrix needs a homeserver and an access token')
    const me = await this.call<{ user_id: string }>('GET', '/account/whoami')
    this.userId = me.user_id
    // Where "now" is: everything before it is history, not a request.
    const first = await this.call<SyncResponse>('GET', `/sync?timeout=0&filter=${encodeURIComponent(FILTER)}`)
    this.since = first.next_batch
    await this.acceptInvites(first)
    this.running = true
    void this.loop(onMessage)
  }

  private async loop(onMessage: (message: IncomingMessage) => void): Promise<void> {
    while (this.running) {
      this.controller = new AbortController()
      try {
        const sync = await this.call<SyncResponse>(
          'GET',
          `/sync?timeout=30000&since=${encodeURIComponent(this.since ?? '')}&filter=${encodeURIComponent(FILTER)}`,
          undefined,
          this.controller.signal,
        )
        this.since = sync.next_batch
        await this.acceptInvites(sync)
        for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
          for (const event of room.timeline?.events ?? []) {
            const text = event.content?.msgtype === 'm.text' ? (event.content.body ?? '').trim() : ''
            if (event.type !== 'm.room.message' || event.sender === this.userId || !text) continue
            if (!this.allowed(event.sender)) continue
            onMessage({
              platform: this.platform,
              accountId: event.sender,
              conversationId: roomId,
              text,
              senderLabel: event.sender,
              receivedAt: Date.now(),
            })
          }
        }
      } catch (err) {
        if (!this.running) return
        this.options.onError?.(`Matrix sync failed: ${err instanceof Error ? err.message : String(err)}`)
        await sleep(5000)
      }
    }
  }

  private allowed(account: string): boolean {
    return (this.options.allowedAccounts ?? []).includes(account)
  }

  /** Joins rooms an allowed account invited the bot to; ignores the rest. */
  private async acceptInvites(sync: SyncResponse): Promise<void> {
    for (const [roomId, room] of Object.entries(sync.rooms?.invite ?? {})) {
      const invite = (room.invite_state?.events ?? []).find(
        (event) => event.type === 'm.room.member' && event.state_key === this.userId && event.content?.membership === 'invite',
      )
      if (!invite || !this.allowed(invite.sender)) continue
      await this.call('POST', `/join/${encodeURIComponent(roomId)}`, {}).catch((err) =>
        this.options.onError?.(`Matrix could not join ${roomId}: ${err instanceof Error ? err.message : String(err)}`),
      )
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    for (const part of splitMessage(message.text, MESSAGE_LIMIT)) {
      const content: Record<string, string> = { msgtype: 'm.text', body: part }
      if (message.monospace) {
        content.format = 'org.matrix.custom.html'
        content.formatted_body = `<pre><code>${escapeHtml(part)}</code></pre>`
      }
      const txn = `jean-${Date.now()}-${++this.txn}`
      try {
        await this.call('PUT', `/rooms/${encodeURIComponent(message.conversationId)}/send/m.room.message/${txn}`, content)
      } catch (err) {
        this.options.onError?.(`Matrix send failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /** Shows a typing indicator, so a long turn does not look like a hang. */
  async indicateTyping(conversationId: string): Promise<void> {
    if (!this.userId) return
    const path = `/rooms/${encodeURIComponent(conversationId)}/typing/${encodeURIComponent(this.userId)}`
    await this.call('PUT', path, { typing: true, timeout: 30_000 }).catch(() => undefined)
  }

  async stop(): Promise<void> {
    this.running = false
    this.controller?.abort()
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
