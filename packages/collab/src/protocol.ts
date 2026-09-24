/**
 * The wire protocol between a host, a relay, and guests.
 *
 * Two layers, deliberately separated:
 *
 * - **Envelopes** are what the relay sees: a session id, a sender, a kind, and
 *   an opaque sealed payload. The relay routes on these and can read nothing
 *   else.
 * - **Frames** are what participants see once opened.
 *
 * Keeping them apart in the types is what makes it hard to accidentally send
 * something in the clear: a function taking an `Envelope` cannot be handed a
 * `Frame`, so content cannot reach the transport unsealed.
 */

import type { Sealed } from './seal.ts'

/** What the relay sees. */
export interface Envelope {
  /** Which session this belongs to. Public: the relay routes on it. */
  session: string
  /** Who sent it. A participant id, not a name. */
  from: string
  /**
   * The envelope kind, which the relay uses for routing and rate limiting.
   *
   * Coarse on purpose: `frame` covers every kind of content, so the relay
   * learns nothing from traffic analysis beyond "something happened".
   */
  kind: 'join' | 'leave' | 'frame' | 'control'
  /** Milliseconds since the epoch, set by the sender. */
  at: number
  /** Monotonic per sender, so a gap is detectable. */
  sequence: number
  /** The sealed content, opaque to the relay. */
  sealed?: Sealed
}

/** What participants see once a frame is opened. */
export type Frame =
  | { type: 'transcript'; role: 'user' | 'assistant' | 'tool'; text: string; turn: number }
  | { type: 'tool-call'; name: string; summary: string; turn: number }
  | { type: 'tool-result'; name: string; summary: string; ok: boolean; turn: number }
  | { type: 'file-change'; path: string; change: 'added' | 'modified' | 'removed'; lines?: number }
  | { type: 'status'; text: string }
  | { type: 'cursor'; path: string; line: number }
  /** A guest asking the host to run something. Never executed automatically. */
  | { type: 'suggestion'; text: string; from: string }
  | { type: 'presence'; participants: Participant[] }

export interface Participant {
  id: string
  /** A display name, chosen by the participant. Sealed, so the relay never sees it. */
  name: string
  role: ParticipantRole
  joinedAt: number
}

/**
 * What a participant may do.
 *
 * `viewer` is the default and the only role a link alone can grant. Handing out
 * a link that lets a stranger run commands on the host's machine is not a
 * feature; promoting someone to `contributor` is a deliberate act by the host.
 */
export type ParticipantRole = 'host' | 'contributor' | 'viewer'

export const ROLE_CAPABILITIES: Record<ParticipantRole, readonly Capability[]> = {
  host: ['view', 'suggest', 'steer', 'promote', 'end'],
  contributor: ['view', 'suggest', 'steer'],
  viewer: ['view', 'suggest'],
}

export type Capability = 'view' | 'suggest' | 'steer' | 'promote' | 'end'

export function can(role: ParticipantRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability)
}

/** Control messages, which the relay may read because they carry no content. */
export type Control =
  | { type: 'joined'; participant: string }
  | { type: 'left'; participant: string }
  | { type: 'ended'; reason: string }
  | { type: 'rejected'; reason: string }
  /** The relay asking a sender to slow down. */
  | { type: 'throttle'; retryAfterMs: number }

/** An invitation to a session. */
export interface Invite {
  /** Unique per invite, so two minted in the same millisecond stay distinct. */
  id: string
  session: string
  /**
   * The host's participant id.
   *
   * A guest has to learn this from somewhere trustworthy, or it cannot tell the
   * host's frames from a stranger's — everyone in the session holds the same
   * key, so the key alone proves membership and not authority. The invite is
   * that trustworthy channel: the host minted it and delivered it out of band.
   */
  host: string
  /** Base64url session key. Whoever holds this can read the session. */
  key: string
  /** Milliseconds since the epoch. */
  expiresAt: number
  /** Uses remaining. Single-use by default. */
  uses: number
  role: ParticipantRole
}

/**
 * Encodes an invite as a URL.
 *
 * The key goes in the fragment, which browsers do not send to servers and which
 * stays out of server logs, referrers, and proxy records. Putting it in the
 * query string would hand the session to anyone reading an access log.
 */
export function encodeInvite(invite: Invite, base = 'https://jean.code/join'): string {
  const query = new URLSearchParams({
    i: invite.id,
    s: invite.session,
    h: invite.host,
    e: String(invite.expiresAt),
    r: invite.role,
  })
  return `${base}?${query.toString()}#k=${invite.key}`
}

export function decodeInvite(url: string): Invite {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('that is not a valid invite link')
  }

  const id = parsed.searchParams.get('i') ?? ''
  const session = parsed.searchParams.get('s')
  const host = parsed.searchParams.get('h') ?? ''
  const expires = parsed.searchParams.get('e')
  const role = parsed.searchParams.get('r') ?? 'viewer'

  const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ''))
  const key = fragment.get('k')

  if (!session || !key) {
    throw new Error('this invite link is missing its session or its key')
  }
  if (role !== 'host' && role !== 'contributor' && role !== 'viewer') {
    throw new Error(`unknown role in invite: ${role}`)
  }

  return {
    id,
    session,
    host,
    key,
    expiresAt: expires ? Number(expires) : 0,
    uses: 1,
    role,
  }
}

/** Whether an invite is still usable. */
export function inviteIsValid(invite: Invite, now = Date.now()): boolean {
  return invite.uses > 0 && (invite.expiresAt === 0 || invite.expiresAt > now)
}

/**
 * Summarizes a frame in one line, for a transcript or a notification.
 *
 * Bounded: a guest's client should not have to render a 200 KB tool result to
 * show that something happened.
 */
export function describeFrame(frame: Frame): string {
  switch (frame.type) {
    case 'transcript':
      return `${frame.role}: ${clip(frame.text, 100)}`
    case 'tool-call':
      return `→ ${frame.name}: ${clip(frame.summary, 80)}`
    case 'tool-result':
      return `${frame.ok ? '✓' : '✗'} ${frame.name}: ${clip(frame.summary, 80)}`
    case 'file-change':
      return `${frame.change} ${frame.path}${frame.lines === undefined ? '' : ` (${frame.lines} lines)`}`
    case 'status':
      return clip(frame.text, 100)
    case 'cursor':
      return `${frame.path}:${frame.line}`
    case 'suggestion':
      return `${frame.from} suggests: ${clip(frame.text, 100)}`
    case 'presence':
      return `${frame.participants.length} participant(s)`
  }
}

function clip(text: string, limit: number): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  return flattened.length <= limit ? flattened : `${flattened.slice(0, limit - 1)}…`
}
