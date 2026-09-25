import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { jeanHome } from '@jean/config'
import { EventStore, type JeanEvent } from './eventstore.ts'

/**
 * Session persistence.
 *
 * A session is its event log, so persisting one is writing the log and
 * resuming one is replaying it. Sessions live under `~/.jean/sessions` as
 * newline-delimited JSON — appendable, greppable, and readable with `tail`
 * when something goes wrong.
 */

export interface SessionMeta {
  id: string
  cwd: string
  startedAt: number
  updatedAt: number
  /** First user message, for the session picker. */
  title: string
  events: number
  model: string
}

function sessionsDir(): string {
  const dir = join(jeanHome(), 'sessions')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`
}

export function sessionPath(id: string): string {
  return join(sessionsDir(), `${id}.jsonl`)
}

/** Writes the store to disk. Called after each turn. */
export function saveSession(id: string, store: EventStore): void {
  const lines = store.toJSON().map((event) => JSON.stringify(event))
  writeFileSync(sessionPath(id), `${lines.join('\n')}\n`, 'utf8')
}

/** Loads a session by id, or `undefined` if it does not exist. */
export function loadSession(id: string): EventStore | undefined {
  const path = sessionPath(id)
  if (!existsSync(path)) return undefined

  const events: JeanEvent[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as JeanEvent)
    } catch {
      // A truncated final line means the process died mid-write; the rest of
      // the session is still perfectly usable.
    }
  }
  return EventStore.fromJSON(events)
}

/** Lists sessions, newest first. Optionally only those from one directory. */
export function listSessions(cwd?: string, limit = 25): SessionMeta[] {
  const dir = sessionsDir()
  const metas: SessionMeta[] = []

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue
    const id = file.slice(0, -6)
    const store = loadSession(id)
    if (!store || store.length === 0) continue

    const start = store.ofType('session_start')[0]
    const firstUser = store.ofType('user_message')[0]
    const events = store.all()
    const last = events[events.length - 1]

    const meta: SessionMeta = {
      id,
      cwd: start?.cwd ?? '',
      startedAt: start?.at ?? events[0]?.at ?? 0,
      updatedAt: last?.at ?? 0,
      title: start?.title ?? firstUser?.text.split('\n')[0]?.slice(0, 80) ?? '(no prompt)',
      events: store.length,
      model: start?.model ?? '',
    }
    if (cwd && meta.cwd !== cwd) continue
    metas.push(meta)
  }

  return metas.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
}

/** The most recent session for a directory — what `jean resume` picks up. */
export function latestSession(cwd: string): SessionMeta | undefined {
  return listSessions(cwd, 1)[0]
}

/** Deletes a session's file. False when there was none. */
export function deleteSession(id: string): boolean {
  const path = sessionPath(id)
  if (!existsSync(path)) return false
  rmSync(path, { force: true })
  return true
}

/** Names a session; the name replaces its first prompt in every list. */
export function renameSession(id: string, title: string): boolean {
  const store = loadSession(id)
  if (!store) return false
  const events = store.toJSON()
  const start = events.find((event) => event.type === 'session_start')
  if (start && start.type === 'session_start') start.title = title.trim()
  else events.unshift({ type: 'session_start', at: events[0]?.at ?? Date.now(), cwd: '', mode: 'autonomous', model: '', title: title.trim() })
  saveSession(id, EventStore.fromJSON(events))
  return true
}

/**
 * Copies a session under a new id, so it can be continued in another
 * direction while the original stays as it was. Returns the new id.
 */
export function forkSession(id: string): string | undefined {
  const store = loadSession(id)
  if (!store) return undefined
  const fork = newSessionId()
  const events = store.toJSON().map((event) =>
    event.type === 'session_start' && event.title ? { ...event, title: `${event.title} (fork)` } : event,
  )
  saveSession(fork, EventStore.fromJSON(events))
  return fork
}

/** A session as one JSON document — what `jean export` writes and `jean import` reads. */
export interface SessionExport {
  format: 'jean-session'
  version: 1
  id: string
  /** ISO 8601. */
  exportedAt: string
  sanitized: boolean
  meta: Omit<SessionMeta, 'id'>
  events: JeanEvent[]
}

export function exportSession(id: string, options: { sanitize?: boolean } = {}): SessionExport | undefined {
  const store = loadSession(id)
  if (!store) return undefined
  const meta = listSessions(undefined, Number.MAX_SAFE_INTEGER).find((entry) => entry.id === id)
  const events = options.sanitize ? sanitizeEvents(store.toJSON()) : store.toJSON()
  const start = events.find((event) => event.type === 'session_start')
  return {
    format: 'jean-session',
    version: 1,
    id,
    exportedAt: new Date().toISOString(),
    sanitized: options.sanitize === true,
    meta: {
      cwd: start && start.type === 'session_start' ? start.cwd : meta?.cwd ?? '',
      startedAt: meta?.startedAt ?? events[0]?.at ?? 0,
      updatedAt: meta?.updatedAt ?? events[events.length - 1]?.at ?? 0,
      title: options.sanitize ? scrub(meta?.title ?? '') : meta?.title ?? '',
      events: events.length,
      model: meta?.model ?? '',
    },
    events,
  }
}

/**
 * Saves an exported session as a new one here. Keeps its id unless a
 * session already has it. Returns the id it was saved under.
 */
export function importSession(data: unknown): string {
  const doc = data as Partial<SessionExport> | null
  if (!doc || doc.format !== 'jean-session' || !Array.isArray(doc.events)) {
    throw new Error('not a Jean session export (expected "format": "jean-session")')
  }
  const events = doc.events.filter(
    (event): event is JeanEvent => Boolean(event) && typeof event === 'object' && typeof (event as { type?: unknown }).type === 'string',
  )
  if (events.length === 0) throw new Error('the export holds no events')
  const wanted = typeof doc.id === 'string' && /^[\w.-]+$/.test(doc.id) ? doc.id : undefined
  const id = wanted && !existsSync(sessionPath(wanted)) ? wanted : newSessionId()
  saveSession(id, EventStore.fromJSON(events))
  return id
}

/** A transcript a person reads: prompts, answers, and the tools in between. */
export function sessionMarkdown(doc: SessionExport): string {
  const out: string[] = [`# ${doc.meta.title || doc.id}`, '', `Session \`${doc.id}\` · ${doc.meta.model || 'model unknown'} · ${new Date(doc.meta.startedAt).toLocaleString()}`, '']
  for (const event of doc.events) {
    if (event.type === 'user_message') out.push('## You', '', event.text, '')
    else if (event.type === 'assistant_message') {
      const text = event.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { text: string }).text)
        .join('\n')
        .trim()
      if (text) out.push('## Jean', '', text, '')
      const calls = event.content.filter((block) => block.type === 'tool_call')
      for (const block of calls) {
        if (block.type === 'tool_call') out.push(`- \`${block.name}\` ${summarize(block.input)}`)
      }
      if (calls.length > 0) out.push('')
    } else if (event.type === 'compaction') out.push('> *Earlier conversation summarized.*', '')
  }
  return `${out.join('\n').trim()}\n`
}

