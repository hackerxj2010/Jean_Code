import {
  splitMessage,
  type IncomingMessage,
  type OutgoingMessage,
  type PlatformAdapter,
} from '../adapter.ts'

/**
 * Discord (architecture §15).
 *
 * Discord has no long-polling equivalent: receiving messages means holding a
 * Gateway WebSocket open and answering heartbeats. That is more moving parts
 * than Telegram's polling loop, and all of them are failure modes — a missed
 * heartbeat disconnects, a resume needs the session id and the last sequence
 * number, and an invalid session means starting over.
 *
 * Implemented directly over `fetch` and `WebSocket` rather than through
 * discord.js, which would bring a dependency tree larger than the rest of this
 * repository.
 */

/** Discord rejects a message body longer than this. */
const MESSAGE_LIMIT = 2000

const GATEWAY_VERSION = 10

/** The Gateway opcodes this adapter handles. */
const OP = {
  dispatch: 0,
  heartbeat: 1,
  identify: 2,
  resume: 6,
  reconnect: 7,
  invalidSession: 9,
  hello: 10,
  heartbeatAck: 11,
} as const

/**
 * Gateway intents.
 *
 * `MESSAGE_CONTENT` is privileged and must be enabled in the application's
 * settings. Without it every message arrives with an empty `content`, which
 * looks exactly like users sending blank messages — so it is checked for
 * explicitly rather than left to puzzle over.
 */
const INTENTS = {
  guildMessages: 1 << 9,
  directMessages: 1 << 12,
  messageContent: 1 << 15,
} as const

interface GatewayPayload {
  op: number
  d?: unknown
  s?: number | null
  t?: string | null
}

interface DiscordMessage {
  id: string
  channel_id: string
  content: string
  author: { id: string; username: string; bot?: boolean }
  attachments?: { url: string; content_type?: string }[]
}

export interface DiscordOptions {
  token: string
  /** Only these user ids may talk to the bot. Empty means nobody. */
  allowedAccounts?: string[]
  /** Channels to listen in. Empty means every channel the bot can see. */
  allowedChannels?: string[]
  /** Require an @mention in a guild channel. Direct messages never need one. */
  requireMention?: boolean
  onError?: (message: string) => void
}

export class DiscordAdapter implements PlatformAdapter {
  readonly platform = 'discord'

  private readonly options: DiscordOptions
  private socket?: WebSocket
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private sequence: number | null = null
  private sessionId?: string
  private resumeUrl?: string
  private selfId?: string
  private running = false
  /** Set when a heartbeat was sent and not yet acknowledged. */
  private awaitingAck = false
  private reconnectAttempts = 0

  constructor(options: DiscordOptions) {
    this.options = options
  }

  isConfigured(): boolean {
    return Boolean(this.options.token)
  }

  /** Verifies the token and returns the bot's own username. */
  async verify(): Promise<{ ok: boolean; username?: string; id?: string; error?: string }> {
    try {
      const response = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { authorization: `Bot ${this.options.token}` },
      })

      if (!response.ok) {
        const body = await response.text()
        return { ok: false, error: `HTTP ${response.status}: ${body.slice(0, 200)}` }
      }

      const body = (await response.json()) as { id: string; username: string }
      this.selfId = body.id
      return { ok: true, username: body.username, id: body.id }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    if (!this.isConfigured()) throw new Error('no Discord bot token configured')

    const verified = await this.verify()
    if (!verified.ok) throw new Error(`Discord rejected the token: ${verified.error}`)

