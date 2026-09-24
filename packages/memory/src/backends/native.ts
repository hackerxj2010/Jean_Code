import { existsSync } from 'node:fs'
import { callSync } from '@jean/native'
import type { Memory, MemoryBackend, MemoryKind, RecallOptions } from '../types.ts'

/**
 * The memory backend in `crates/pi-mnemopi`: an append-only log with BM25
 * recall, called in-process through `crates/pi-ffi`.
 *
 * Why it is the default rather than SQLite:
 *
 * * **A history, not a table.** An update writes a record that supersedes the
 *   old one; nothing is rewritten in place. When the agent believes something
 *   wrong, the log shows when it learned it — and what it believed before.
 * * **A text file.** A person can read it, grep it, and see it change in a
 *   diff. No binding to load, nothing to corrupt beyond a line.
 * * **No native module.** `bun:sqlite` and `better-sqlite3` are exactly the
 *   dependencies that fail to load on some machine; this one ships with Jean.
 *
 * The one visible difference: an update gets a new id, since it is a new
 * record. The interface allows that — `update` returns the memory it wrote.
 */

/** The TypeScript kinds and the crate's; only `preference` is spelled differently. */
const TO_CRATE: Record<MemoryKind, string> = {
  preference: 'user',
  feedback: 'feedback',
  project: 'project',
  pattern: 'pattern',
  reference: 'reference',
}
const FROM_CRATE: Record<string, MemoryKind> = {
  user: 'preference',
  feedback: 'feedback',
  project: 'project',
  pattern: 'pattern',
  reference: 'reference',
}

interface CrateMemory {
  id: number
  kind: string
  name: string
  description: string
  text: string
  /** Seconds since the epoch. */
  created: number
  project: string | null
  source: string | null
}

function toMemory(record: CrateMemory): Memory {
  const at = record.created * 1000
  return {
    id: record.id,
    kind: FROM_CRATE[record.kind] ?? 'project',
    text: record.text,
    source: record.source ?? undefined,
    project: record.project ?? undefined,
    createdAt: at,
    updatedAt: at,
    // The log records beliefs, not reads; recall frequency is not kept.
    uses: 0,
  }
}

/** A name unique enough that two memories never supersede each other by accident. */
function freshName(kind: MemoryKind): string {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** The first line, shortened: what the crate indexes as the memory's description. */
function describe(text: string): string {
  const first = text.trim().split('\n')[0] ?? ''
  return first.length > 120 ? `${first.slice(0, 117)}...` : first
}

export class NativeBackend implements MemoryBackend {
  readonly name = 'native'

  /**
   * Opens the log at `path`. Throws when the Rust core is not available, which
   * `openMemory` takes as the signal to use SQLite instead.
   */
  constructor(readonly path: string) {
    callSync('memory.count', { path })
  }

  /** Whether the log already exists on disk. */
  static exists(path: string): boolean {
    return existsSync(path)
  }

  retain(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt' | 'uses'>): Memory {
    const written = callSync('memory.remember', {
      path: this.path,
      name: freshName(memory.kind),
      kind: TO_CRATE[memory.kind],
      description: describe(memory.text),
      text: memory.text,
      project: memory.project,
      source: memory.source,
    }) as CrateMemory
    return toMemory(written)
  }

  recall(query: string, options: RecallOptions = {}): Memory[] {
    if (!query.trim()) return this.recent(options)
    const hits = callSync('memory.recall', {
      path: this.path,
      query,
      limit: options.limit ?? 10,
      project: options.project,
      kind: options.kind ? TO_CRATE[options.kind] : undefined,
      // `project` here means "this project's memories", as in the SQLite
      // backend; `recallForPrompt` asks for the global ones separately.
      strict: options.project !== undefined,
    }) as CrateMemory[]
    return hits.map(toMemory)
  }

  recent(options: RecallOptions = {}): Memory[] {
    const listed = callSync('memory.list', {
      path: this.path,
      limit: options.limit ?? 10,
      project: options.project,
      kind: options.kind ? TO_CRATE[options.kind] : undefined,
      strict: options.project !== undefined,
    }) as CrateMemory[]
    return listed.map(toMemory)
  }

  get(id: number): Memory | undefined {
    const found = callSync('memory.get', { path: this.path, id }) as CrateMemory | null
    return found ? toMemory(found) : undefined
  }

  update(id: number, text: string): Memory | undefined {
    const written = callSync('memory.update', {
      path: this.path,
      id,
      text,
      description: describe(text),
    }) as CrateMemory | null
    return written ? toMemory(written) : undefined
  }

  forget(id: number): boolean {
    return callSync('memory.forget', { path: this.path, id }) as boolean
  }

  count(): number {
    return callSync('memory.count', { path: this.path }) as number
  }

  close(): void {
    // Nothing held open: every call reads the log and appends to it.
  }

  /**
   * Copies every memory from another backend, oldest first, so recency order
   * survives. For the one-time move from SQLite; returns how many were copied.
   */
  importFrom(source: MemoryBackend): number {
    const all = source.recent({ limit: 1_000_000 }).reverse()
    for (const memory of all) {
      this.retain({ kind: memory.kind, text: memory.text, project: memory.project, source: memory.source })
    }
    return all.length
  }
}
