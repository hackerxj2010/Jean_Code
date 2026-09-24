/**
 * Sealing: encrypting session frames before they leave the host.
 *
 * The relay is a dumb pipe. It routes sealed frames between participants and
 * cannot read them, which means a shared session does not require trusting
 * whoever runs the relay — including us.
 *
 * That property only holds if sealing happens at the edge, before anything is
 * transmitted, which is why this is a separate module the transport cannot
 * bypass. A design that encrypts "in the relay" or "at rest" gives up the whole
 * guarantee, and the difference is invisible from the outside.
 *
 * Built on `node:crypto` — the platform's own primitives, not a vendor SDK.
 * Rolling AES here would be irresponsible: constant-time behaviour and side
 * channels are exactly what a hand-written implementation gets wrong.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

/** AES-256-GCM: authenticated, so a tampered frame fails to open rather than decrypting to garbage. */
const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

/** A session key. Never transmitted; shared out of band in the invite. */
export interface SessionKey {
  /** Raw key material. */
  readonly material: Buffer
  /** A short, non-secret identifier, so a frame says which key opens it. */
  readonly id: string
}

/** A sealed frame, safe to hand to a relay. */
export interface Sealed {
  keyId: string
  /** Base64. */
  nonce: string
  /** Base64: ciphertext with the authentication tag appended. */
  payload: string
  /**
   * Authenticated but not encrypted, so the relay can route without opening.
   *
   * Anything placed here is visible to the relay. Only routing metadata
   * belongs in it — never content, and never a participant's name.
   */
  aad?: string
}

/** Generates a new session key. */
export function generateKey(): SessionKey {
  const material = randomBytes(KEY_BYTES)
  return { material, id: keyId(material) }
}

/**
 * Derives a session key from a passphrase.
 *
 * HKDF rather than a raw hash: a passphrase has far less entropy than 256 bits,
 * and hashing it directly produces a key no stronger than the passphrase while
 * looking like it is.
 *
 * This is for a human-shared secret. A generated key is strictly better where
 * one can be transmitted, and `generateKey` is what the invite flow uses.
 */
export function deriveKey(passphrase: string, salt: string): SessionKey {
  const material = Buffer.from(
    hkdfSync('sha256', Buffer.from(passphrase, 'utf8'), Buffer.from(salt, 'utf8'), Buffer.from('jean-collab-v1'), KEY_BYTES),
  )
  return { material, id: keyId(material) }
}

/** A short public identifier for a key. */
function keyId(material: Buffer): string {
  // A hash of the key, not the key: the id travels in the clear on every frame.
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

/** Encodes a key for an invite link. */
export function exportKey(key: SessionKey): string {
  return key.material.toString('base64url')
}

/** Decodes a key from an invite link. */
export function importKey(encoded: string): SessionKey {
  const material = Buffer.from(encoded, 'base64url')
  if (material.length !== KEY_BYTES) {
    throw new Error(`a session key must be ${KEY_BYTES} bytes; this one is ${material.length}`)
  }
  return { material, id: keyId(material) }
}

/** Seals a value. */
export function seal(key: SessionKey, value: unknown, aad?: string): Sealed {
  // A fresh nonce every time. Reusing one under the same key with GCM leaks the
  // XOR of both plaintexts and lets an attacker forge frames — it is the single
  // way to catastrophically misuse this construction.
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALGORITHM, key.material, nonce)

  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'))

  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  return {
    keyId: key.id,
    nonce: nonce.toString('base64'),
    payload: Buffer.concat([ciphertext, tag]).toString('base64'),
    ...(aad === undefined ? {} : { aad }),
  }
}

/**
 * Opens a sealed frame.
 *
 * Throws on a wrong key, a tampered payload, or altered routing metadata. That
 * is the point: a frame that fails to authenticate must not be processed, and
 * returning `undefined` invites a caller to carry on with a falsy value.
 */
export function open<T = unknown>(key: SessionKey, sealed: Sealed): T {
  if (!constantTimeEquals(sealed.keyId, key.id)) {
    throw new Error('this frame was sealed with a different key')
  }

  const nonce = Buffer.from(sealed.nonce, 'base64')
  if (nonce.length !== NONCE_BYTES) {
    throw new Error('malformed frame: bad nonce length')
  }

  const combined = Buffer.from(sealed.payload, 'base64')
  if (combined.length < TAG_BYTES) {
    throw new Error('malformed frame: payload is shorter than its authentication tag')
  }

  const ciphertext = combined.subarray(0, combined.length - TAG_BYTES)
  const tag = combined.subarray(combined.length - TAG_BYTES)

  const decipher = createDecipheriv(ALGORITHM, key.material, nonce)
  if (sealed.aad !== undefined) decipher.setAAD(Buffer.from(sealed.aad, 'utf8'))
  decipher.setAuthTag(tag)

  let plaintext: Buffer
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    // The underlying error names the cipher and helps an attacker more than it
    // helps the user.
    throw new Error('this frame failed authentication: wrong key, or it was altered in transit')
  }

  return JSON.parse(plaintext.toString('utf8')) as T
}

/** Whether a frame can be opened, without throwing. */
export function canOpen(key: SessionKey, sealed: Sealed): boolean {
  try {
    open(key, sealed)
    return true
  } catch {
    return false
  }
}

/** Compares two strings without leaking their contents through timing. */
export function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  // `timingSafeEqual` throws on a length mismatch, which itself leaks the
  // length — but a length difference is already public for these identifiers.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Redacts a key for display.
 *
 * Session keys end up in logs and screenshots. Showing the id rather than the
 * material means a shared terminal recording does not hand over the session.
 */
export function describeKey(key: SessionKey): string {
  return `key ${key.id.slice(0, 8)}… (${key.material.length * 8}-bit)`
}