    this.running = true
    await this.connect(onMessage)
  }

  private async connect(onMessage: (message: IncomingMessage) => void): Promise<void> {
    if (!this.running) return

    const url = this.resumeUrl ?? 'wss://gateway.discord.gg'
    const socket = new WebSocket(`${url}/?v=${GATEWAY_VERSION}&encoding=json`)
    this.socket = socket

    socket.addEventListener('message', (event) => {
      let payload: GatewayPayload
      try {
        payload = JSON.parse(String(event.data)) as GatewayPayload
      } catch {
        this.options.onError?.('Discord sent a payload that is not JSON')
        return
      }

      // The sequence number is tracked for every payload that carries one: a
      // resume replays from it, and resuming from the wrong place either loses
      // messages or delivers them twice.
      if (typeof payload.s === 'number') this.sequence = payload.s

      this.handlePayload(payload, onMessage)
    })

    socket.addEventListener('close', (event) => {
      this.stopHeartbeat()
      if (!this.running) return

      // 4004 is an invalid token and 4014 a missing privileged intent. Neither
      // is fixed by reconnecting, and retrying forever hides the real problem.
      if (event.code === 4004) {
        this.options.onError?.('Discord closed the connection: the bot token is invalid')
        this.running = false
        return
      }
      if (event.code === 4014) {
        this.options.onError?.(
          'Discord closed the connection: the MESSAGE CONTENT intent is not enabled for this bot. ' +
            'Enable it under Bot → Privileged Gateway Intents in the Discord developer portal.',
        )
        this.running = false
        return
      }

      void this.reconnect(onMessage)
    })

    socket.addEventListener('error', () => {
      // The event carries no detail worth reporting; the close that follows
      // does, so the message is left to the close handler.
      this.options.onError?.('the Discord gateway connection errored')
    })

    await new Promise<void>((resolve) => {
      const settle = () => resolve()
      socket.addEventListener('open', settle, { once: true })
      socket.addEventListener('close', settle, { once: true })
    })
  }

  private handlePayload(
    payload: GatewayPayload,
    onMessage: (message: IncomingMessage) => void,
  ): void {
    switch (payload.op) {
      case OP.hello: {
        const interval = (payload.d as { heartbeat_interval?: number } | undefined)
          ?.heartbeat_interval
        this.startHeartbeat(interval ?? 41_250)
        // A resume replays what was missed; an identify starts fresh. Choosing
        // wrong means either a duplicate flood or a silent gap.
        if (this.sessionId && this.sequence !== null) {
          this.sendPayload({
            op: OP.resume,
            d: {
              token: this.options.token,
              session_id: this.sessionId,
              seq: this.sequence,
            },
          })
        } else {
          this.identify()
        }
        return
      }

      case OP.heartbeatAck:
        this.awaitingAck = false
        this.reconnectAttempts = 0
        return

      case OP.heartbeat:
        // The server can ask for one out of band.
        this.sendPayload({ op: OP.heartbeat, d: this.sequence })
        return

      case OP.reconnect:
        this.socket?.close(4000, 'reconnect requested')
        return

      case OP.invalidSession:
        // The session cannot be resumed; forget it so the next connect
        // identifies instead of failing the same way again.
        this.sessionId = undefined
        this.sequence = null
        this.socket?.close(4000, 'invalid session')
        return

      case OP.dispatch:
        this.handleDispatch(payload, onMessage)
    }
  }

  private handleDispatch(
    payload: GatewayPayload,
    onMessage: (message: IncomingMessage) => void,
  ): void {
    if (payload.t === 'READY') {
      const ready = payload.d as {
        session_id?: string
        resume_gateway_url?: string
        user?: { id?: string }
      }
      this.sessionId = ready.session_id
      this.resumeUrl = ready.resume_gateway_url
      this.selfId = ready.user?.id ?? this.selfId
      return
    }

    if (payload.t !== 'MESSAGE_CREATE') return

    const message = payload.d as DiscordMessage

    // Ignoring bots includes ignoring ourselves, which is what stops the
    // adapter replying to its own replies forever.
    if (message.author.bot === true || message.author.id === this.selfId) return

    if (!this.permitted(message)) return

    const mention = this.selfId ? `<@${this.selfId}>` : ''
    const mentioned = mention !== '' && message.content.includes(mention)

    if (this.options.requireMention === true && !mentioned) return

    const text = mention === '' ? message.content : message.content.replaceAll(mention, '').trim()

    const audio = message.attachments?.find((attachment) =>
      attachment.content_type?.startsWith('audio/'),
    )

    onMessage({
      platform: this.platform,
      accountId: message.author.id,
      conversationId: message.channel_id,
      text,
      senderLabel: message.author.username,
      ...(audio ? { audioUrl: audio.url } : {}),
      receivedAt: Date.now(),
    })
  }

  private permitted(message: DiscordMessage): boolean {
    const { allowedAccounts, allowedChannels } = this.options

    // An empty allowlist means nobody, not everybody. A gateway that talks to
    // anyone who finds the bot is a remote shell for strangers.
    if (!allowedAccounts || allowedAccounts.length === 0) return false
    if (!allowedAccounts.includes(message.author.id)) return false

    if (allowedChannels && allowedChannels.length > 0) {
      return allowedChannels.includes(message.channel_id)
    }
    return true
  }

  private identify(): void {
    this.sendPayload({
      op: OP.identify,
      d: {
        token: this.options.token,
        intents: INTENTS.guildMessages | INTENTS.directMessages | INTENTS.messageContent,
        properties: { os: process.platform, browser: 'jean', device: 'jean' },
      },
    })
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat()
    this.awaitingAck = false

    this.heartbeatTimer = setInterval(() => {
      // A heartbeat sent while the previous one is unacknowledged means the
      // connection is a zombie: it looks open and delivers nothing. Discord's
      // documentation is explicit that the fix is to tear it down.
      if (this.awaitingAck) {
        this.options.onError?.('Discord did not acknowledge a heartbeat; reconnecting')
        this.socket?.close(4000, 'heartbeat not acknowledged')
        return
      }
      this.awaitingAck = true
      this.sendPayload({ op: OP.heartbeat, d: this.sequence })
    }, intervalMs)

    // The first heartbeat is jittered, as the documentation asks, so a fleet of
    // reconnecting clients does not beat in lockstep.
    setTimeout(() => {
      if (this.running) this.sendPayload({ op: OP.heartbeat, d: this.sequence })
    }, Math.floor(Math.random() * intervalMs))
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  private async reconnect(onMessage: (message: IncomingMessage) => void): Promise<void> {
    if (!this.running) return

    this.reconnectAttempts += 1
    // Exponential backoff with a ceiling: a gateway that is down stays down for
    // a while, and hammering it is how an application gets rate limited.
    const delay = Math.min(1000 * 2 ** Math.min(this.reconnectAttempts, 6), 60_000)
    const jittered = delay * (0.5 + Math.random() * 0.5)

    await new Promise((resolve) => setTimeout(resolve, jittered))
    await this.connect(onMessage)
  }

  /** Sends a raw gateway frame. */
  private sendPayload(payload: GatewayPayload): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(payload))
  }

  /**
   * Posts a reply.
   *
   * Over the REST API rather than the gateway: the gateway is receive-only for
   * messages, and sending through it is not something Discord supports.
   */
  async send(message: OutgoingMessage): Promise<void> {
    const body = message.monospace === true ? fence(message.text) : message.text

    for (const part of splitMessage(body, MESSAGE_LIMIT)) {
      const response = await fetch(
        `https://discord.com/api/v10/channels/${message.conversationId}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bot ${this.options.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ content: part }),
        },
      )

      if (response.status === 429) {
        // Discord's rate limit is per channel and it tells you how long to
        // wait. Ignoring that and retrying immediately escalates to a ban.
        const retry = (await response.json().catch(() => ({}))) as { retry_after?: number }
        const waitMs = Math.ceil((retry.retry_after ?? 1) * 1000)
        await new Promise((resolve) => setTimeout(resolve, waitMs))

        await fetch(`https://discord.com/api/v10/channels/${message.conversationId}/messages`, {
          method: 'POST',
          headers: {
            authorization: `Bot ${this.options.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ content: part }),
        })
        continue
      }

      if (!response.ok) {
        const detail = await response.text()
        throw new Error(`Discord refused the message: HTTP ${response.status} ${detail.slice(0, 200)}`)
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false
    this.stopHeartbeat()
    this.socket?.close(1000, 'stopping')
    this.socket = undefined
  }
}

/** Wraps text in a code fence, without breaking one already inside it. */
function fence(text: string): string {
  // A body containing a fence would close ours early and leave the rest as
  // prose; a longer fence nests correctly.
  const longest = [...text.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 0)
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}
${text}
${ticks}`
}
