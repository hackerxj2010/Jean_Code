import { expect, test, describe } from 'bun:test'

import {
  can,
  decodeInvite,
  describeFrame,
  encodeInvite,
  deriveKey,
  exportKey,
  generateKey,
  importKey,
  inviteIsValid,
  LocalHub,
  open,
  seal,
  Session,
  type Envelope,
  type Frame,
  type Invite,
} from '../packages/collab/src/index.ts'

describe('sealing', () => {
  test('round trips a value', () => {
    const key = generateKey()
    const frame: Frame = { type: 'status', text: 'running tests' }
    expect(open<Frame>(key, seal(key, frame))).toEqual(frame)
  })

  test('a different key cannot open it', () => {
    const sealed = seal(generateKey(), { type: 'status', text: 'secret' })
    expect(() => open(generateKey(), sealed)).toThrow(/different key/)
  })

  test('a tampered payload fails authentication rather than decrypting', () => {
    // The property that makes the relay untrusted: it cannot alter a frame
    // without the alteration being detected.
    const key = generateKey()
    const sealed = seal(key, { type: 'status', text: 'original' })

    const bytes = Buffer.from(sealed.payload, 'base64')
    bytes[0] = (bytes[0] ?? 0) ^ 0xff
    const tampered = { ...sealed, payload: bytes.toString('base64') }

    expect(() => open(key, tampered)).toThrow(/failed authentication/)
  })

  test('altered routing metadata fails authentication', () => {
    const key = generateKey()
    const sealed = seal(key, { type: 'status', text: 'x' }, 'session-a:sender:frame')
    expect(() => open(key, { ...sealed, aad: 'session-b:sender:frame' })).toThrow(/failed authentication/)
  })

  test('every seal uses a fresh nonce', () => {
    // Nonce reuse under GCM is the one catastrophic misuse of this construction.
    const key = generateKey()
    const nonces = new Set<string>()
    for (let index = 0; index < 200; index++) {
      nonces.add(seal(key, { type: 'status', text: 'same payload every time' }).nonce)
    }
    expect(nonces.size).toBe(200)
  })

  test('identical plaintext seals to different ciphertext', () => {
    const key = generateKey()
    const first = seal(key, { type: 'status', text: 'identical' })
    const second = seal(key, { type: 'status', text: 'identical' })
    expect(first.payload).not.toBe(second.payload)
  })

  test('a key exports and imports without changing identity', () => {
    const key = generateKey()
    const restored = importKey(exportKey(key))
    expect(restored.id).toBe(key.id)

    const sealed = seal(key, { type: 'status', text: 'x' })
    expect(open<Frame>(restored, sealed)).toEqual({ type: 'status', text: 'x' })
  })

  test('a malformed key is rejected with its length', () => {
    expect(() => importKey('dG9vc2hvcnQ')).toThrow(/32 bytes/)
  })

  test('a derived key is stable for the same passphrase and salt', () => {
    const first = deriveKey('correct horse battery staple', 'session-42')
    const second = deriveKey('correct horse battery staple', 'session-42')
    expect(first.id).toBe(second.id)

    // A different salt gives a different key, so one passphrase reused across
    // sessions does not make them mutually readable.
    expect(deriveKey('correct horse battery staple', 'session-43').id).not.toBe(first.id)
  })

  test('a truncated payload is rejected rather than parsed', () => {
    const key = generateKey()
    const sealed = seal(key, { type: 'status', text: 'x' })
    expect(() => open(key, { ...sealed, payload: 'AAAA' })).toThrow(/shorter than/)
    expect(() => open(key, { ...sealed, nonce: 'AAAA' })).toThrow(/nonce length/)
  })
})

