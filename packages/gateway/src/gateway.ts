import { Router } from './router.ts'
import { IdentityStore, type Identity } from './identity.ts'
import { TelegramAdapter } from './adapters/telegram.ts'
import type { PlatformAdapter } from './adapter.ts'

/**
 * The gateway process (architecture §15.1).
 *
 * One process, several platform adapters, one router, one session per identity.
 * Everything that decides *whether* a message becomes an agent turn lives in
 * the router; this assembles the parts and owns their lifecycle.
 */

export interface PlatformConfig {
  telegram?: { token: string; allowedAccounts?: string[] }
}

export interface GatewayOptions {
  identities: IdentityStore
  platforms: PlatformConfig
  run: (identity: Identity, prompt: string) => Promise<string>
  transcribe?: (audioUrl: string) => Promise<string>
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

    if (this.options.platforms.telegram?.token) {
      const adapter = new TelegramAdapter({
        ...this.options.platforms.telegram,
        onError: this.options.onError,
      })

      try {
        await adapter.start((message) => void this.router.handle(message))
        this.router.register(adapter)
        this.adapters.push(adapter)
        started.push('telegram')
      } catch (err) {
        failed.push({
          platform: 'telegram',
          error: err instanceof Error ? err.message : String(err),
        })
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
