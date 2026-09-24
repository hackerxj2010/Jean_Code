import type { IncomingMessage, PlatformAdapter } from './adapter.ts'
import type { Identity, IdentityStore } from './identity.ts'

/**
 * The message router (architecture §15.1).
 *
 * Turns a platform message into an agent turn, and enforces the two rules that
 * make a remote agent safe to run at all: an unlinked account gets no agent,
 * and one identity runs one turn at a time.
 */

export interface RouterOptions {
  identities: IdentityStore
  /** Runs a turn for an identity and returns the reply. */
  run: (identity: Identity, prompt: string) => Promise<string>
  /** Transcribes a voice note, when the platform sent one. */
  transcribe?: (audioUrl: string) => Promise<string>
  onError?: (message: string) => void
}

interface Conversation {
  identityId: string
  /** In-flight turn, so a second message queues rather than interleaving. */
  running?: Promise<void>
  /** Messages that arrived while a turn was running. */
  queued: string[]
}

export class Router {
  private readonly options: RouterOptions
  private readonly adapters = new Map<string, PlatformAdapter>()
  private readonly conversations = new Map<string, Conversation>()

  constructor(options: RouterOptions) {
    this.options = options
  }

  register(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter)
  }

  /** Handles one inbound message. */
  async handle(message: IncomingMessage): Promise<void> {
    const adapter = this.adapters.get(message.platform)
    if (!adapter) return

    let text = message.text.trim()

    // A voice note is transcribed before anything else looks at it.
    if (!text && message.audioUrl && this.options.transcribe) {
      try {
        text = (await this.options.transcribe(message.audioUrl)).trim()
        if (text) {
          await adapter.send({
            conversationId: message.conversationId,
            text: `Heard: "${text}"`,
          })
        }
      } catch (err) {
        await adapter.send({
          conversationId: message.conversationId,
          text: `I could not transcribe that: ${err instanceof Error ? err.message : String(err)}`,
        })
        return
      }
    }

    if (!text) return

    const identity = this.options.identities.resolve(message.platform, message.accountId)

    // An unlinked account cannot reach the agent at all. The only thing it can
    // do is redeem a code the user generated on a machine they already control.
    if (!identity) {
      await this.handleUnlinked(adapter, message, text)
      return
    }

    if (text.startsWith('/')) {
      const handled = await this.handleCommand(adapter, message, identity, text)
      if (handled) return
    }

    this.options.identities.touch(identity.id)
    await this.enqueue(adapter, message, identity, text)
  }

  private async handleUnlinked(
    adapter: PlatformAdapter,
    message: IncomingMessage,
    text: string,
  ): Promise<void> {
    const code = /^\/?(?:link\s+)?(\d{6})$/.exec(text.trim())

    if (code) {
      const identity = this.options.identities.redeemLinkCode(
        code[1]!,
        message.platform,
        message.accountId,
        message.senderLabel,
      )

      await adapter.send({
        conversationId: message.conversationId,
        text: identity
          ? `Linked. This account now shares the session running in ${identity.cwd}. Send a message to continue where you left off.`
          : 'That code is not valid, or it has expired. Generate a new one with `jean gateway link` and try again — codes last ten minutes and work once.',
      })
      return
    }

    await adapter.send({
      conversationId: message.conversationId,
      text: [
        'This account is not linked to a Jean Code session.',
        '',
        'On the machine you want to control, run `jean gateway link`. It prints a',
        'six-digit code — send that code here to connect. The code expires in ten',
        'minutes and works once.',
      ].join('\n'),
    })
  }

  /** Handles gateway commands. Returns true when the message was one. */
  private async handleCommand(
    adapter: PlatformAdapter,
    message: IncomingMessage,
    identity: Identity,
    text: string,
  ): Promise<boolean> {
    const [command] = text.slice(1).split(/\s+/)

    switch (command?.toLowerCase()) {
      case 'start':
      case 'help':
        await adapter.send({
          conversationId: message.conversationId,
          text: [
            'Jean Code, reachable from here.',
            '',
            'Send anything and it runs as an agent turn in the linked session.',
            '',
            '/status  — which session and directory this is attached to',
            '/unlink  — disconnect this account',
            '/cancel  — interrupt the running turn',
          ].join('\n'),
        })
        return true

      case 'status':
        await adapter.send({
          conversationId: message.conversationId,
          text: [
            `Directory: ${identity.cwd ?? 'not set'}`,
            `Session: ${identity.sessionId ?? 'none yet'}`,
            `Linked accounts: ${identity.accounts.map((a) => `${a.platform}${a.label ? ` (${a.label})` : ''}`).join(', ') || 'none'}`,
            this.conversations.get(identity.id)?.running ? 'A turn is running.' : 'Idle.',
          ].join('\n'),
        })
        return true

      case 'unlink':
        this.options.identities.unlink(message.platform, message.accountId)
        await adapter.send({
          conversationId: message.conversationId,
          text: 'Unlinked. This account can no longer reach the session.',
        })
        return true

      case 'cancel': {
        const conversation = this.conversations.get(identity.id)
        const dropped = conversation?.queued.length ?? 0
        if (conversation) conversation.queued = []
        await adapter.send({
          conversationId: message.conversationId,
          text: dropped > 0 ? `Dropped ${dropped} queued message(s).` : 'Nothing queued.',
        })
        return true
      }

      default:
        // Anything else starting with `/` is a Jean slash command, which the
        // session itself handles — passing it through is correct.
        return false
    }
  }

  /**
   * Runs a turn, queueing behind any turn already in flight for this identity.
   *
   * Serialization is not a nicety: two turns sharing one working directory
   * would interleave file edits, and the result depends on scheduling.
   */
  private async enqueue(
    adapter: PlatformAdapter,
    message: IncomingMessage,
    identity: Identity,
    text: string,
  ): Promise<void> {
    let conversation = this.conversations.get(identity.id)
    if (!conversation) {
      conversation = { identityId: identity.id, queued: [] }
      this.conversations.set(identity.id, conversation)
    }

    if (conversation.running) {
      conversation.queued.push(text)
      await adapter.send({
        conversationId: message.conversationId,
        text: `Queued — a turn is already running (${conversation.queued.length} waiting).`,
      })
      return
    }

    conversation.running = this.drain(adapter, message, identity, conversation, text).finally(() => {
      conversation.running = undefined
    })

    await conversation.running
  }

  private async drain(
    adapter: PlatformAdapter,
    message: IncomingMessage,
    identity: Identity,
    conversation: Conversation,
    first: string,
  ): Promise<void> {
    let prompt: string | undefined = first

    while (prompt !== undefined) {
      const typing = (adapter as { indicateTyping?: (id: string) => Promise<void> }).indicateTyping
      // Repeated while the turn runs: platforms expire the indicator quickly,
      // and a silent five-minute turn reads as a crash.
      const ticker = typing
        ? setInterval(() => void typing.call(adapter, message.conversationId), 5000)
        : undefined
      void typing?.call(adapter, message.conversationId)

      try {
        const reply = await this.options.run(identity, prompt)
        await adapter.send({
          conversationId: message.conversationId,
          text: reply.trim() || '(the turn produced no output)',
        })
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        this.options.onError?.(detail)
        await adapter.send({
          conversationId: message.conversationId,
          text: `The turn failed: ${detail}`,
        })
      } finally {
        if (ticker) clearInterval(ticker)
      }

      prompt = conversation.queued.shift()
    }
  }

  /** Whether a turn is running for an identity. */
  isBusy(identityId: string): boolean {
    return Boolean(this.conversations.get(identityId)?.running)
  }

  registered(): string[] {
    return [...this.adapters.keys()].sort()
  }
}
