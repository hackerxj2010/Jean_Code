import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  IdentityStore,
  Router,
  splitMessage,
  type Identity,
  type IncomingMessage,
  type OutgoingMessage,
  type PlatformAdapter,
} from '../packages/gateway/src/index.ts'

const temps: string[] = []

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jean-gw-'))
  temps.push(dir)
  return join(dir, 'identities.json')
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true })
})

/** Records what would be sent, so the router can be driven without a network. */
class FakeAdapter implements PlatformAdapter {
  readonly platform = 'test'
  readonly sent: OutgoingMessage[] = []
  private handler?: (message: IncomingMessage) => void

  isConfigured(): boolean {
    return true
  }

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    this.handler = onMessage
  }

  async send(message: OutgoingMessage): Promise<void> {
    this.sent.push(message)
  }

  async stop(): Promise<void> {
    this.handler = undefined
  }

  lastText(): string {
    return this.sent[this.sent.length - 1]?.text ?? ''
  }
}

function message(text: string, accountId = 'user-1'): IncomingMessage {
  return {
    platform: 'test',
    accountId,
    conversationId: 'chat-1',
    text,
    senderLabel: 'tester',
    receivedAt: Date.now(),
  }
}

describe('identity linking', () => {
  test('an unknown account resolves to nothing', () => {
    const store = new IdentityStore(storePath())
    expect(store.resolve('telegram', '12345')).toBeUndefined()
  })

  test('a code binds an account to the identity that issued it', () => {
    const store = new IdentityStore(storePath())
    const identity = store.create('/projects/app')

    const code = store.issueLinkCode(identity.id)
    expect(code).toMatch(/^\d{6}$/)

    const linked = store.redeemLinkCode(code, 'telegram', '12345', 'tester')
    expect(linked?.id).toBe(identity.id)
    expect(store.resolve('telegram', '12345')?.cwd).toBe('/projects/app')
  })

  test('a code works exactly once', () => {
    const store = new IdentityStore(storePath())
    const identity = store.create('/projects/app')
    const code = store.issueLinkCode(identity.id)

    expect(store.redeemLinkCode(code, 'telegram', '111')).toBeDefined()
    // Six digits is a small space; a code surviving reuse is brute-forceable.
    expect(store.redeemLinkCode(code, 'telegram', '222')).toBeUndefined()
  })

  test('a wrong code is consumed too, so guesses cost attempts', () => {
    const store = new IdentityStore(storePath())
    const identity = store.create('/projects/app')
    store.issueLinkCode(identity.id)

    expect(store.redeemLinkCode('000000', 'telegram', '999')).toBeUndefined()
    expect(store.resolve('telegram', '999')).toBeUndefined()
  })

  test('re-linking the same account does not duplicate it', () => {
    const store = new IdentityStore(storePath())
    const identity = store.create('/projects/app')

    store.redeemLinkCode(store.issueLinkCode(identity.id), 'telegram', '12345')
    store.redeemLinkCode(store.issueLinkCode(identity.id), 'telegram', '12345')

    expect(store.get(identity.id)!.accounts).toHaveLength(1)
  })

  test('linking an account elsewhere moves it rather than sharing it', () => {
    const store = new IdentityStore(storePath())
    const first = store.create('/projects/a')
    const second = store.create('/projects/b')

    store.redeemLinkCode(store.issueLinkCode(first.id), 'telegram', '12345')
    store.redeemLinkCode(store.issueLinkCode(second.id), 'telegram', '12345')

    // One account must not reach two repositories.
    expect(store.resolve('telegram', '12345')?.id).toBe(second.id)
    expect(store.get(first.id)!.accounts).toHaveLength(0)
  })

  test('unlink revokes access', () => {
    const store = new IdentityStore(storePath())
    const identity = store.create('/projects/app')
    store.redeemLinkCode(store.issueLinkCode(identity.id), 'telegram', '12345')

    expect(store.unlink('telegram', '12345')).toBe(true)
    expect(store.resolve('telegram', '12345')).toBeUndefined()
  })

  test('links survive a restart', () => {
    const path = storePath()
    const first = new IdentityStore(path)
    const identity = first.create('/projects/app')
    first.redeemLinkCode(first.issueLinkCode(identity.id), 'telegram', '12345')

    // The whole point of the gateway is that it outlives one process.
    const reloaded = new IdentityStore(path)
    expect(reloaded.resolve('telegram', '12345')?.cwd).toBe('/projects/app')
  })

  test('attaching a session records it', () => {
    const store = new IdentityStore(storePath())
    const identity = store.create('/projects/app')
    store.attachSession(identity.id, 'session-abc', '/projects/app')
    expect(store.get(identity.id)!.sessionId).toBe('session-abc')
  })
})

