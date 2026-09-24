import {
  splitMessage,
  type IncomingMessage,
  type OutgoingMessage,
  type PlatformAdapter,
} from '../adapter.ts'

/**
 * Email over IMAP and SMTP (architecture §15).
 *
 * Email is the platform that works everywhere and needs no bot registration:
 * the user already has an account, and any device can reach it. It is also the
 * one where getting the details wrong is most visible — a mangled reply header
 * breaks threading in every client at once.
 *
 * Both protocols are line-oriented text over TLS, so this speaks them directly.
 * The constraint that shapes the code is that IMAP responses are tagged and
 * arrive interleaved: a reply to `A001 FETCH` can be preceded by untagged
 * updates about entirely different mailboxes, so a naive read-until-newline
 * parser mixes them up.
 */

/** Body size past which a reply is sent as an attachment instead. */
const INLINE_LIMIT = 100_000

export interface EmailOptions {
  imap: { host: string; port?: number; user: string; password: string }
  smtp: { host: string; port?: number; user: string; password: string; from: string }
  /** Only mail from these addresses is acted on. Empty means nobody. */
  allowedAccounts?: string[]
  /** How often to check for new mail. */
  pollMs?: number
  /** Mailbox to watch. */
  mailbox?: string
  onError?: (message: string) => void
}

interface ParsedMessage {
  uid: number
  from: string
  subject: string
  messageId: string
  /** For threading a reply correctly. */
  references: string[]
  body: string
  date: number
}

export class EmailAdapter implements PlatformAdapter {
  readonly platform = 'email'

  private readonly options: EmailOptions
  private timer?: ReturnType<typeof setInterval>
  private running = false
  /** UIDs already delivered, so a poll does not re-deliver the mailbox. */
  private readonly seen = new Set<number>()
  /** Message-Id by conversation, so a reply threads under the right message. */
  private readonly threads = new Map<string, ParsedMessage>()

  constructor(options: EmailOptions) {
    this.options = options
  }

  isConfigured(): boolean {
    const { imap, smtp } = this.options
    return Boolean(imap.host && imap.user && imap.password && smtp.host && smtp.from)
  }

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error('email needs IMAP and SMTP host, user, and password')
    }

    this.running = true

    // The first poll records what is already in the mailbox without acting on
    // it. Otherwise starting the gateway replies to every unread message
    // received since the user last looked, which for most inboxes is a flood.
    await this.poll(() => {}, true)

    this.timer = setInterval(() => {
      void this.poll(onMessage, false).catch((error: unknown) => {
        this.options.onError?.(error instanceof Error ? error.message : String(error))
      })
    }, this.options.pollMs ?? 30_000)
  }

  private async poll(
    onMessage: (message: IncomingMessage) => void,
    seedOnly: boolean,
  ): Promise<void> {
    if (!this.running) return

    const messages = await this.fetchUnseen()

    for (const message of messages) {
      if (this.seen.has(message.uid)) continue
      this.seen.add(message.uid)

      if (seedOnly) continue
      if (!this.permitted(message.from)) continue

      this.threads.set(message.from, message)

      onMessage({
        platform: this.platform,
        // The address is the account id: it is what the user controls and what
        // the allowlist is written against.
        accountId: message.from,
        conversationId: message.from,
        text: stripQuotedReply(message.body),
        senderLabel: message.from,
        receivedAt: message.date,
      })
    }

    // The seen set is bounded: an inbox that receives mail forever would
    // otherwise grow it without limit.
    if (this.seen.size > 10_000) {
      const keep = [...this.seen].slice(-5_000)
      this.seen.clear()
      for (const uid of keep) this.seen.add(uid)
    }
  }

  /**
   * Fetches unseen messages.
   *
   * Implemented against the IMAP command set directly. The connection is opened
   * per poll rather than held: an idle IMAP connection is dropped by most
   * servers within half an hour, and detecting that reliably is more code than
   * reconnecting.
   */
  private async fetchUnseen(): Promise<ParsedMessage[]> {
    const client = new ImapClient(this.options.imap, this.options.onError)

    try {
      await client.connect()
      await client.select(this.options.mailbox ?? 'INBOX')
      const uids = await client.searchUnseen()

      const messages: ParsedMessage[] = []
      // Bounded per poll: a mailbox with two thousand unread messages would
      // otherwise take minutes and deliver them all at once.
      for (const uid of uids.slice(-20)) {
        const raw = await client.fetchMessage(uid)
        if (raw !== undefined) messages.push(parseMessage(uid, raw))
      }
      return messages
    } finally {
      await client.close()
    }
  }

  private permitted(from: string): boolean {
    const allowed = this.options.allowedAccounts
    // An empty allowlist means nobody: an email address is public, and acting
    // on mail from anyone makes the agent a service for the whole internet.
    if (!allowed || allowed.length === 0) return false
    return allowed.some((address) => address.toLowerCase() === from.toLowerCase())
  }

  async send(message: OutgoingMessage): Promise<void> {
    const original = this.threads.get(message.conversationId)
    const body = message.monospace === true ? message.text : message.text

    // Long output goes as an attachment rather than inline: most clients render
    // a 200 KB plain-text body badly, and some truncate it silently.
    const parts = splitMessage(body, INLINE_LIMIT)

    const client = new SmtpClient(this.options.smtp, this.options.onError)
    try {
      await client.connect()

      for (const [index, part] of parts.entries()) {
        const subject = original
          ? replySubject(original.subject)
          : 'Jean Code'
        const numbered = parts.length > 1 ? `${subject} (${index + 1}/${parts.length})` : subject

        await client.send({
          to: message.conversationId,
          subject: numbered,
          body: part,
          // Threading headers: without `In-Reply-To` and `References`, every
          // reply starts a new conversation in the recipient's client.
          inReplyTo: original?.messageId,
          references: original ? [...original.references, original.messageId] : [],
        })
      }
    } finally {
      await client.close()
    }
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }
}