describe('invites', () => {
  const invite: Invite = {
    id: 'i_test',
    session: 's_abc',
    host: 'p_host',
    key: 'a'.repeat(43),
    expiresAt: 1_800_000_000_000,
    uses: 1,
    role: 'viewer',
  }

  test('the key travels in the fragment, not the query', () => {
    // A key in the query string lands in every access log and referrer header
    // between here and the relay.
    const url = encodeInvite(invite)
    const parsed = new URL(url)

    expect(parsed.search).not.toContain(invite.key)
    expect(parsed.hash).toContain(invite.key)
  })

  test('round trips', () => {
    const decoded = decodeInvite(encodeInvite(invite))
    expect(decoded.session).toBe(invite.session)
    expect(decoded.key).toBe(invite.key)
    expect(decoded.role).toBe('viewer')
  })

  test('a malformed link is rejected with a reason', () => {
    expect(() => decodeInvite('not a url')).toThrow(/valid invite/)
    expect(() => decodeInvite('https://jean.code/join?s=x')).toThrow(/missing/)
    expect(() => decodeInvite('https://jean.code/join?s=x&r=admin#k=y')).toThrow(/unknown role/)
  })

  test('validity accounts for expiry and remaining uses', () => {
    const now = 1_000
    expect(inviteIsValid({ ...invite, expiresAt: 2_000, uses: 1 }, now)).toBe(true)
    expect(inviteIsValid({ ...invite, expiresAt: 500, uses: 1 }, now)).toBe(false)
    expect(inviteIsValid({ ...invite, expiresAt: 2_000, uses: 0 }, now)).toBe(false)
  })
})

describe('roles', () => {
  test('a viewer may watch and suggest but not steer', () => {
    expect(can('viewer', 'view')).toBe(true)
    expect(can('viewer', 'suggest')).toBe(true)
    expect(can('viewer', 'steer')).toBe(false)
    expect(can('viewer', 'end')).toBe(false)
  })

  test('only the host may promote or end', () => {
    expect(can('contributor', 'steer')).toBe(true)
    expect(can('contributor', 'promote')).toBe(false)
    expect(can('host', 'promote')).toBe(true)
    expect(can('host', 'end')).toBe(true)
  })
})

