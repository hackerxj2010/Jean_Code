/**
 * Session state: who is in a shared session, what they may do, and how frames
 * get sealed on the way out and opened on the way in.
 *
 * This is the part a host runs. It never trusts the relay for anything that
 * matters: participants are tracked locally, permissions are enforced locally,
 * and a frame that fails to open is dropped rather than surfaced.
 */

import { generateKey, open, seal, type SessionKey, type Sealed } from './seal.ts'
import {
  can,
  decodeInvite,
  encodeInvite,
  inviteIsValid,
  type Capability,
  type Control,
  type Envelope,
  type Frame,
  type Invite,
  type Participant,
  type ParticipantRole,
} from './protocol.ts'

/** How a session sends and receives envelopes. */
export interface Transport {
  send(envelope: Envelope): void | Promise<void>
  /** Registers a handler. Returns a function that unsubscribes. */
  receive(handler: (envelope: Envelope) => void): () => void
  close?(): void | Promise<void>
}

export interface SessionOptions {
  /** Session id. Generated when absent. */
  id?: string
  /** The local participant's display name. */
  name: string
  /** Whether this side hosts the session. */
  host?: boolean
  /** An existing key, for joining. A host generates one. */
  key?: SessionKey
  /**
   * The host's participant id, from the invite.
   *
   * Without it a guest cannot distinguish the host's frames from any other
   * participant's — everyone holds the same key, so the key proves membership,
   * not authority.
   */
  hostId?: string
  transport: Transport
  /**
   * Frames per second one participant may send before being dropped.
   *
   * A guest's client with a bug can otherwise flood every other participant,
   * and the host is the one whose terminal fills up.
   */
  rateLimit?: number
  /** Clock, injectable for tests. */
  now?: () => number
}

export interface SessionEvents {
  frame?: (frame: Frame, from: Participant) => void
  join?: (participant: Participant) => void
  leave?: (participant: Participant) => void
  control?: (control: Control) => void
  /** A frame that could not be opened or was refused, with the reason. */
  dropped?: (reason: string, envelope: Envelope) => void
  end?: (reason: string) => void
}

export class Session {
  readonly id: string
  readonly key: SessionKey
  readonly self: Participant

  private readonly transport: Transport
  private readonly events: SessionEvents = {}
  private readonly participants = new Map<string, Participant>()
  private readonly invites = new Map<string, Invite>()
  private readonly rateLimit: number
  private readonly now: () => number

  /** Per-sender send timestamps, for rate limiting. */
  private readonly recent = new Map<string, number[]>()
  /** Highest sequence seen per sender, to detect gaps and replays. */
  private readonly sequences = new Map<string, number>()

  /** Whose frames carry host authority. */
  private readonly hostId: string
  private outgoing = 0
  private unsubscribe?: () => void
  private ended = false

  constructor(options: SessionOptions) {
    this.now = options.now ?? Date.now
    this.id = options.id ?? randomId('s')
    this.key = options.key ?? generateKey()
    this.transport = options.transport
    this.rateLimit = options.rateLimit ?? 30

    this.self = {
      id: randomId('p'),
      name: options.name,
      role: options.host === true ? 'host' : 'viewer',
      joinedAt: this.now(),
    }
    this.participants.set(this.self.id, this.self)
    // A host is its own authority; a guest takes it from the invite.
    this.hostId = options.host === true ? this.self.id : (options.hostId ?? '')

    this.unsubscribe = this.transport.receive((envelope) => this.handle(envelope))
  }

  on(events: SessionEvents): this {
    Object.assign(this.events, events)
    return this
  }

  get isHost(): boolean {
    return this.self.role === 'host'
  }

  get members(): Participant[] {
    return [...this.participants.values()].sort((a, b) => a.joinedAt - b.joinedAt)
  }

  can(capability: Capability): boolean {
    return can(this.self.role, capability)
  }

  /** Announces this participant to the session. */
  async join(): Promise<void> {
    await this.transmit('join', { type: 'presence', participants: [this.self] })
  }