function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  const main = record.path ?? record.command ?? record.pattern ?? record.query ?? record.url ?? record.task
  return typeof main === 'string' ? `— ${main.split('\n')[0]!.slice(0, 100)}` : ''
}

/** Tokens, keys, and passwords that look like what they are. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(ant|or|proj)-[A-Za-z0-9_-]{8,}/g,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*["']?[^\s"']{6,}/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
]

function scrub(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[secret removed]')
  const home = homedir()
  if (home) out = out.split(home).join('~')
  return out
}

/** Every string inside a value, scrubbed; long ones — file contents — dropped. */
function scrubValue(value: unknown, keepLong = false): unknown {
  if (typeof value === 'string') return !keepLong && value.length > 400 ? `[${value.length} characters removed]` : scrub(value)
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, keepLong))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, scrubValue(inner, keepLong)]))
  }
  return value
}

/**
 * A session safe to hand to someone else: secrets and the home directory
 * scrubbed from everything said, what tools read or printed replaced by its
 * size, file contents written by the agent dropped, attached images removed.
 * The shape of the work — prompts, answers, which tools ran on what — stays.
 */
export function sanitizeEvents(events: JeanEvent[]): JeanEvent[] {
  return events.map((event): JeanEvent => {
    switch (event.type) {
      case 'session_start':
        return { ...event, cwd: scrub(event.cwd), title: event.title ? scrub(event.title) : undefined }
      case 'user_message':
        return { type: 'user_message', at: event.at, text: scrub(event.text) }
      case 'assistant_message':
        return {
          ...event,
          content: event.content
            .filter((block) => block.type !== 'image')
            .map((block) => {
              if (block.type === 'text') return { type: 'text' as const, text: scrub(block.text) }
              if (block.type === 'thinking') return { type: 'thinking' as const, text: scrub(block.text) }
              if (block.type === 'tool_call') return { ...block, input: scrubValue(block.input) }
              if (block.type === 'tool_result') return { ...block, output: `[${block.output.length} characters removed]` }
              return block
            }),
        }
      case 'tool_call':
        return { ...event, input: scrubValue(event.input) }
      case 'tool_result':
        return scrubValue({ ...event, output: `[${String((event as { output?: unknown }).output ?? '').length} characters removed]` }, true) as JeanEvent
      default:
        return scrubValue(event, true) as JeanEvent
    }
  })
}