describe('the router', () => {
  function setup(run: (identity: Identity, prompt: string) => Promise<string>) {
    const store = new IdentityStore(storePath())
    const adapter = new FakeAdapter()
    const router = new Router({ identities: store, run })
    router.register(adapter)
    return { store, adapter, router }
  }

  test('an unlinked account is refused and told how to link', async () => {
    const { adapter, router } = setup(async () => 'should not run')
    await router.handle(message('do something dangerous'))

    // An unlinked account must not reach the agent at all.
    expect(adapter.lastText()).toContain('not linked')
    expect(adapter.lastText()).toContain('jean gateway link')
  })

  test('an unlinked account can redeem a code and nothing else', async () => {
    const { store, adapter, router } = setup(async () => 'ran')
    const identity = store.create('/projects/app')
    const code = store.issueLinkCode(identity.id)

    await router.handle(message(code))
    expect(adapter.lastText()).toContain('Linked')
    expect(store.resolve('test', 'user-1')?.id).toBe(identity.id)
  })

  test('a bad code is reported without linking anything', async () => {
    const { store, adapter, router } = setup(async () => 'ran')
    await router.handle(message('000000'))

    expect(adapter.lastText()).toContain('not valid')
    expect(store.resolve('test', 'user-1')).toBeUndefined()
  })

  test('a linked account runs a turn', async () => {
    const prompts: string[] = []
    const { store, adapter, router } = setup(async (_identity, prompt) => {
      prompts.push(prompt)
      return `handled: ${prompt}`
    })

    const identity = store.create('/projects/app')
    store.redeemLinkCode(store.issueLinkCode(identity.id), 'test', 'user-1')

    await router.handle(message('fix the failing test'))
    expect(prompts).toEqual(['fix the failing test'])
    expect(adapter.lastText()).toContain('handled: fix the failing test')
  })

  test('turns for one identity run one at a time', async () => {
    let active = 0
    let maxActive = 0

    const { store, router } = setup(async (_identity, prompt) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 50))
      active--
      return prompt
    })

    const identity = store.create('/projects/app')
    store.redeemLinkCode(store.issueLinkCode(identity.id), 'test', 'user-1')

    // Two turns sharing one working directory would interleave file edits and
    // produce a result that depends on scheduling.
    await Promise.all([
      router.handle(message('first')),
      router.handle(message('second')),
      router.handle(message('third')),
    ])

    expect(maxActive).toBe(1)
  })

  test('queued messages run after the one in flight', async () => {
    const seen: string[] = []
    const { store, router } = setup(async (_identity, prompt) => {
      await new Promise((r) => setTimeout(r, 30))
      seen.push(prompt)
      return prompt
    })

    const identity = store.create('/projects/app')
    store.redeemLinkCode(store.issueLinkCode(identity.id), 'test', 'user-1')

    await Promise.all([router.handle(message('one')), router.handle(message('two'))])
    expect(seen).toEqual(['one', 'two'])
  })

  test('a failing turn is reported rather than silently dropped', async () => {
    const { store, adapter, router } = setup(async () => {
      throw new Error('the model refused')
    })

    const identity = store.create('/projects/app')
    store.redeemLinkCode(store.issueLinkCode(identity.id), 'test', 'user-1')

    await router.handle(message('go'))
    expect(adapter.lastText()).toContain('the model refused')
  })

  test('/status reports the attached session', async () => {
    const { store, adapter, router } = setup(async () => 'x')
    const identity = store.create('/projects/app')
    store.redeemLinkCode(store.issueLinkCode(identity.id), 'test', 'user-1')
    store.attachSession(identity.id, 'session-xyz', '/projects/app')

    await router.handle(message('/status'))
    expect(adapter.lastText()).toContain('/projects/app')
    expect(adapter.lastText()).toContain('session-xyz')
  })

  test('/unlink revokes the account', async () => {
    const { store, router } = setup(async () => 'x')
    const identity = store.create('/projects/app')
    store.redeemLinkCode(store.issueLinkCode(identity.id), 'test', 'user-1')

    await router.handle(message('/unlink'))
    expect(store.resolve('test', 'user-1')).toBeUndefined()
  })

  test('an unrecognized slash command passes through to the agent', async () => {
    const prompts: string[] = []
    const { store, router } = setup(async (_identity, prompt) => {
      prompts.push(prompt)
      return 'ok'
    })

    const identity = store.create('/projects/app')
    store.redeemLinkCode(store.issueLinkCode(identity.id), 'test', 'user-1')

    // `/model` is a Jean slash command, and the session handles it.
    await router.handle(message('/model'))
    expect(prompts).toEqual(['/model'])
  })

  test('a voice note is transcribed before it becomes a prompt', async () => {
    const prompts: string[] = []
    const store = new IdentityStore(storePath())
    const adapter = new FakeAdapter()
    const router = new Router({
      identities: store,
      run: async (_identity, prompt) => {
        prompts.push(prompt)
        return 'done'
      },
      transcribe: async () => 'refactor the auth module',
    })
    router.register(adapter)

    const identity = store.create('/projects/app')
    store.redeemLinkCode(store.issueLinkCode(identity.id), 'test', 'user-1')

    await router.handle({ ...message(''), audioUrl: 'https://example.com/voice.ogg' })
    expect(prompts).toEqual(['refactor the auth module'])
    // The transcript is echoed so the user can catch a mishearing.
    expect(adapter.sent.some((m) => m.text.includes('Heard:'))).toBe(true)
  })

  test('an empty message does nothing', async () => {
    let ran = false
    const { store, router } = setup(async () => {
      ran = true
      return 'x'
    })
    const identity = store.create('/projects/app')
    store.redeemLinkCode(store.issueLinkCode(identity.id), 'test', 'user-1')

    await router.handle(message('   '))
    expect(ran).toBe(false)
  })
})

describe('message splitting', () => {
  test('leaves a short message alone', () => {
    expect(splitMessage('short', 100)).toEqual(['short'])
  })

  test('splits on paragraph boundaries', () => {
    const parts = splitMessage('a'.repeat(40) + '\n\n' + 'b'.repeat(40), 50)
    expect(parts).toHaveLength(2)
    // A reply cut mid-block renders as broken markup on every platform.
    expect(parts[0]).toBe('a'.repeat(40))
  })

  test('falls back to lines, then to a hard cut', () => {
    for (const part of splitMessage('x'.repeat(500), 100)) {
      expect(part.length).toBeLessThanOrEqual(100)
    }
  })

  test('every part fits the limit', () => {
    const text = Array.from({ length: 50 }, (_, i) => `paragraph ${i} `.repeat(10)).join('\n\n')
    for (const part of splitMessage(text, 200)) {
      expect(part.length).toBeLessThanOrEqual(200)
    }
  })
})
