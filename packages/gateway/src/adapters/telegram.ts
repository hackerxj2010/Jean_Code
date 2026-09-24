import { splitMessage, type IncomingMessage, type OutgoingMessage, type PlatformAdapter } from '../adapter.ts'

/**
 * Telegram (architecture §15).
 *
 * The Bot API is plain HTTP, so this is a complete implementation with no
 * dependencies — long polling rather than webhooks, because a webhook needs a
 * public HTTPS endpoint and the point of the gateway is that it runs on the
 * user's own machine.
 */

/** Telegram rejects anything longer. */
const MESSAGE_LIMIT = 4096

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from?: { id: number; username?: string; first_name?: string }
    chat: { id: number }
    text?: string
    voice?: { file_id: string }
    audio?: { file_id: string }
  }
}

export interface TelegramOptions {
  token: string
  /** Only these user ids may talk to the bot. Empty means nobody. */
  allowedAccounts?: string[]
  onError?: (message: string) => void
}

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = 'telegram'

  private readonly options: TelegramOptions
  private offset = 0
  private polling = false
  private controller?: AbortController

  constructor(options: TelegramOptions) {
    this.options = options
  }

  isConfigured(): boolean {
    return Boolean(this.options.token)
  }

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.options.token}/${method}`
  }

  /** Verifies the token and returns the bot's own username. */
  async verify(): Promise<{ ok: boolean; username?: string; error?: string }> {
    try {
      const response = await fetch(this.url('getMe'))
      const body = (await response.json()) as {
        ok: boolean
        result?: { username?: string }
        description?: string
      }
      return body.ok
        ? { ok: true, username: body.result?.username }
        : { ok: false, error: body.description ?? `HTTP ${response.status}` }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    if (!this.isConfigured()) throw new Error('no Telegram bot token configured')

    const verified = await this.verify()
    if (!verified.ok) throw new Error(`Telegram rejected the token: ${verified.error}`)

    this.polling = true
    void this.poll(onMessage)
  }

  private async poll(onMessage: (message: IncomingMessage) => void): Promise<void> {
    while (this.polling) {
      this.controller = new AbortController()

      try {
        // Long polling: the server holds the request open until something
        // arrives, so this is one request per message rather than per second.
        const response = await fetch(this.url('getUpdates'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ offset: this.offset, timeout: 30, allowed_updates: ['message'] }),
          signal: this.controller.signal,
        })

        const body = (await response.json()) as { ok: boolean; result?: TelegramUpdate[] }
        if (!body.ok) {
          await sleep(5000)
          continue
        }

        for (const update of body.result ?? []) {
          // Acknowledged by advancing the offset past it; without this the same
          // update is redelivered forever.
          this.offset = Math.max(this.offset, update.update_id + 1)

          const message = update.message
          if (!message?.from) continue

          const accountId = String(message.from.id)
          if (!this.isAllowed(accountId)) {
            await this.send({
              conversationId: String(message.chat.id),
              text: 'This bot is not configured to accept messages from you.',
            })
            continue
          }

          const audio = message.voice?.file_id ?? message.audio?.file_id
          if (!message.text && !audio) continue

          onMessage({
            platform: this.platform,
            accountId,
            conversationId: String(message.chat.id),
            text: message.text ?? '',
            senderLabel: message.from.username ?? message.from.first_name,
            audioUrl: audio ? await this.fileUrl(audio) : undefined,
            receivedAt: Date.now(),
          })
        }
      } catch (err) {
        if (!this.polling) return // stopped deliberately
        this.options.onError?.(`Telegram polling failed: ${err instanceof Error ? err.message : String(err)}`)
        // Back off rather than spinning: a network outage should not become a
        // request flood against Telegram's API.
        await sleep(5000)
      }
    }
  }

  /**
   * Whether an account may use this bot.
   *
   * Closed by default. A Telegram bot's username is discoverable, so an open
   * bot is an open shell on the user's machine to anyone who finds it.
   */
  private isAllowed(accountId: string): boolean {
    return (this.options.allowedAccounts ?? []).includes(accountId)
  }

  private async fileUrl(fileId: string): Promise<string | undefined> {
    try {
      const response = await fetch(`${this.url('getFile')}?file_id=${encodeURIComponent(fileId)}`)
      const body = (await response.json()) as { ok: boolean; result?: { file_path?: string } }
      if (!body.ok || !body.result?.file_path) return undefined
      return `https://api.telegram.org/file/bot${this.options.token}/${body.result.file_path}`
    } catch {
      return undefined
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    for (const part of splitMessage(message.text, MESSAGE_LIMIT - 16)) {
      const text = message.monospace ? `\`\`\`\n${part}\n\`\`\`` : part

      try {
        const response = await fetch(this.url('sendMessage'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: message.conversationId,
            text,
            parse_mode: message.monospace ? 'Markdown' : undefined,
            disable_web_page_preview: true,
          }),
        })

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { description?: string }
          // A malformed-markdown rejection is recoverable: resend as plain text
          // rather than dropping the reply entirely.
          if (message.monospace) {
            await this.sendPlain(message.conversationId, part)
          } else {
            this.options.onError?.(`Telegram rejected a message: ${body.description ?? response.status}`)
          }
        }
      } catch (err) {
        this.options.onError?.(`Telegram send failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private async sendPlain(chatId: string, text: string): Promise<void> {
    await fetch(this.url('sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    }).catch(() => undefined)
  }

  /** Shows a typing indicator, so a long turn does not look like a hang. */
  async indicateTyping(conversationId: string): Promise<void> {
    await fetch(this.url('sendChatAction'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: conversationId, action: 'typing' }),
    }).catch(() => undefined)
  }

  async stop(): Promise<void> {
    this.polling = false
    this.controller?.abort()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
