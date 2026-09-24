/**
 * `@jean/collab` — live session sharing (architecture §22).
 *
 * Relays one agent session to invited guests, with the transcript sealed
 * client-side so the relay never sees plaintext.
 *
 * Three properties hold by construction rather than by policy:
 *
 * - **The relay cannot read the session.** Frames are sealed before they reach
 *   the transport, and the only thing in the clear is routing metadata the
 *   relay needs to deliver them. This is why sealing lives in its own module
 *   that the transport cannot bypass — the guarantee is invisible from outside,
 *   so it has to be structural.
 * - **A link grants viewing, not control.** The default role for anyone
 *   arriving by invite is `viewer`, and promotion is a deliberate act by the
 *   host. A link that leaks into a chat log should not be able to run commands
 *   on someone's machine.
 * - **Permissions are enforced on receipt, not on send.** A modified guest
 *   client will happily send anything; the host drops what the sender's role
 *   does not allow.
 *
 * ```ts
 * import { LocalHub, Session } from '@jean/collab'
 *
 * const hub = new LocalHub()
 * const host = new Session({ name: 'Jean', host: true, transport: hub.transport() })
 * const { url } = host.invite({ ttlMs: 15 * 60 * 1000 })
 * ```
 */

export {
  canOpen,
  constantTimeEquals,
  deriveKey,
  describeKey,
  exportKey,
  generateKey,
  importKey,
  open,
  seal,
  type Sealed,
  type SessionKey,
} from './seal.ts'

export {
  can,
  decodeInvite,
  describeFrame,
  encodeInvite,
  inviteIsValid,
  ROLE_CAPABILITIES,
  type Capability,
  type Control,
  type Envelope,
  type Frame,
  type Invite,
  type Participant,
  type ParticipantRole,
} from './protocol.ts'

export {
  LocalHub,
  randomId,
  Session,
  type SessionEvents,
  type SessionOptions,
  type Transport,
} from './session.ts'
