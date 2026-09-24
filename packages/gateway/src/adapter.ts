/**
 * The platform adapter contract (architecture §15.1).
 *
 * Every platform reduces to the same three things: receive a message, send a
 * reply, and identify the sender stably. Keeping the interface this narrow is
 * what makes a new platform a small file rather than a subsystem.
 */

export interface IncomingMessage {
  platform: string
  /** The platform's user id — stable, unlike a display name. */
  accountId: string
  /** Where a reply goes: a chat, channel, or thread id. */
  conversationId: string
  text: string
  /** For display and link labels. */
  senderLabel?: string
  /** Set when the platform delivered a voice note rather than text. */
  audioUrl?: string
  receivedAt: number
}

export interface OutgoingMessage {
  conversationId: string
  text: string
  /** Rendered as a code block where the platform supports one. */
  monospace?: boolean
}

export interface PlatformAdapter {
  readonly platform: string

  /** True when the adapter has the credentials it needs. */
  isConfigured(): boolean

  /** Begins receiving. Resolves once connected. */
  start(onMessage: (message: IncomingMessage) => void): Promise<void>

  send(message: OutgoingMessage): Promise<void>

  stop(): Promise<void>
}

/**
 * Splits a reply to fit a platform's message limit.
 *
 * Split on paragraph then line boundaries rather than at a hard offset: a reply
 * cut mid-code-block renders as broken markup on every platform, and the second
 * half is unreadable on its own.
 */
export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]

  const parts: string[] = []
  let current = ''

  for (const paragraph of text.split('\n\n')) {
    if (current.length + paragraph.length + 2 <= limit) {
      current = current ? `${current}\n\n${paragraph}` : paragraph
      continue
    }

    if (current) {
      parts.push(current)
      current = ''
    }

    if (paragraph.length <= limit) {
      current = paragraph
      continue
    }

    // A single paragraph past the limit: fall back to lines, then to a hard cut.
    let line = ''
    for (const text of paragraph.split('\n')) {
      if (line.length + text.length + 1 <= limit) {
        line = line ? `${line}\n${text}` : text
        continue
      }
      if (line) parts.push(line)
      line = text.length <= limit ? text : ''
      if (!line) {
        for (let i = 0; i < text.length; i += limit) parts.push(text.slice(i, i + limit))
      }
    }
    if (line) current = line
  }

  if (current) parts.push(current)
  return parts.filter(Boolean)
}
