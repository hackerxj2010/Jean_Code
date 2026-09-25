import { afterEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Gateway,
  IdentityStore,
  type IncomingMessage,
  MatrixAdapter,
  SignalAdapter,
  SmsAdapter,
  WhatsAppAdapter,
  twilioSignature,
  verifyMetaSignature,
} from '../packages/gateway/src/index.ts'

/**
 * The gateway's newer platforms — Matrix, Signal, WhatsApp, SMS — each
 * against a local stand-in for its service, over the real wire format:
 * messages in, replies out, strangers and forged requests refused.
 */

type Served = ReturnType<typeof Bun.serve>
const servers: Served[] = []
const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  for (const server of servers.splice(0)) server.stop(true)
})

function serve(fetch: (request: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, fetch })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

async function until<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const member = (sender: string) => ({
  type: 'm.room.member',
  sender,
  state_key: '@bot:hs',
  content: { membership: 'invite' },
})
const text = (sender: string, body: string) => ({
  type: 'm.room.message',
  sender,
  content: { msgtype: 'm.text', body },
})

describe('Matrix', () => {
  test('joins an allowed invite, hears allowed senders only, and replies in the room', async () => {
    const sent: { path: string; body: Record<string, string> }[] = []
    const joined: string[] = []
    const sinces: (string | null)[] = []
    let syncs = 0
    const homeserver = serve(async (request) => {
      const url = new URL(request.url)
      if (request.headers.get('authorization') !== 'Bearer tok')
        return Response.json({ errcode: 'M_UNKNOWN_TOKEN' }, { status: 401 })
      if (url.pathname.endsWith('/account/whoami')) return Response.json({ user_id: '@bot:hs' })
      if (url.pathname.includes('/join/')) {
        joined.push(decodeURIComponent(url.pathname.split('/join/')[1]!))
        return Response.json({ room_id: '!a:hs' })
      }
      if (url.pathname.includes('/send/m.room.message/')) {
        sent.push({ path: url.pathname, body: (await request.json()) as Record<string, string> })
        return Response.json({ event_id: '$e' })
      }
      if (url.pathname.endsWith('/sync')) {
        syncs++
        sinces.push(url.searchParams.get('since'))
        if (syncs === 1) {
          // History, which must not be answered; an invite from an allowed
          // account, and one from a stranger.
          return Response.json({
            next_batch: 's1',
            rooms: {
              join: { '!old:hs': { timeline: { events: [text('@ada:hs', 'old news')] } } },
              invite: {
                '!a:hs': { invite_state: { events: [member('@ada:hs')] } },
                '!b:hs': { invite_state: { events: [member('@eve:hs')] } },
              },
            },
          })
        }
        if (syncs === 2) {
          return Response.json({
            next_batch: 's2',
            rooms: {
              join: {
                '!a:hs': {
                  timeline: {
                    events: [
                      text('@ada:hs', 'fix the build'),
                      text('@eve:hs', 'rm -rf /'),
                      text('@bot:hs', 'my own echo'),
                    ],
                  },
                },
              },
            },
          })
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
        return Response.json({ next_batch: `s${syncs}` })
      }
      return new Response('not found', { status: 404 })
    })

    const received: IncomingMessage[] = []
    const matrix = new MatrixAdapter({
      homeserver,
      accessToken: 'tok',
      allowedAccounts: ['@ada:hs'],
    })
    await matrix.start((message) => received.push(message))
    stops.push(() => matrix.stop())

    const message = await until(() => received[0])
    expect(message).toMatchObject({
      platform: 'matrix',
      accountId: '@ada:hs',
      conversationId: '!a:hs',
      text: 'fix the build',
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(received).toHaveLength(1)
    expect(joined).toEqual(['!a:hs'])
    expect(sinces.slice(0, 2)).toEqual([null, 's1'])

    await matrix.send({ conversationId: '!a:hs', text: 'a < b', monospace: true })
    expect(sent[0]!.path).toContain(encodeURIComponent('!a:hs'))
    expect(sent[0]!.body).toMatchObject({
      msgtype: 'm.text',
      body: 'a < b',
      formatted_body: '<pre><code>a &lt; b</code></pre>',
    })
  })
})

describe('Signal', () => {
  test('reads the daemon’s event stream and answers by JSON-RPC, in the group when it came from one', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = []
    const event = (source: string, message: string, groupId?: string) =>
      `data: ${JSON.stringify({
        jsonrpc: '2.0',
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: source,
            sourceName: 'Ada',
            dataMessage: { message, ...(groupId ? { groupInfo: { groupId } } : {}) },
          },
        },
      })}\n\n`
    const daemon = serve(async (request) => {
      const url = new URL(request.url)
      if (url.pathname === '/api/v1/check') return new Response(null, { status: 200 })
      if (url.pathname === '/api/v1/events') {
        const stream =
          event('+15550001', 'hello') +
          event('+15559999', 'intruder') +
          event('+15550001', 'in the group', 'Z3JvdXA=')
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(stream))
          },
        })
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      }
      if (url.pathname === '/api/v1/rpc') {
        const rpc = (await request.json()) as {
          id: number
          method: string
          params: Record<string, unknown>
        }
        calls.push(rpc)
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { timestamp: 1 } })
      }
      return new Response(null, { status: 404 })
    })

    const received: IncomingMessage[] = []
    const signal = new SignalAdapter({
      url: daemon,
      account: '+15557777',
      allowedAccounts: ['+15550001'],
    })
    expect(signal.isConfigured()).toBe(true)
    await signal.start((message) => received.push(message))
    stops.push(() => signal.stop())

    await until(() => received[1])
    expect(received.map((m) => [m.text, m.conversationId])).toEqual([
      ['hello', '+15550001'],
      ['in the group', 'group:Z3JvdXA='],
    ])
    await signal.send({ conversationId: 'group:Z3JvdXA=', text: 'done' })
    await signal.send({ conversationId: '+15550001', text: 'direct' })
    expect(calls).toEqual([
      expect.objectContaining({
        method: 'send',
        params: { groupId: 'Z3JvdXA=', message: 'done', account: '+15557777' },
      }),
      expect.objectContaining({
        method: 'send',
        params: { recipient: ['+15550001'], message: 'direct', account: '+15557777' },
      }),
    ])
  })
})