  /** Sends a frame to every participant. */
  async send(frame: Frame): Promise<void> {
    if (this.ended) throw new Error('this session has ended')

    // Permission is checked before sealing, so a refused frame never reaches
    // the transport in any form.
    const required: Capability = frame.type === 'suggestion' ? 'suggest' : 'steer'
    if (frame.type !== 'presence' && !this.can(required)) {
      throw new Error(`your role (${this.self.role}) cannot send a ${frame.type} frame`)
    }

    await this.transmit('frame', frame)
  }

  /**
   * Creates an invite.
   *
   * Single-use and time-limited by default. A link that works forever is one
   * that leaks into a chat log and grants access months later.
   */
  invite(
    options: { role?: ParticipantRole; ttlMs?: number; uses?: number } = {},
  ): { invite: Invite; url: string } {
    if (!this.can('promote') && options.role !== undefined && options.role !== 'viewer') {
      throw new Error('only the host can invite someone as more than a viewer')
    }

    const invite: Invite = {
      id: randomId('i'),
      session: this.id,
      host: this.self.id,
      key: Buffer.from(this.key.material).toString('base64url'),
      expiresAt: this.now() + (options.ttlMs ?? 60 * 60 * 1000),
      uses: options.uses ?? 1,
      role: options.role ?? 'viewer',
    }

    this.invites.set(invite.id, invite)
    return { invite, url: encodeInvite(invite) }
  }

  /** Consumes an invite, returning the role it grants. */
  redeem(url: string): ParticipantRole {
    const decoded = decodeInvite(url)

    if (decoded.session !== this.id) {
      throw new Error('that invite is for a different session')
    }

    const stored = this.invites.get(decoded.id)
    if (!stored) throw new Error('that invite is not recognised')

    if (!inviteIsValid(stored, this.now())) {
      throw new Error('that invite has expired or has already been used')
    }

    stored.uses -= 1
    return stored.role
  }

  /** Revokes every outstanding invite. */
  revokeInvites(): number {
    const count = this.invites.size
    this.invites.clear()
    return count
  }

  /** Promotes a participant. Host only. */
  promote(participantId: string, role: ParticipantRole): void {
    if (!this.can('promote')) {
      throw new Error('only the host can change a participant’s role')
    }
    const participant = this.participants.get(participantId)
    if (!participant) throw new Error(`no participant ${participantId}`)
    if (participant.id === this.self.id) throw new Error('you cannot change your own role')

    participant.role = role
  }

  /** Removes a participant. Host only. */
  remove(participantId: string): boolean {
    if (!this.can('promote')) {
      throw new Error('only the host can remove a participant')
    }
    return this.participants.delete(participantId)
  }

  /** Ends the session for everyone. Host only. */
  async end(reason = 'the host ended the session'): Promise<void> {
    if (!this.can('end')) throw new Error('only the host can end the session')

    await this.transmit('control', { type: 'status', text: reason })
    this.ended = true
    // Invites are cleared on the way out, so a link cannot rejoin a session
    // whose host has gone.
    this.invites.clear()
    this.unsubscribe?.()
    await this.transport.close?.()
    this.events.end?.(reason)
  }

  /** Leaves without ending the session. */
  async leave(): Promise<void> {
    await this.transmit('leave', { type: 'presence', participants: [this.self] })
    this.ended = true
    this.unsubscribe?.()
    await this.transport.close?.()
  }

  private async transmit(kind: Envelope['kind'], frame: Frame): Promise<void> {
    this.outgoing += 1
    const envelope: Envelope = {
      session: this.id,
      from: this.self.id,
      kind,
      at: this.now(),
      sequence: this.outgoing,
      // The routing metadata is authenticated but not encrypted, so the relay
      // cannot swap a frame between sessions without breaking the seal.
      sealed: seal(this.key, frame, `${this.id}:${this.self.id}:${kind}`),
    }
    await this.transport.send(envelope)
  }