describe('session', () => {
  function pair() {
    const hub = new LocalHub()
    const host = new Session({ name: 'Host', host: true, transport: hub.transport() })
    const guest = new Session({
      id: host.id,
      name: 'Guest',
      key: host.key,
      hostId: host.self.id,
      transport: hub.transport(),
    })
    return { hub, host, guest }
  }

  test('a guest receives a frame the host sends', async () => {
    const { host, guest } = pair()
    const received: Frame[] = []

    guest.on({ frame: (frame) => received.push(frame) })
    await host.join()
    await guest.join()

    await host.send({ type: 'status', text: 'running the test suite' })

    expect(received).toEqual([{ type: 'status', text: 'running the test suite' }])
  })

  test('what reaches the transport is sealed', async () => {
    const { hub, host } = pair()
    await host.join()
    await host.send({ type: 'transcript', role: 'user', text: 'my secret prompt', turn: 1 })

    // The relay sees envelopes; none of them may contain the content.
    const serialized = JSON.stringify(hub.delivered)
    expect(serialized).not.toContain('my secret prompt')
    // Nor the participant's name, which is inside the sealed payload.
    expect(serialized).not.toContain('Host')
  })

  test('the relay can route without opening', async () => {
    const { hub, host } = pair()
    await host.join()
    await host.send({ type: 'status', text: 'x' })

    const envelope = hub.delivered.at(-1) as Envelope
    expect(envelope.session).toBe(host.id)
    expect(envelope.kind).toBe('frame')
    expect(typeof envelope.sequence).toBe('number')
  })

  test('a joiner arrives as a viewer whatever they claim', async () => {
    // A link grants viewing. A client claiming `host` must not become one.
    const { host, guest } = pair()
    await guest.join()

    const joined = host.members.find((member) => member.name === 'Guest')
    expect(joined?.role).toBe('viewer')
  })

  test('a viewer cannot send a steering frame', async () => {
    const { guest } = pair()
    await guest.join()

    await expect(
      guest.send({ type: 'transcript', role: 'user', text: 'do this', turn: 1 }),
    ).rejects.toThrow(/cannot send/)

    // But a suggestion is allowed, which is the point of a viewer.
    await guest.send({ type: 'suggestion', text: 'try the other branch', from: 'Guest' })
  })

  test('the host drops a frame a sender’s role does not permit', async () => {
    // Enforced on receipt: a modified client would send it regardless.
    const hub = new LocalHub()
    const host = new Session({ name: 'Host', host: true, transport: hub.transport() })
    const rogue = new Session({ id: host.id, name: 'Rogue', key: host.key, hostId: host.self.id, transport: hub.transport() })

    const dropped: string[] = []
    const received: Frame[] = []
    host.on({ dropped: (reason) => dropped.push(reason), frame: (frame) => received.push(frame) })

    await rogue.join()
    // Bypass the local check the way a modified client would.
    Object.assign(rogue.self, { role: 'contributor' })
    await rogue.send({ type: 'transcript', role: 'user', text: 'run rm -rf /', turn: 1 })

    expect(received).toEqual([])
    expect(dropped.some((reason) => reason.includes('may not send'))).toBe(true)
  })

  test('the host can promote a guest, and then their frames land', async () => {
    const { host, guest } = pair()
    const received: Frame[] = []
    host.on({ frame: (frame) => received.push(frame) })

    await guest.join()
    const id = host.members.find((member) => member.name === 'Guest')!.id
    host.promote(id, 'contributor')

    // The guest's own client must also know, or its local check refuses first.
    Object.assign(guest.self, { role: 'contributor' })
    await guest.send({ type: 'transcript', role: 'user', text: 'allowed now', turn: 2 })

    expect(received.some((frame) => frame.type === 'transcript')).toBe(true)
  })

  test('a guest cannot promote anyone', async () => {
    const { host, guest } = pair()
    await guest.join()
    const id = guest.members[0]!.id
    expect(() => guest.promote(id, 'host')).toThrow(/only the host/)
    expect(() => guest.end()).toThrow(/only the host/)
    void host
  })

  test('nobody can change their own role', async () => {
    const { host } = pair()
    expect(() => host.promote(host.self.id, 'viewer')).toThrow(/your own role/)
  })

  test('a replayed envelope is dropped', async () => {
    const hub = new LocalHub()
    const host = new Session({ name: 'Host', host: true, transport: hub.transport() })
    const guest = new Session({ id: host.id, name: 'Guest', key: host.key, hostId: host.self.id, transport: hub.transport() })

    const received: Frame[] = []
    const dropped: string[] = []
    guest.on({ frame: (frame) => received.push(frame), dropped: (reason) => dropped.push(reason) })

    await host.join()
    await host.send({ type: 'status', text: 'once' })

    // A relay replaying a captured envelope must not double the effect.
    const captured = hub.delivered.at(-1)!
    const transport = hub.transport()
    transport.send(structuredClone(captured))

    expect(received.length).toBe(1)
    expect(dropped.some((reason) => reason.includes('replay'))).toBe(true)
  })

  test('a frame for another session is dropped', async () => {
    const hub = new LocalHub()
    const host = new Session({ name: 'Host', host: true, transport: hub.transport() })

    const dropped: string[] = []
    host.on({ dropped: (reason) => dropped.push(reason) })

    hub.transport().send({
      session: 'some-other-session',
      from: 'p_elsewhere',
      kind: 'frame',
      at: Date.now(),
      sequence: 1,
      sealed: seal(host.key, { type: 'status', text: 'x' }),
    })

    expect(dropped.some((reason) => reason.includes('different session'))).toBe(true)
  })

  test('a frame sealed with the wrong key is dropped, not surfaced', async () => {
    const hub = new LocalHub()
    const host = new Session({ name: 'Host', host: true, transport: hub.transport() })

    const dropped: string[] = []
    const received: Frame[] = []
    host.on({ dropped: (reason) => dropped.push(reason), frame: (frame) => received.push(frame) })

    hub.transport().send({
      session: host.id,
      from: 'p_stranger',
      kind: 'frame',
      at: Date.now(),
      sequence: 1,
      sealed: seal(generateKey(), { type: 'status', text: 'x' }),
    })

    expect(received).toEqual([])
    expect(dropped.length).toBeGreaterThan(0)
  })

  test('a flooding participant is throttled', async () => {
    const hub = new LocalHub()
    let clock = 1_000
    const host = new Session({
      name: 'Host',
      host: true,
      transport: hub.transport(),
      rateLimit: 5,
      now: () => clock,
    })
    const guest = new Session({ id: host.id, name: 'Guest', key: host.key, hostId: host.self.id, transport: hub.transport() })

    const dropped: string[] = []
    host.on({ dropped: (reason) => dropped.push(reason) })

    await guest.join()
    for (let index = 0; index < 20; index++) {
      await guest.send({ type: 'suggestion', text: `flood ${index}`, from: 'Guest' })
    }

    expect(dropped.some((reason) => reason.includes('too fast'))).toBe(true)
  })

  test('an invite is single-use by default', () => {
    const hub = new LocalHub()
    const host = new Session({ name: 'Host', host: true, transport: hub.transport() })
    const { url } = host.invite()

    expect(host.redeem(url)).toBe('viewer')
    expect(() => host.redeem(url)).toThrow(/expired or has already been used/)
  })

  test('an expired invite is refused', () => {
    const hub = new LocalHub()
    let clock = 1_000
    const host = new Session({ name: 'Host', host: true, transport: hub.transport(), now: () => clock })
    const { url } = host.invite({ ttlMs: 100 })

    clock += 200
    expect(() => host.redeem(url)).toThrow(/expired/)
  })

  test('revoking clears every outstanding invite', () => {
    const hub = new LocalHub()
    const host = new Session({ name: 'Host', host: true, transport: hub.transport() })
    const { url } = host.invite()
    host.invite()

    expect(host.revokeInvites()).toBe(2)
    expect(() => host.redeem(url)).toThrow(/not recognised/)
  })

  test('an invite for another session is refused', () => {
    const hub = new LocalHub()
    const host = new Session({ name: 'Host', host: true, transport: hub.transport() })
    const other = new Session({ name: 'Other', host: true, transport: new LocalHub().transport() })

    expect(() => host.redeem(other.invite().url)).toThrow(/different session/)
  })

  test('a guest cannot mint a contributor invite', () => {
    const { guest } = pair()
    expect(() => guest.invite({ role: 'contributor' })).toThrow(/only the host/)
  })

  test('ending the session tells the guest and revokes the links', async () => {
    const { host, guest } = pair()
    const ended: string[] = []
    guest.on({ end: (reason) => ended.push(reason) })

    await guest.join()
    const { url } = host.invite()
    await host.end('finished for today')

    expect(ended).toEqual(['finished for today'])
    expect(() => host.redeem(url)).toThrow(/not recognised/)
    await expect(host.send({ type: 'status', text: 'after' })).rejects.toThrow(/has ended/)
  })

  test('a participant leaving is announced', async () => {
    const { host, guest } = pair()
    const left: string[] = []
    host.on({ leave: (participant) => left.push(participant.name) })

    await guest.join()
    await guest.leave()

    expect(left).toEqual(['Guest'])
  })
})

describe('frame descriptions', () => {
  test('each kind renders in one line', () => {
    expect(describeFrame({ type: 'status', text: 'working' })).toBe('working')
    expect(describeFrame({ type: 'tool-call', name: 'bash', summary: 'ls -la', turn: 1 })).toContain('bash')
    expect(describeFrame({ type: 'tool-result', name: 'bash', summary: 'ok', ok: true, turn: 1 })).toContain('✓')
    expect(describeFrame({ type: 'file-change', path: 'a.ts', change: 'modified', lines: 4 })).toContain('4 lines')
  })

  test('long text is clipped and newlines collapsed', () => {
    const rendered = describeFrame({
      type: 'status',
      text: `${'x'.repeat(500)}\nmore`,
    })
    expect(rendered.length).toBeLessThanOrEqual(101)
    expect(rendered).not.toContain('\n')
  })
})
