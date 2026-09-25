import { createHmac, timingSafeEqual } from 'node:crypto'
import { splitMessage, type IncomingMessage, type OutgoingMessage, type PlatformAdapter } from '../adapter.ts'
import { listen, type WebhookRequest, type WebhookResponse } from './webhook.ts'

/**
 * WhatsApp, through Meta's Cloud API.
 *
 * Messages arrive as webhook POSTs from Meta and replies go out through the
 * Graph API. The webhook URL is public, so every POST is checked against its
 * `X-Hub-Signature-256` — an HMAC of the body under the app secret — before
 * anything in it is believed; a request that fails is dropped unanswered.
 * Registering the URL is Meta's GET handshake, answered with the challenge
 * only when the verify token matches.
 *
 * Closed by default, like every adapter: only the listed phone numbers
 * (`wa_id`, digits only) reach the agent, and they still need a link code.
 */

const MESSAGE_LIMIT = 4096

export interface WhatsAppOptions {
  /** The business phone number's id, from the app's WhatsApp settings. */
  phoneNumberId: string
  /** A system-user or temporary access token. */
  accessToken: string
  /** The app secret, which signs every webhook request. */
  appSecret: string
  /** The token entered in Meta's webhook settings, echoed at registration. */
  verifyToken: string
  /** Where the webhook listens. Default 8787, path `/whatsapp`. */
  port?: number
  path?: string
  /** Phone numbers (digits only, with country code) that may use the agent. */
  allowedAccounts?: string[]
  /** The Graph API root; tests point it at a local server. */
  graphUrl?: string
  onError?: (message: string) => void
}

interface Change {
  value?: {
    messages?: { from: string; id: string; type: string; text?: { body?: string } }[]
    contacts?: { wa_id: string; profile?: { name?: string } }[]
  }
}

/** Whether `header` is the app secret's signature of `body`. */
export function verifyMetaSignature(body: string, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false
  const expected = Buffer.from(createHmac('sha256', secret).update(body, 'utf8').digest('hex'))
  const given = Buffer.from(header.slice(7))
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export class WhatsAppAdapter implements PlatformAdapter {
  readonly platform = 'whatsapp'
  private stopServer?: () => Promise<void>
  /** The port actually bound — the configured one, or a free one for 0. */
  boundPort?: number

  constructor(private readonly options: WhatsAppOptions) {}

  isConfigured(): boolean {
    const o = this.options
    return Boolean(o.phoneNumberId && o.accessToken && o.appSecret && o.verifyToken)
  }

  private get graph(): string {
    return (this.options.graphUrl ?? 'https://graph.facebook.com/v21.0').replace(/\/+$/, '')
  }

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    if (!this.isConfigured()) throw new Error('WhatsApp needs phoneNumberId, accessToken, appSecret, and verifyToken')
    const served = await listen(this.options.port ?? 8787, this.options.path ?? '/whatsapp', (request) => this.handle(request, onMessage))
    this.boundPort = served.port
    this.stopServer = served.stop
  }

  private handle(request: WebhookRequest, onMessage: (message: IncomingMessage) => void): WebhookResponse {
    if (request.method === 'GET') {
      const query = new URLSearchParams(request.url.split('?')[1] ?? '')
      const ok = query.get('hub.mode') === 'subscribe' && query.get('hub.verify_token') === this.options.verifyToken
      return ok ? { status: 200, body: query.get('hub.challenge') ?? '' } : { status: 403 }
    }
    if (request.method !== 'POST') return { status: 405 }
    if (!verifyMetaSignature(request.body, request.headers['x-hub-signature-256'], this.options.appSecret)) {
      this.options.onError?.('WhatsApp: dropped a webhook request with a bad signature')
      return { status: 401 }
    }
    let payload: { entry?: { changes?: Change[] }[] }
    try {
      payload = JSON.parse(request.body)
    } catch {
      return { status: 400 }
    }
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const names = new Map((change.value?.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]))
        for (const message of change.value?.messages ?? []) {
          if (!(this.options.allowedAccounts ?? []).includes(message.from)) {
            void this.send({ conversationId: message.from, text: 'This number is not configured to use this agent.' })
            continue
          }
          const text = message.type === 'text' ? (message.text?.body ?? '') : ''
          if (!text) {
            void this.send({ conversationId: message.from, text: 'Only text messages are understood here.' })
            continue
          }
          onMessage({
            platform: this.platform,
            accountId: message.from,
            conversationId: message.from,
            text,
            senderLabel: names.get(message.from),
            receivedAt: Date.now(),
          })
        }
      }
    }
    // Acknowledged at once: Meta retries anything slower than a few seconds,
    // and the agent's turn takes longer than that.
    return { status: 200, body: 'ok' }
  }

  async send(message: OutgoingMessage): Promise<void> {
    for (const part of splitMessage(message.text, MESSAGE_LIMIT - 8)) {
      const body = message.monospace ? `\`\`\`${part}\`\`\`` : part
      try {
        const response = await fetch(`${this.graph}/${this.options.phoneNumberId}/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.options.accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: message.conversationId, type: 'text', text: { body, preview_url: false } }),
        })
        if (!response.ok) {
          const error = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
          this.options.onError?.(`WhatsApp rejected a message: ${error.error?.message ?? response.status}`)
        }
      } catch (err) {
        this.options.onError?.(`WhatsApp send failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  async stop(): Promise<void> {
    await this.stopServer?.()
    this.stopServer = undefined
  }
}