describe('WhatsApp', () => {
  test('answers the registration handshake, trusts only signed webhooks, and replies through the Graph API', async () => {
    const outgoing: unknown[] = []
    const graph = serve(async (request) => {
      expect(request.headers.get('authorization')).toBe('Bearer graph-token')
      outgoing.push(await request.json())
      return Response.json({ messages: [{ id: 'wamid.1' }] })
    })
    const received: IncomingMessage[] = []
    const whatsapp = new WhatsAppAdapter({
      phoneNumberId: '1234',
      accessToken: 'graph-token',
      appSecret: 'app-secret',
      verifyToken: 'verify-me',
      port: 0,
      allowedAccounts: ['15550001'],
      graphUrl: graph,
    })
    await whatsapp.start((message) => received.push(message))
    stops.push(() => whatsapp.stop())
    const hook = `http://127.0.0.1:${whatsapp.boundPort}/whatsapp`

    expect(
      await (
        await fetch(`${hook}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`)
      ).text(),
    ).toBe('42')
    expect(
      (await fetch(`${hook}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`)).status,
    ).toBe(403)

    const payload = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: '15550001', profile: { name: 'Ada' } }],
                messages: [
                  { from: '15550001', id: 'm1', type: 'text', text: { body: 'run the tests' } },
                ],
              },
            },
          ],
        },
      ],
    })
    const signature = `sha256=${createHmac('sha256', 'app-secret').update(payload).digest('hex')}`
    expect(verifyMetaSignature(payload, signature, 'app-secret')).toBe(true)
    expect(
      (
        await fetch(hook, {
          method: 'POST',
          body: payload,
          headers: { 'x-hub-signature-256': 'sha256=forged' },
        })
      ).status,
    ).toBe(401)
    expect(received).toHaveLength(0)
    expect(
      (
        await fetch(hook, {
          method: 'POST',
          body: payload,
          headers: { 'x-hub-signature-256': signature },
        })
      ).status,
    ).toBe(200)

    expect(received).toEqual([
      expect.objectContaining({
        platform: 'whatsapp',
        accountId: '15550001',
        text: 'run the tests',
        senderLabel: 'Ada',
      }),
    ])
    await whatsapp.send({ conversationId: '15550001', text: 'all green' })
    expect(outgoing).toEqual([
      {
        messaging_product: 'whatsapp',
        to: '15550001',
        type: 'text',
        text: { body: 'all green', preview_url: false },
      },
    ])
  })
})