  private handle(envelope: Envelope): void {
    if (this.ended) return

    // Our own frames come back from a broadcast relay; ignoring them here is
    // simpler than asking every relay to filter.
    if (envelope.from === this.self.id) return

    if (envelope.session !== this.id) {
      this.events.dropped?.('that frame is for a different session', envelope)
      return
    }

    if (!this.withinRateLimit(envelope.from)) {
      this.events.dropped?.('that participant is sending too fast', envelope)
      return
    }

    // A sequence at or below one already seen is a replay — or a relay
    // duplicating. Either way, processing it twice would double an edit.
    const seen = this.sequences.get(envelope.from)
    if (seen !== undefined && envelope.sequence <= seen) {
      this.events.dropped?.('that frame is a replay', envelope)
      return
    }
    this.sequences.set(envelope.from, envelope.sequence)

    if (!envelope.sealed) {
      this.events.dropped?.('that frame carried no sealed payload', envelope)
      return
    }

    let frame: Frame
    try {
      frame = this.openFrame(envelope.sealed, envelope)
    } catch (error) {
      this.events.dropped?.(error instanceof Error ? error.message : String(error), envelope)
      return
    }

    switch (envelope.kind) {
      case 'join': {
        const participant = this.participantFrom(frame, envelope)
        if (participant) {
          this.participants.set(participant.id, participant)
          this.events.join?.(participant)
        }
        return
      }

      case 'leave': {
        const participant = this.participants.get(envelope.from)
        this.participants.delete(envelope.from)
        if (participant) this.events.leave?.(participant)
        return
      }

      case 'control': {
        if (frame.type === 'status') {
          this.ended = true
          this.events.end?.(frame.text)
        }
        return
      }

      case 'frame': {
        const sender = this.participants.get(envelope.from)
        if (!sender) {
          this.events.dropped?.('that frame came from someone not in the session', envelope)
          return
        }

        // A guest cannot send a frame their role does not permit, whatever
        // their client claims. Enforcing this on receipt is what makes it
        // real — a modified client would happily send anything.
        const required: Capability = frame.type === 'suggestion' ? 'suggest' : 'steer'
        if (frame.type !== 'presence' && !can(sender.role, required)) {
          this.events.dropped?.(
            `${sender.name} (${sender.role}) may not send a ${frame.type} frame`,
            envelope,
          )
          return
        }

        this.events.frame?.(frame, sender)
      }
    }
  }

  private openFrame(sealed: Sealed, envelope: Envelope): Frame {
    // The expected AAD is rebuilt from the envelope, so a relay that rewrote
    // the sender or the kind fails authentication rather than being believed.
    const expected = `${envelope.session}:${envelope.from}:${envelope.kind}`
    if (sealed.aad !== undefined && sealed.aad !== expected) {
      throw new Error('that frame’s routing metadata does not match its seal')
    }
    return open<Frame>(this.key, sealed)
  }

  private participantFrom(frame: Frame, envelope: Envelope): Participant | undefined {
    if (frame.type !== 'presence' || frame.participants.length === 0) return undefined
    const claimed = frame.participants[0]!

    return {
      // The id comes from the envelope, not from the frame: a participant
      // claiming someone else's id would otherwise impersonate them.
      id: envelope.from,
      name: claimed.name,
      // The role is never taken from the frame either. The one id that carries
      // authority is the host's, which came from the invite; everyone else
      // arrives as a viewer and is promoted only by the host.
      role: envelope.from === this.hostId && this.hostId !== '' ? 'host' : 'viewer',
      joinedAt: envelope.at,
    }
  }

  private withinRateLimit(from: string): boolean {
    const now = this.now()
    const window = this.recent.get(from) ?? []
    const recent = window.filter((at) => now - at < 1000)

    if (recent.length >= this.rateLimit) {
      this.recent.set(from, recent)
      return false
    }

    recent.push(now)
    this.recent.set(from, recent)
    return true
  }
}

/** A random identifier with a readable prefix. */
export function randomId(prefix: string): string {
  const bytes = new Uint8Array(9)
  globalThis.crypto.getRandomValues(bytes)
  return `${prefix}_${Buffer.from(bytes).toString('base64url')}`
}

/**
 * An in-process transport, for a local session and for tests.
 *
 * Every transport connected to the same hub sees every envelope, which is what
 * a broadcast relay does.
 */
export class LocalHub {
  private readonly handlers = new Set<(envelope: Envelope) => void>()
  readonly delivered: Envelope[] = []

  transport(): Transport {
    return {
      send: (envelope) => {
        this.delivered.push(envelope)
        // A copy per handler: a receiver mutating an envelope must not change
        // what the next one sees.
        for (const handler of [...this.handlers]) handler(structuredClone(envelope))
      },
      receive: (handler) => {
        this.handlers.add(handler)
        return () => this.handlers.delete(handler)
      },
    }
  }
}
