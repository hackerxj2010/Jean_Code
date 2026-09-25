/**
 * `@jean/gateway` — the multi-platform gateway (architecture §15).
 *
 * The architecture's diagram makes the adapters look like the work. They are
 * not: the hard part is cross-platform session continuity, because nothing in
 * a Telegram user id tells you which terminal belongs to the same person.
 * `IdentityStore` solves that with an explicit, expiring, single-use link code
 * rather than by inferring identity from names — guessing wrong hands one
 * person's repository to another.
 */

export {
  splitMessage,
  type IncomingMessage,
  type OutgoingMessage,
  type PlatformAdapter,
} from './adapter.ts'

export {
  IdentityStore,
  identityStorePath,
  type Identity,
  type PlatformAccount,
} from './identity.ts'

export { Router, type RouterOptions } from './router.ts'
export { TelegramAdapter, type TelegramOptions } from './adapters/telegram.ts'
export { DiscordAdapter, type DiscordOptions } from './adapters/discord.ts'
export { SlackAdapter, unescapeSlack, type SlackOptions } from './adapters/slack.ts'
export {
  decodeHeader,
  EmailAdapter,
  encodeHeader,
  extractAddress,
  parseMessage,
  replySubject,
  stripQuotedReply,
  type EmailOptions,
} from './adapters/email.ts'
export { MatrixAdapter, type MatrixOptions } from './adapters/matrix.ts'
export { SignalAdapter, type SignalOptions } from './adapters/signal.ts'
export { SmsAdapter, twilioSignature, type SmsOptions } from './adapters/sms.ts'
export { verifyMetaSignature, WhatsAppAdapter, type WhatsAppOptions } from './adapters/whatsapp.ts'
export { listen as listenWebhook, type WebhookRequest, type WebhookResponse } from './adapters/webhook.ts'
export {
  createAdapter,
  Gateway,
  PLATFORMS,
  type GatewayOptions,
  type PlatformConfig,
  type PlatformName,
} from './gateway.ts'
