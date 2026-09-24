import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Cross-platform session identity (architecture §15.2).
 *
 * The gateway's diagram makes the adapters look like the work; they are not.
 * The hard part is this: "start on Telegram, pick it up in your terminal" only
 * means anything if both surfaces resolve to the *same session*, and nothing in
 * a Telegram user id tells you which terminal belongs to the same human.
 *
 * The design here is deliberately conservative. A platform account is bound to
 * a local identity only by an explicit, expiring, single-use code that the user
 * types on both sides. There is no inference from usernames or email addresses,
 * because guessing wrong hands one person's session — and their repository — to
 * another.
 */

export interface PlatformAccount {
  platform: string
  /** The platform's own user id. Never a display name: those are not unique. */
  accountId: string
  /** For display only. */
  label?: string
  linkedAt: number
}

export interface Identity {
  id: string
  /** Every platform account bound to this identity. */
  accounts: PlatformAccount[]
  /** The agent session this identity is currently attached to. */
  sessionId?: string
  /** Working directory the session runs in. */
  cwd?: string
  createdAt: number
  lastSeenAt: number
}

interface PendingLink {
  code: string
  identityId: string
  expiresAt: number
}

/** Codes are short-lived: a link code is a bearer credential for a session. */
const LINK_TTL_MS = 10 * 60 * 1000

export class IdentityStore {
  private readonly path: string
  private identities = new Map<string, Identity>()
  /** Index from `platform:accountId` to identity id. */
  private readonly index = new Map<string, string>()
  private pending = new Map<string, PendingLink>()

  constructor(path: string) {
    this.path = path
    this.load()
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { identities?: Identity[] }
      for (const identity of parsed.identities ?? []) {
        this.identities.set(identity.id, identity)
        for (const account of identity.accounts) {
          this.index.set(key(account.platform, account.accountId), identity.id)
        }
      }
    } catch {
      // A corrupt store must not stop the gateway starting; it starts empty and
      // the user re-links, which is recoverable. Refusing to start is not.
      this.identities = new Map()
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(
      this.path,
      `${JSON.stringify({ identities: [...this.identities.values()] }, null, 2)}\n`,
      'utf8',
    )
  }

  /** The identity bound to a platform account, if there is one. */
  resolve(platform: string, accountId: string): Identity | undefined {
    const id = this.index.get(key(platform, accountId))
    return id ? this.identities.get(id) : undefined
  }

  get(id: string): Identity | undefined {
    return this.identities.get(id)
  }

  /** Creates a local identity, as the terminal side of a link. */
  create(cwd: string): Identity {
    const identity: Identity = {
      id: createHash('sha256').update(`${cwd}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16),
      accounts: [],
      cwd,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    }
    this.identities.set(identity.id, identity)
    this.save()
    return identity
  }

  /**
   * Issues a one-time code the user types on the other platform.
   *
   * Six digits rather than a UUID because the user reads it aloud or types it
   * on a phone. That shortness is exactly why it expires in ten minutes and
   * dies on first use.
   */
  issueLinkCode(identityId: string): string {
    if (!this.identities.has(identityId)) {
      throw new Error(`no identity ${identityId}`)
    }

    this.expirePending()
    const code = String(Math.floor(100_000 + Math.random() * 900_000))
    this.pending.set(code, { code, identityId, expiresAt: Date.now() + LINK_TTL_MS })
    return code
  }

  /**
   * Redeems a code, binding a platform account to the identity that issued it.
   *
   * Consumed whether or not it succeeds afterwards: a code that survives a
   * failed attempt can be brute-forced, and six digits is a small space.
   */
  redeemLinkCode(
    code: string,
    platform: string,
    accountId: string,
    label?: string,
  ): Identity | undefined {
    this.expirePending()

    const link = this.pending.get(code)
    if (!link) return undefined
    this.pending.delete(code)

    const identity = this.identities.get(link.identityId)
    if (!identity) return undefined

    // Re-linking the same account is idempotent rather than a duplicate entry.
    const existingKey = key(platform, accountId)
    const alreadyBound = this.index.get(existingKey)
    if (alreadyBound && alreadyBound !== identity.id) {
      this.unlink(platform, accountId)
    }

    if (!identity.accounts.some((a) => a.platform === platform && a.accountId === accountId)) {
      identity.accounts.push({ platform, accountId, label, linkedAt: Date.now() })
    }

    this.index.set(existingKey, identity.id)
    identity.lastSeenAt = Date.now()
    this.save()
    return identity
  }

  /** Removes a platform account from whichever identity holds it. */
  unlink(platform: string, accountId: string): boolean {
    const identityKey = key(platform, accountId)
    const identityId = this.index.get(identityKey)
    if (!identityId) return false

    const identity = this.identities.get(identityId)
    if (identity) {
      identity.accounts = identity.accounts.filter(
        (a) => !(a.platform === platform && a.accountId === accountId),
      )
    }

    this.index.delete(identityKey)
    this.save()
    return true
  }

  /** Attaches an identity to an agent session. */
  attachSession(identityId: string, sessionId: string, cwd: string): void {
    const identity = this.identities.get(identityId)
    if (!identity) return

    identity.sessionId = sessionId
    identity.cwd = cwd
    identity.lastSeenAt = Date.now()
    this.save()
  }

  touch(identityId: string): void {
    const identity = this.identities.get(identityId)
    if (!identity) return
    identity.lastSeenAt = Date.now()
  }

  all(): Identity[] {
    return [...this.identities.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  private expirePending(): void {
    const now = Date.now()
    for (const [code, link] of this.pending) {
      if (link.expiresAt < now) this.pending.delete(code)
    }
  }

  /** Outstanding codes, for tests and `jean gateway status`. */
  pendingCount(): number {
    this.expirePending()
    return this.pending.size
  }
}

function key(platform: string, accountId: string): string {
  return `${platform}:${accountId}`
}

/** Default store location. */
export function identityStorePath(jeanHome: string): string {
  return join(jeanHome, 'gateway', 'identities.json')
}