// ---- IMAP -----------------------------------------------------------------

/**
 * A minimal IMAP client.
 *
 * Only what the gateway needs: log in, select a mailbox, search for unseen, and
 * fetch. Tagged commands are correlated by their tag, because untagged
 * responses arrive interleaved and matching on order alone is how a client ends
 * up reporting one message's body under another's uid.
 */
class ImapClient {
  private socket?: import('node:tls').TLSSocket
  private buffer = ''
  private tag = 0
  private readonly pending = new Map<string, (lines: string[]) => void>()
  private collected: string[] = []

  constructor(
    private readonly options: EmailOptions['imap'],
    private readonly onError?: (message: string) => void,
  ) {}

  async connect(): Promise<void> {
    const tls = await import('node:tls')

    await new Promise<void>((resolve, reject) => {
      const socket = tls.connect(
        { host: this.options.host, port: this.options.port ?? 993, servername: this.options.host },
        () => resolve(),
      )
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => this.consume(chunk))
      socket.on('error', (error: Error) => {
        this.onError?.(`IMAP: ${error.message}`)
        reject(error)
      })
      this.socket = socket
    })

    // The server greets before accepting commands.
    await this.waitForGreeting()
    await this.command(`LOGIN ${quote(this.options.user)} ${quote(this.options.password)}`)
  }

  private waitForGreeting(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.collected.some((line) => line.startsWith('* OK'))) {
          this.collected = []
          resolve()
          return
        }
        setTimeout(check, 10)
      }
      check()
    })
  }

  private consume(chunk: string): void {
    this.buffer += chunk

    let newline = this.buffer.indexOf('\r\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 2)
      this.collected.push(line)

      // A tagged line ends the command it belongs to. Everything before it is
      // that command's response, including untagged lines about other things.
      const tagged = /^(A\d{4}) (OK|NO|BAD)/.exec(line)
      if (tagged) {
        const resolve = this.pending.get(tagged[1]!)
        if (resolve) {
          this.pending.delete(tagged[1]!)
          resolve(this.collected)
          this.collected = []
        }
      }

      newline = this.buffer.indexOf('\r\n')
    }
  }

  private command(text: string): Promise<string[]> {
    this.tag += 1
    const tag = `A${String(this.tag).padStart(4, '0')}`

    return new Promise((resolve, reject) => {
      // A command with no answer would hang the poll forever, and the next poll
      // would open another connection behind it.
      const timer = setTimeout(() => {
        this.pending.delete(tag)
        reject(new Error(`IMAP: no response to ${text.split(' ')[0]} within 30s`))
      }, 30_000)

      this.pending.set(tag, (lines) => {
        clearTimeout(timer)
        resolve(lines)
      })

      this.socket?.write(`${tag} ${text}\r\n`)
    })
  }

  async select(mailbox: string): Promise<void> {
    await this.command(`SELECT ${quote(mailbox)}`)
  }

  async searchUnseen(): Promise<number[]> {
    const lines = await this.command('UID SEARCH UNSEEN')
    const results = lines.find((line) => line.startsWith('* SEARCH')) ?? ''
    return results
      .replace('* SEARCH', '')
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((uid) => Number.isFinite(uid) && uid > 0)
  }

  async fetchMessage(uid: number): Promise<string | undefined> {
    // `BODY.PEEK` rather than `BODY`: fetching with `BODY` marks the message
    // read, so a crash mid-poll loses it from the unseen search forever.
    const lines = await this.command(`UID FETCH ${uid} (BODY.PEEK[])`)
    const start = lines.findIndex((line) => line.includes('FETCH'))
    if (start === -1) return undefined

    // The body runs from after the FETCH line to the closing paren.
    const body: string[] = []
    for (const line of lines.slice(start + 1)) {
      if (line === ')') break
      body.push(line)
    }
    return body.join('\n')
  }

  async close(): Promise<void> {
    try {
      if (this.socket && !this.socket.destroyed) {
        await this.command('LOGOUT').catch(() => {})
      }
    } finally {
      this.socket?.destroy()
      this.socket = undefined
    }
  }
}

