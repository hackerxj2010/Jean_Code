import {
  splitMessage,
  type IncomingMessage,
  type OutgoingMessage,
  type PlatformAdapter,
} from '../adapter.ts'

/**
 * Slack (architecture §15).
 *
 * Uses Socket Mode: the app opens an outbound WebSocket to Slack rather than
 * Slack calling in. That matters because the gateway runs on the user's own
 * machine, where there is no public HTTPS endpoint for the Events API to reach,
 * and asking someone to run a tunnel to use their own agent is a bad trade.
 *
 * Socket Mode needs two tokens, which is the thing people get wrong: an
 * app-level token (`xapp-…`) to open the socket, and a bot token (`xoxb-…`) to
 * call the Web API. They are not interchangeable, and using one where the other
 * belongs produces an `invalid_auth` that names neither.
 */

/** Slack truncates a message body past this, silently. */
const MESSAGE_LIMIT = 3000

interface SocketEnvelope {
  type: string
  envelope_id?: string
  payload?: {
    event?: SlackEvent
  }
  /** Present on `disconnect`, naming why. */
  reason?: string
  /** Slack asks the client to acknowledge with this. */
  accepts_response_payload?: boolean
}

interface SlackEvent {
  type: string
  subtype?: string
  user?: string
  bot_id?: string
  channel?: string
  text?: string
  ts?: string
  thread_ts?: string
  files?: { url_private?: string; mimetype?: string }[]
}

export interface SlackOptions {
  /** `xapp-…`, for opening the Socket Mode connection. */
  appToken: string
  /** `xoxb-…`, for the Web API. */
  botToken: string
  /** Only these user ids may talk to the bot. Empty means nobody. */
  allowedAccounts?: string[]
  allowedChannels?: string[]
  /** Reply in a thread under the triggering message rather than in the channel. */
  useThreads?: boolean
  onError?: (message: string) => void
}

export class SlackAdapter implements PlatformAdapter {
  readonly platform = 'slack'

  private readonly options: SlackOptions
  private socket?: WebSocket
  private running = false
  private selfId?: string
  private reconnectAttempts = 0
  /** Message ts by channel, so a reply can thread under what triggered it. */
  private readonly lastTs = new Map<string, string>()

  constructor(options: SlackOptions) {
    this.options = options
  }

  isConfigured(): boolean {
    return Boolean(this.options.appToken) && Boolean(this.options.botToken)
  }

