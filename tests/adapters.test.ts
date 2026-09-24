import { describe, expect, test } from 'bun:test'

import {
  DiscordAdapter,
  EmailAdapter,
  SlackAdapter,
  decodeHeader,
  encodeHeader,
  extractAddress,
  parseMessage,
  replySubject,
  splitMessage,
  stripQuotedReply,
  unescapeSlack,
} from '../packages/gateway/src/index.ts'

/**
 * The adapters cannot be tested against the real platforms without credentials,
 * so what is tested here is everything that does not need a network: the
 * parsing, the escaping, the allowlists, and the configuration checks. Those
 * are also where the bugs actually are — a protocol client that connects is
 * usually right, and a header parser usually is not.
 */

describe('message splitting', () => {
  test('a short message is one part', () => {
    expect(splitMessage('hello', 100)).toEqual(['hello'])
  })

  test('splits on paragraph boundaries first', () => {
    const text = `${'a'.repeat(50)}\n\n${'b'.repeat(50)}`
    const parts = splitMessage(text, 60)
    expect(parts.length).toBe(2)
    expect(parts[0]).toBe('a'.repeat(50))
  })

  test('falls back to lines, then to a hard cut', () => {
    const parts = splitMessage('x'.repeat(250), 100)
    expect(parts.every((part) => part.length <= 100)).toBe(true)
    expect(parts.join('')).toBe('x'.repeat(250))
  })

  test('no part exceeds the limit', () => {
    const text = Array.from({ length: 40 }, (_, index) => `line ${index} ${'y'.repeat(60)}`).join('\n')
    for (const part of splitMessage(text, 200)) {
      expect(part.length).toBeLessThanOrEqual(200)
    }
  })
})

describe('discord adapter', () => {
  test('reports missing configuration rather than failing at connect time', async () => {
    const adapter = new DiscordAdapter({ token: '' })
    expect(adapter.isConfigured()).toBe(false)
    await expect(adapter.start(() => {})).rejects.toThrow(/no Discord bot token/)
  })

  test('a configured adapter says so', () => {
    expect(new DiscordAdapter({ token: 'abc' }).isConfigured()).toBe(true)
  })

  test('stopping an adapter that never started is safe', async () => {
    await new DiscordAdapter({ token: 'abc' }).stop()
  })
})

describe('slack adapter', () => {
  test('names which token is wrong rather than failing generically', async () => {
    const swapped = new SlackAdapter({ appToken: 'xoxb-wrong', botToken: 'xoxb-right' })
    const result = await swapped.verify()
    expect(result.ok).toBe(false)
    // The message has to name the app-level token, because swapping the two is
    // the mistake everyone makes and `invalid_auth` names neither.
    expect(result.error).toContain('xapp-')
  })

  test('an adapter needs both tokens', async () => {
    const partial = new SlackAdapter({ appToken: 'xapp-a', botToken: '' })
    expect(partial.isConfigured()).toBe(false)
    await expect(partial.start(() => {})).rejects.toThrow(/both/)
  })

  test('unescapes entities so a comparison survives', () => {
    // Left escaped, `a &lt; b` reaches the model as literal markup and it
    // reasons about the wrong text.
    expect(unescapeSlack('if a &lt; b &amp;&amp; c &gt; d')).toBe('if a < b && c > d')
  })

  test('a link renders as its label', () => {
    expect(unescapeSlack('see <https://example.com|the docs> please')).toBe('see the docs please')
    expect(unescapeSlack('see <https://example.com>')).toBe('see https://example.com')
  })

  test('mentions render readably', () => {
    expect(unescapeSlack('hey <@U12345>')).toBe('hey @U12345')
    expect(unescapeSlack('in <#C12345|general>')).toBe('in #general')
    expect(unescapeSlack('in <#C12345>')).toBe('in #C12345')
  })

  test('plain text is unchanged', () => {
    expect(unescapeSlack('nothing special here')).toBe('nothing special here')
  })
})