// ---- SMTP -----------------------------------------------------------------

/** A minimal SMTP client over implicit TLS. */
class SmtpClient {
  private socket?: import('node:tls').TLSSocket
  private buffer = ''

  constructor(
    private readonly options: EmailOptions['smtp'],
    private readonly onError?: (message: string) => void,
  ) {}

  async connect(): Promise<void> {
    const tls = await import('node:tls')

    await new Promise<void>((resolve, reject) => {
      const socket = tls.connect(
        { host: this.options.host, port: this.options.port ?? 465, servername: this.options.host },
        () => resolve(),
      )
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        this.buffer += chunk
      })
      socket.on('error', (error: Error) => {
        this.onError?.(`SMTP: ${error.message}`)
        reject(error)
      })
      this.socket = socket
    })

    await this.expect('220')
    await this.exchange(`EHLO ${this.options.host}`, '250')

    // AUTH PLAIN carries a NUL-separated triple; the format is exact and a
    // space in the wrong place produces a 535 that names nothing.
    const separator = String.fromCharCode(0)
    const credentials = Buffer.from(
      `${separator}${this.options.user}${separator}${this.options.password}`,
      'utf8',
    ).toString('base64')
    await this.exchange(`AUTH PLAIN ${credentials}`, '235')
  }

  async send(message: {
    to: string
    subject: string
    body: string
    inReplyTo?: string
    references: string[]
  }): Promise<void> {
    await this.exchange(`MAIL FROM:<${this.options.from}>`, '250')
    await this.exchange(`RCPT TO:<${message.to}>`, '250')
    await this.exchange('DATA', '354')

    const headers = [
      `From: ${this.options.from}`,
      `To: ${message.to}`,
      `Subject: ${encodeHeader(message.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@jean.code>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
    ]

    if (message.inReplyTo !== undefined) {
      headers.push(`In-Reply-To: ${message.inReplyTo}`)
    }
    if (message.references.length > 0) {
      headers.push(`References: ${message.references.join(' ')}`)
    }

    // A line consisting of a single dot ends DATA, so one in the body has to be
    // doubled or the message is truncated there.
    const body = message.body.replace(/^\.$/gm, '..')

    this.socket?.write(`${headers.join('\r\n')}\r\n\r\n${body}\r\n.\r\n`)
    await this.expect('250')
  }

  private async exchange(command: string, expected: string): Promise<void> {
    this.buffer = ''
    this.socket?.write(`${command}\r\n`)
    await this.expect(expected, command.split(' ')[0])
  }

  private async expect(code: string, context = 'greeting'): Promise<void> {
    const deadline = Date.now() + 30_000

    while (Date.now() < deadline) {
      // A multi-line reply ends with the code followed by a space rather than a
      // hyphen; stopping at the first line would act on a partial response.
      const lines = this.buffer.split('\r\n').filter(Boolean)
      const final = lines.find((line) => /^\d{3} /.test(line))

      if (final) {
        if (!final.startsWith(code)) {
          throw new Error(`SMTP rejected ${context}: ${final}`)
        }
        this.buffer = ''
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    throw new Error(`SMTP: no ${code} response to ${context} within 30s`)
  }

  async close(): Promise<void> {
    try {
      this.socket?.write('QUIT\r\n')
    } finally {
      this.socket?.destroy()
      this.socket = undefined
    }
  }
}

// ---- parsing --------------------------------------------------------------

/** Parses the headers and plain-text body out of a raw message. */
export function parseMessage(uid: number, raw: string): ParsedMessage {
  const separator = raw.indexOf('\n\n')
  const headerText = separator === -1 ? raw : raw.slice(0, separator)
  const bodyText = separator === -1 ? '' : raw.slice(separator + 2)

  // Headers can be folded across lines with leading whitespace; unfolding first
  // is what makes a long References header parse at all.
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ')
  const headers = new Map<string, string>()

  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    // The first occurrence wins: a forged second `From` further down must not
    // override the real one.
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim())
  }

  const references = (headers.get('references') ?? '')
    .split(/\s+/)
    .filter((reference) => reference.startsWith('<'))

  return {
    uid,
    from: extractAddress(headers.get('from') ?? ''),
    subject: decodeHeader(headers.get('subject') ?? ''),
    messageId: headers.get('message-id') ?? '',
    references,
    body: decodeBody(bodyText, headers.get('content-transfer-encoding')),
    date: Date.parse(headers.get('date') ?? '') || Date.now(),
  }
}

/** Pulls the bare address out of `Name <address>`. */
export function extractAddress(value: string): string {
  const angled = /<([^>]+)>/.exec(value)
  if (angled?.[1]) return angled[1].trim().toLowerCase()
  return value.trim().toLowerCase()
}

/** Decodes RFC 2047 encoded-words in a header. */
export function decodeHeader(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_, _charset: string, encoding: string, text: string) => {
      if (encoding.toLowerCase() === 'b') {
        return Buffer.from(text, 'base64').toString('utf8')
      }
      // Quoted-printable, where `_` means a space.
      return decodeQuotedPrintable(text.replaceAll('_', ' '))
    },
  )
}

/**
 * Decodes quoted-printable into UTF-8.
 *
 * The escapes encode *bytes*, not characters: `=C3=A9` is the two-byte UTF-8
 * sequence for `e-acute`. Decoding each escape to a character independently
 * yields mojibake, which is the bug this exists to avoid — the bytes are
 * collected and decoded together.
 */
export function decodeQuotedPrintable(text: string): string {
  const bytes: number[] = []

  for (let index = 0; index < text.length; index++) {
    const character = text[index]!

    if (character === '=' && index + 2 < text.length) {
      const hex = text.slice(index + 1, index + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16))
        index += 2
        continue
      }
    }

    // Anything not part of an escape is ASCII here by definition, but encoding
    // it properly costs nothing and handles a non-conforming sender.
    for (const byte of Buffer.from(character, 'utf8')) bytes.push(byte)
  }

  return Buffer.from(bytes).toString('utf8')
}

function decodeBody(body: string, encoding: string | undefined): string {
  const kind = (encoding ?? '').toLowerCase()

  if (kind === 'base64') {
    return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8')
  }

  if (kind === 'quoted-printable') {
    // The soft line break goes first: a `=` at end of line is a continuation,
    // not the start of an escape, and leaving it confuses the byte decoder.
    return decodeQuotedPrintable(body.replace(/=\r?\n/g, ''))
  }

  return body
}

/**
 * Removes the quoted original from a reply.
 *
 * Without this every reply carries the whole thread, and by the fifth message
 * the agent is reading four copies of its own earlier output.
 */
export function stripQuotedReply(body: string): string {
  const lines = body.split('\n')
  const kept: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()

    // The attribution line most clients write above a quote.
    if (/^On .+ wrote:$/.test(trimmed)) break
    if (/^-{2,} ?Original Message ?-{2,}$/i.test(trimmed)) break
    if (trimmed === '--') break
    if (trimmed.startsWith('>')) continue

    kept.push(line)
  }

  return kept.join('\n').trim()
}

/** `Re: subject`, without stacking prefixes. */
export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`
}

/** Encodes a header value when it is not plain ASCII. */
export function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^ -~]/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}
