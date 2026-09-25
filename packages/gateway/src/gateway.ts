import { Router } from './router.ts'
import { IdentityStore, type Identity } from './identity.ts'
import { DiscordAdapter, type DiscordOptions } from './adapters/discord.ts'
import { EmailAdapter, type EmailOptions } from './adapters/email.ts'
import { MatrixAdapter, type MatrixOptions } from './adapters/matrix.ts'
import { SignalAdapter, type SignalOptions } from './adapters/signal.ts'
import { SlackAdapter, type SlackOptions } from './adapters/slack.ts'
import { SmsAdapter, type SmsOptions } from './adapters/sms.ts'
import { TelegramAdapter, type TelegramOptions } from './adapters/telegram.ts'
import { WhatsAppAdapter, type WhatsAppOptions } from './adapters/whatsapp.ts'
import type { PlatformAdapter } from './adapter.ts'

/**
 * The gateway process (architecture §15.1).
 *
 * One process, several platform adapters, one router, one session per identity.
 * Everything that decides *whether* a message becomes an agent turn lives in
 * the router; this assembles the parts and owns their lifecycle.
 */

type Without<T> = Omit<T, 'onError'>

/** Each platform's settings, as the `gateway` config section holds them. */
export interface PlatformConfig {
  telegram?: Without<TelegramOptions>
  discord?: Without<DiscordOptions>
  slack?: Without<SlackOptions>
  email?: Without<EmailOptions>
  matrix?: Without<MatrixOptions>
  signal?: Without<SignalOptions>
  whatsapp?: Without<WhatsAppOptions>
  sms?: Without<SmsOptions>
}

export const PLATFORMS = ['telegram', 'discord', 'slack', 'email', 'matrix', 'signal', 'whatsapp', 'sms'] as const
export type PlatformName = (typeof PLATFORMS)[number]

/** The adapter for one platform's settings. */
export function createAdapter(name: PlatformName, settings: unknown, onError?: (message: string) => void): PlatformAdapter {
  const options = { ...(settings as object), onError }
  switch (name) {
    case 'telegram':
      return new TelegramAdapter(options as TelegramOptions)
    case 'discord':
      return new DiscordAdapter(options as DiscordOptions)
    case 'slack':
      return new SlackAdapter(options as SlackOptions)
    case 'email':
      return new EmailAdapter(options as EmailOptions)
    case 'matrix':
      return new MatrixAdapter(options as MatrixOptions)
    case 'signal':
      return new SignalAdapter(options as SignalOptions)
    case 'whatsapp':
      return new WhatsAppAdapter(options as WhatsAppOptions)
    case 'sms':
      return new SmsAdapter(options as SmsOptions)
  }
}

export interface GatewayOptions {
  identities: IdentityStore
  platforms: PlatformConfig
  run: (identity: Identity, prompt: string) => Promise<string>
  transcribe?: (audioUrl: string) => Promise<string>
  /** Adapters built elsewhere, started alongside the configured ones. */
  adapters?: PlatformAdapter[]
  onLog?: (message: string) => void
  onError?: (message: string) => void
}

export class Gateway {
  private readonly options: GatewayOptions
  private readonly router: Router
  private readonly adapters: PlatformAdapter[] = []
  private running = false

  constructor(options: GatewayOptions) {
    this.options = options
    this.router = new Router({
      identities: options.identities,
      run: options.run,
      transcribe: options.transcribe,
      onError: options.onError,
    })
  }

  /**
   * Starts every configured platform.
   *
   * One platform failing to start does not stop the others: a bad Telegram
   * token should not take Slack down with it.
   */
  async start(): Promise<{ started: string[]; failed: { platform: string; error: string }[] }> {
    const started: string[] = []
    const failed: { platform: string; error: string }[] = []
    const candidates: PlatformAdapter[] = [...(this.options.adapters ?? [])]
    for (const name of PLATFORMS) {
      const settings = this.options.platforms[name]
      if (settings) candidates.push(createAdapter(name, settings, this.options.onError))
    }

    for (const adapter of candidates) {
      if (!adapter.isConfigured()) {
        failed.push({ platform: adapter.platform, error: 'missing credentials' })
        continue
      }
      try {
        await adapter.start((message) => void this.router.handle(message))
        this.router.register(adapter)
        this.adapters.push(adapter)
        started.push(adapter.platform)
        this.options.onLog?.(`${adapter.platform} connected`)
      } catch (err) {
        failed.push({ platform: adapter.platform, error: err instanceof Error ? err.message : String(err) })
      }
    }

    this.running = started.length > 0
    return { started, failed }
  }

  async stop(): Promise<void> {
    this.running = false
    await Promise.all(this.adapters.map((adapter) => adapter.stop().catch(() => undefined)))
    this.adapters.length = 0
  }

  get isRunning(): boolean {
    return this.running
  }

  platforms(): string[] {
    return this.router.registered()
  }
}