  /**
   * Verifies both tokens.
   *
   * Checked separately, because "it does not work" with two tokens is a much
   * worse message than naming which one Slack rejected.
   */
  async verify(): Promise<{ ok: boolean; team?: string; user?: string; error?: string }> {
    if (!this.options.appToken.startsWith('xapp-')) {
      return { ok: false, error: 'the app-level token should start with `xapp-`' }
    }
    if (!this.options.botToken.startsWith('xoxb-')) {
      return { ok: false, error: 'the bot token should start with `xoxb-`' }
    }

    try {
      const response = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.botToken}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
      })

      const body = (await response.json()) as {
        ok: boolean
        team?: string
        user?: string
        user_id?: string
        error?: string
      }

      if (!body.ok) return { ok: false, error: `the bot token was rejected: ${body.error}` }

      this.selfId = body.user_id
      return { ok: true, team: body.team, user: body.user }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error('Slack needs both an app-level token and a bot token')
    }

    const verified = await this.verify()
    if (!verified.ok) throw new Error(`Slack rejected the configuration: ${verified.error}`)

    this.running = true
    await this.connect(onMessage)
  }

  /** Asks Slack for a one-time WebSocket URL and opens it. */
  private async connect(onMessage: (message: IncomingMessage) => void): Promise<void> {
    if (!this.running) return

    let url: string
    try {
      url = await this.openConnection()
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error.message : String(error))
      await this.reconnect(onMessage)
      return
    }

    const socket = new WebSocket(url)
    this.socket = socket

    socket.addEventListener('message', (event) => {
      let envelope: SocketEnvelope
      try {
        envelope = JSON.parse(String(event.data)) as SocketEnvelope
      } catch {
        this.options.onError?.('Slack sent a payload that is not JSON')
        return
      }

      // Every envelope must be acknowledged, and quickly. Slack retries an
      // unacknowledged event three times, so a slow handler turns one message
      // into four.
      if (envelope.envelope_id !== undefined) {
        socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }))
      }

      this.handleEnvelope(envelope, onMessage)
    })

    socket.addEventListener('close', () => {
      if (!this.running) return
      void this.reconnect(onMessage)
    })

    socket.addEventListener('error', () => {
      this.options.onError?.('the Slack socket errored')
    })

    await new Promise<void>((resolve) => {
      const settle = () => resolve()
      socket.addEventListener('open', settle, { once: true })
      socket.addEventListener('close', settle, { once: true })
    })
  }

  private async openConnection(): Promise<string> {
    const response = await fetch('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.appToken}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
    })

    const body = (await response.json()) as { ok: boolean; url?: string; error?: string }

    if (!body.ok || !body.url) {
      // `not_allowed_token_type` here almost always means the bot token was
      // passed where the app-level token belongs.
      const hint =
        body.error === 'not_allowed_token_type'
          ? ' — this endpoint needs the app-level `xapp-` token, not the bot token'
          : ''
      throw new Error(`Slack would not open a socket: ${body.error ?? 'unknown'}${hint}`)
    }

    return body.url
  }

  private handleEnvelope(
    envelope: SocketEnvelope,
    onMessage: (message: IncomingMessage) => void,
  ): void {
    if (envelope.type === 'hello') {
      this.reconnectAttempts = 0
      return
    }

    if (envelope.type === 'disconnect') {
      // Slack cycles a socket roughly every few hours and warns first. This is
      // routine, not an error, and reporting it as one trains people to ignore
      // the log.
      this.socket?.close(1000, envelope.reason ?? 'slack asked to reconnect')
      return
    }

    const event = envelope.payload?.event
    if (!event || event.type !== 'message') return

    // Message subtypes cover edits, deletions, joins, and channel topic
    // changes. Treating them as new messages makes the agent respond to
    // somebody leaving a channel.
    if (event.subtype !== undefined) return

    // A bot's own message, including this one's replies.
    if (event.bot_id !== undefined || event.user === undefined) return
    if (this.selfId !== undefined && event.user === this.selfId) return

    if (!this.permitted(event)) return

    const channel = event.channel ?? ''
    if (event.ts !== undefined) this.lastTs.set(channel, event.thread_ts ?? event.ts)

    const audio = event.files?.find((file) => file.mimetype?.startsWith('audio/'))

    onMessage({
      platform: this.platform,
      accountId: event.user,
      conversationId: channel,
      text: unescapeSlack(event.text ?? ''),
      senderLabel: event.user,
      ...(audio?.url_private ? { audioUrl: audio.url_private } : {}),
      receivedAt: Date.now(),
    })
  }

  private permitted(event: SlackEvent): boolean {
    const { allowedAccounts, allowedChannels } = this.options

    // An empty allowlist means nobody. Anyone in a Slack workspace can find a
    // bot, and a permissive default hands them a shell on the host.
    if (!allowedAccounts || allowedAccounts.length === 0) return false
    if (event.user === undefined || !allowedAccounts.includes(event.user)) return false

    if (allowedChannels && allowedChannels.length > 0) {
      return event.channel !== undefined && allowedChannels.includes(event.channel)
    }
    return true
  }

  async send(message: OutgoingMessage): Promise<void> {
    const body = message.monospace === true ? fence(message.text) : message.text
    const threadTs = this.options.useThreads === true ? this.lastTs.get(message.conversationId) : undefined

    for (const part of splitMessage(body, MESSAGE_LIMIT)) {
      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.botToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: message.conversationId,
          text: part,
          ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
        }),
      })

      const result = (await response.json()) as { ok: boolean; error?: string }

      if (!result.ok) {
        // `not_in_channel` is the most common one and has an actionable fix,
        // which a bare error code does not convey.
        const hint =
          result.error === 'not_in_channel'
            ? ' — invite the bot to the channel with /invite'
            : result.error === 'channel_not_found'
              ? ' — check the channel id, and that the bot can see it'
              : ''
        throw new Error(`Slack refused the message: ${result.error}${hint}`)
      }
    }
  }

  private async reconnect(onMessage: (message: IncomingMessage) => void): Promise<void> {
    if (!this.running) return

    this.reconnectAttempts += 1
    const delay = Math.min(1000 * 2 ** Math.min(this.reconnectAttempts, 6), 60_000)
    const jittered = delay * (0.5 + Math.random() * 0.5)

    await new Promise((resolve) => setTimeout(resolve, jittered))
    await this.connect(onMessage)
  }

  async stop(): Promise<void> {
    this.running = false
    this.socket?.close(1000, 'stopping')
    this.socket = undefined
  }
}

/**
 * Undoes Slack's message escaping.
 *
 * Slack escapes `&`, `<`, and `>` and wraps links in angle brackets. Left as
 * they are, a prompt containing a comparison arrives as `a &lt; b` and the
 * agent reasons about the wrong text.
 */
export function unescapeSlack(text: string): string {
  return (
    text
      // Mentions first. They also carry a pipe, so the link rule below would
      // otherwise swallow `<#C123|general>` and render it as bare `general`,
      // losing the `#` that says it is a channel.
      .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, '@$1')
      .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, name: string) => `#${name || id}`)
      // Links arrive as `<url|label>` or `<url>`; the label is what a human
      // typed and is what the agent should read.
      .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
      .replace(/<(https?:[^>]+)>/g, '$1')
      // The entities last, so an escaped `&lt;` inside a link is not decoded
      // into a bracket that then looks like markup.
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&')
  )
}

/** Wraps text in a code fence, without breaking one already inside it. */
function fence(text: string): string {
  const longest = [...text.matchAll(/`+/g)].reduce((max, match) => Math.max(max, match[0].length), 0)
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}\n${text}\n${ticks}`
}