describe('SMS', () => {
  test('refuses unsigned webhooks, hears allowed numbers, and sends through Twilio', async () => {
    const outgoing: { auth: string | null; form: Record<string, string> }[] = []
    const twilio = serve(async (request) => {
      outgoing.push({
        auth: request.headers.get('authorization'),
        form: Object.fromEntries(new URLSearchParams(await request.text())),
      })
      return Response.json({ sid: 'SM1' }, { status: 201 })
    })
    const received: IncomingMessage[] = []
    const sms = new SmsAdapter({
      accountSid: 'AC1',
      authToken: 'secret',
      fromNumber: '+15557777',
      port: 0,
      allowedAccounts: ['+15550001'],
      apiUrl: twilio,
    })
    await sms.start((message) => received.push(message))
    stops.push(() => sms.stop())
    const url = `http://127.0.0.1:${sms.boundPort}/sms`
    const params = { From: '+15550001', To: '+15557777', Body: 'deploy it', MessageSid: 'SM0' }
    const body = new URLSearchParams(params).toString()
    const headers = {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-proto': 'http',
    }

    const forged = await fetch(url, {
      method: 'POST',
      body,
      headers: { ...headers, 'x-twilio-signature': 'bm9wZQ==' },
    })
    expect(forged.status).toBe(403)
    expect(received).toHaveLength(0)

    const signed = await fetch(url, {
      method: 'POST',
      body,
      headers: { ...headers, 'x-twilio-signature': twilioSignature('secret', url, params) },
    })
    expect(signed.status).toBe(200)
    expect(await signed.text()).toContain('<Response></Response>')
    expect(received).toEqual([
      expect.objectContaining({ platform: 'sms', accountId: '+15550001', text: 'deploy it' }),
    ])

    await sms.send({ conversationId: '+15550001', text: 'deployed' })
    expect(outgoing).toEqual([
      {
        auth: `Basic ${Buffer.from('AC1:secret').toString('base64')}`,
        form: { To: '+15550001', From: '+15557777', Body: 'deployed' },
      },
    ])
  })
})

describe('the gateway', () => {
  test('starts every configured platform and reports the ones it could not', async () => {
    const homeserver = serve(async (request) => {
      const path = new URL(request.url).pathname
      if (path.endsWith('/account/whoami')) return Response.json({ user_id: '@bot:hs' })
      if (path.endsWith('/sync')) await new Promise((resolve) => setTimeout(resolve, 50))
      return Response.json({ next_batch: 'x' })
    })
    const identities = new IdentityStore(join(tmpdir(), `jean-gateway-${Date.now()}.json`))
    const gateway = new Gateway({
      identities,
      platforms: {
        matrix: { homeserver, accessToken: 'tok', allowedAccounts: ['@ada:hs'] },
        sms: { accountSid: 'AC1', authToken: 'secret', fromNumber: '+1', port: 0 },
        whatsapp: { phoneNumberId: '', accessToken: '', appSecret: '', verifyToken: '' },
      },
      run: async () => 'ok',
    })
    const { started, failed } = await gateway.start()
    stops.push(() => gateway.stop())
    expect(started.sort()).toEqual(['matrix', 'sms'])
    expect(failed).toEqual([{ platform: 'whatsapp', error: 'missing credentials' }])
  })
})
