import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
      title: firstUser?.text.split('\n')[0]?.slice(0, 80) ?? '(no prompt)',
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
