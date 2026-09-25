import { createHmac, timingSafeEqual } from 'node:crypto'
import { splitMessage, type IncomingMessage, type OutgoingMessage, type PlatformAdapter } from '../adapter.ts'
import { listen, type WebhookRequest, type WebhookResponse } from './webhook.ts'

/**
 * SMS, through Twilio.
 *
 * Twilio POSTs each incoming text to the number's webhook and replies go out
 * through its REST API. A sender's number in a webhook is only as good as the
 * request's `X-Twilio-Signature` — an HMAC over the exact URL Twilio called
 * and the sorted form fields, under the account's auth token — so a request
 * that does not verify is refused before its `From` is read.
 *
 * The URL Twilio signs is the public one (a tunnel's, usually), not the one
 * this process sees; give it as `publicUrl`, or it is rebuilt from the
 * `Host` and `X-Forwarded-Proto` headers the tunnel passes along.
 */

/** Twilio joins longer bodies into one message up to 1600 characters. */
const MESSAGE_LIMIT = 1600

export interface SmsOptions {
  accountSid: string
  authToken: string
  /** The Twilio number replies are sent from, in E.164 (`+15551234567`). */
  fromNumber: string
  /** Where the webhook listens. Default 8787, path `/sms`. */
  port?: number
  path?: string
  /** The public URL configured in Twilio, for checking signatures. */
  publicUrl?: string
  /** Numbers, in E.164, that may use the agent. */
  allowedAccounts?: string[]
  /** Twilio's API root; tests point it at a local server. */
  apiUrl?: string
  onError?: (message: string) => void
}

/** Twilio's request signature for `url` and the POSTed `params`. */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join('')
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64')
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'

export class SmsAdapter implements PlatformAdapter {
  readonly platform = 'sms'
  private stopServer?: () => Promise<void>
  boundPort?: number

  constructor(private readonly options: SmsOptions) {}

  isConfigured(): boolean {
    return Boolean(this.options.accountSid && this.options.authToken && this.options.fromNumber)
  }

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    if (!this.isConfigured()) throw new Error('SMS needs a Twilio accountSid, authToken, and fromNumber')
    const served = await listen(this.options.port ?? 8787, this.options.path ?? '/sms', (request) => this.handle(request, onMessage))
    this.boundPort = served.port
    this.stopServer = served.stop
  }

  private handle(request: WebhookRequest, onMessage: (message: IncomingMessage) => void): WebhookResponse {
    if (request.method !== 'POST') return { status: 405 }
    const params = Object.fromEntries(new URLSearchParams(request.body))
    const proto = request.headers['x-forwarded-proto']?.split(',')[0]?.trim() ?? 'https'
    const url = this.options.publicUrl ?? `${proto}://${request.headers.host ?? 'localhost'}${request.url}`
    const expected = Buffer.from(twilioSignature(this.options.authToken, url, params))
    const given = Buffer.from(request.headers['x-twilio-signature'] ?? '')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      this.options.onError?.('SMS: refused a webhook request whose Twilio signature did not verify')
      return { status: 403 }
    }
    const from = params.From ?? ''
    const text = (params.Body ?? '').trim()
    if (from && text) {
      if ((this.options.allowedAccounts ?? []).includes(from)) {
        onMessage({ platform: this.platform, accountId: from, conversationId: from, text, receivedAt: Date.now() })
      } else {
        void this.send({ conversationId: from, text: 'This number is not configured to use this agent.' })
      }
    }
    // An empty TwiML answer: the reply goes out separately, when the turn ends.
    return { status: 200, body: EMPTY_TWIML, contentType: 'text/xml' }
  }

  async send(message: OutgoingMessage): Promise<void> {
    const api = (this.options.apiUrl ?? 'https://api.twilio.com').replace(/\/+$/, '')
    const auth = Buffer.from(`${this.options.accountSid}:${this.options.authToken}`).toString('base64')
    for (const part of splitMessage(message.text, MESSAGE_LIMIT - 40)) {
      try {
        const response = await fetch(`${api}/2010-04-01/Accounts/${this.options.accountSid}/Messages.json`, {
          method: 'POST',
          headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: message.conversationId, From: this.options.fromNumber, Body: part }).toString(),
        })
        if (!response.ok) {
          const error = (await response.json().catch(() => ({}))) as { message?: string }
          this.options.onError?.(`Twilio rejected a message: ${error.message ?? response.status}`)
        }
      } catch (err) {
        this.options.onError?.(`SMS send failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  async stop(): Promise<void> {
    await this.stopServer?.()
    this.stopServer = undefined
  }
}