describe('email parsing', () => {
  const RAW = [
    'From: Jean Badaba <jean@example.com>',
    'To: agent@example.com',
    'Subject: Fix the parser',
    'Message-ID: <abc123@example.com>',
    'References: <first@example.com> <second@example.com>',
    'Date: Wed, 15 Nov 2023 10:30:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please fix the parser.',
    '',
    'On Tue, 14 Nov 2023, agent wrote:',
    '> Previous message',
    '> More of it',
  ].join('\n')

  test('extracts the headers', () => {
    const message = parseMessage(1, RAW)
    expect(message.from).toBe('jean@example.com')
    expect(message.subject).toBe('Fix the parser')
    expect(message.messageId).toBe('<abc123@example.com>')
    expect(message.references).toEqual(['<first@example.com>', '<second@example.com>'])
  })

  test('a folded header is unfolded before parsing', () => {
    // A long References header wraps; parsing line by line loses everything
    // after the first line of it.
    const folded = [
      'From: a@example.com',
      'References: <one@example.com>',
      '\t<two@example.com> <three@example.com>',
      '',
      'body',
    ].join('\n')

    expect(parseMessage(1, folded).references).toHaveLength(3)
  })

  test('the first From wins over a forged second one', () => {
    const forged = ['From: real@example.com', 'From: attacker@example.com', '', 'body'].join('\n')
    expect(parseMessage(1, forged).from).toBe('real@example.com')
  })

  test('an address is extracted from a display name', () => {
    expect(extractAddress('Jean Badaba <jean@example.com>')).toBe('jean@example.com')
    expect(extractAddress('bare@example.com')).toBe('bare@example.com')
    expect(extractAddress('MIXED@Example.COM')).toBe('mixed@example.com')
  })

  test('the quoted original is stripped from a reply', () => {
    // Without this the agent re-reads its own previous output every turn.
    const stripped = stripQuotedReply(parseMessage(1, RAW).body)
    expect(stripped).toBe('Please fix the parser.')
    expect(stripped).not.toContain('Previous message')
  })

  test('stripping handles the other common quote markers', () => {
    expect(stripQuotedReply('new text\n\n-------- Original Message --------\nold')).toBe('new text')
    expect(stripQuotedReply('new text\n--\nSignature block')).toBe('new text')
  })

  test('a message with no quote is left alone', () => {
    expect(stripQuotedReply('just this')).toBe('just this')
  })

  test('encoded-word headers decode', () => {
    expect(decodeHeader('=?UTF-8?B?SGVsbG8gd29ybGQ=?=')).toBe('Hello world')
    expect(decodeHeader('=?UTF-8?Q?Caf=C3=A9?=')).toBe('Café')
    // An underscore means a space in the Q encoding, not an underscore.
    expect(decodeHeader('=?UTF-8?Q?two_words?=')).toBe('two words')
    expect(decodeHeader('plain ascii')).toBe('plain ascii')
  })

  test('a non-ascii subject is encoded on the way out', () => {
    expect(encodeHeader('plain')).toBe('plain')
    const encoded = encodeHeader('Café ☕')
    expect(encoded.startsWith('=?UTF-8?B?')).toBe(true)
    expect(decodeHeader(encoded)).toBe('Café ☕')
  })

  test('quoted-printable and base64 bodies decode', () => {
    const qp = [
      'From: a@example.com',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Caf=C3=A9 and a soft=',
      ' break',
    ].join('\n')
    expect(parseMessage(1, qp).body).toContain('Café')
    expect(parseMessage(1, qp).body).toContain('soft break')

    const b64 = [
      'From: a@example.com',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('decoded body', 'utf8').toString('base64'),
    ].join('\n')
    expect(parseMessage(1, b64).body).toBe('decoded body')
  })

  test('a reply subject does not stack prefixes', () => {
    expect(replySubject('Fix it')).toBe('Re: Fix it')
    expect(replySubject('Re: Fix it')).toBe('Re: Fix it')
    expect(replySubject('RE: Fix it')).toBe('RE: Fix it')
  })

  test('a message with no body does not throw', () => {
    const message = parseMessage(1, 'From: a@example.com\nSubject: empty')
    expect(message.body).toBe('')
    expect(message.from).toBe('a@example.com')
  })

  test('reports missing configuration', async () => {
    const adapter = new EmailAdapter({
      imap: { host: '', user: '', password: '' },
      smtp: { host: '', user: '', password: '', from: '' },
    })
    expect(adapter.isConfigured()).toBe(false)
    await expect(adapter.start(() => {})).rejects.toThrow(/IMAP and SMTP/)
  })

  test('stopping an adapter that never started is safe', async () => {
    await new EmailAdapter({
      imap: { host: 'a', user: 'b', password: 'c' },
      smtp: { host: 'd', user: 'e', password: 'f', from: 'g@h.i' },
    }).stop()
  })
})
