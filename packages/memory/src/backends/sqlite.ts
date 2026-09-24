import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Memory, MemoryBackend, MemoryKind, RecallOptions } from '../types.ts'

/**
 * SQLite memory backend with FTS5 recall (architecture §10.2).
 *
 * Bun and Node ship different SQLite bindings — `bun:sqlite` and `node:sqlite`
 * — with the same shape but different import paths. [`openDatabase`] resolves
 * whichever is present at runtime, so one implementation serves both and the
 * CLI does not care which runtime started it.
 */

/** The subset of both bindings this backend uses. */
interface Db {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    get?(...params: unknown[]): unknown
  }
  close(): void
}

/** Opens a database with whichever binding the runtime provides. */
export function openDatabase(path: string): Db {
  mkdirSync(dirname(path), { recursive: true })

  // Bun first: when running under Bun, `node:sqlite` is not available.
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
  if (isBun) {
    const { Database } = require('bun:sqlite') as { Database: new (p: string) => Db }
    return new Database(path)
  }

  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (p: string) => Db
  }
  return new DatabaseSync(path)
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  source     TEXT,
  project    TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  uses       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS memories_kind    ON memories(kind);

-- FTS5 mirror of the text column. Kept in sync by triggers so a write to
-- \`memories\` can never leave the index stale.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text,
  content = 'memories',
  content_rowid = 'id',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;
`

interface Row {
  id: number
  kind: string
  text: string
  source: string | null
  project: string | null
  created_at: number
  updated_at: number
  uses: number
}

export class SqliteBackend implements MemoryBackend {
  readonly name = 'sqlite'
  private readonly db: Db

  constructor(path: string) {
    this.db = openDatabase(path)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
  }

  retain(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt' | 'uses'>): Memory {
    const now = Date.now()
    this.db
      .prepare(
        'INSERT INTO memories (kind, text, source, project, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(memory.kind, memory.text, memory.source ?? null, memory.project ?? null, now, now)

    const row = this.db
      .prepare('SELECT * FROM memories ORDER BY id DESC LIMIT 1')
      .all()[0] as Row
    return toMemory(row)
  }

  /**
   * Full-text recall, ranked by relevance and recency.
   *
   * FTS5's `bm25` is negated (lower is better), so it is flipped here and
   * blended with a recency term — a fact learned last week about this codebase
   * usually beats a better-matching one from six months ago.
   */
  recall(query: string, options: RecallOptions = {}): Memory[] {
    const limit = options.limit ?? 10
    const match = toFtsQuery(query)

    if (!match) return this.recent(options)

    const filters: string[] = []
    const params: unknown[] = [match]
    if (options.project) {
      filters.push('m.project = ?')
      params.push(options.project)
    }
    if (options.kind) {
      filters.push('m.kind = ?')
      params.push(options.kind)
    }
    const where = filters.length > 0 ? `AND ${filters.join(' AND ')}` : ''

    let rows: unknown[]
    try {
      rows = this.db
        .prepare(
          `SELECT m.*, bm25(memories_fts) AS rank
           FROM memories_fts
           JOIN memories m ON m.id = memories_fts.rowid
           WHERE memories_fts MATCH ? ${where}
           ORDER BY rank
           LIMIT ${Math.max(limit * 3, 30)}`,
        )
        .all(...params)
    } catch {
      // A query FTS5 cannot parse should degrade to substring search, not
      // throw in the middle of building a system prompt.
      return this.substringSearch(query, options)
    }

    const now = Date.now()
    const scored = (rows as (Row & { rank: number })[]).map((row) => {
      const relevance = -row.rank
      const ageDays = (now - row.updated_at) / 86_400_000
      const recency = 1 / (1 + ageDays / 30)
      return { row, score: relevance + recency * 2 }
    })

    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, limit).map((s) => toMemory(s.row))
    this.touch(top.map((m) => m.id))
    return top
  }

  private substringSearch(query: string, options: RecallOptions): Memory[] {
    const rows = this.db
      .prepare('SELECT * FROM memories WHERE text LIKE ? ORDER BY updated_at DESC LIMIT ?')
      .all(`%${query}%`, options.limit ?? 10) as Row[]
    return rows.map(toMemory)
  }

  recent(options: RecallOptions = {}): Memory[] {
    const filters: string[] = []
    const params: unknown[] = []
    if (options.project) {
      filters.push('project = ?')
      params.push(options.project)
    }
    if (options.kind) {
      filters.push('kind = ?')
      params.push(options.kind)
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, options.limit ?? 10) as Row[]
    return rows.map(toMemory)
  }

  get(id: number): Memory | undefined {
    const rows = this.db.prepare('SELECT * FROM memories WHERE id = ?').all(id) as Row[]
    return rows[0] ? toMemory(rows[0]) : undefined
  }

  update(id: number, text: string): Memory | undefined {
    this.db
      .prepare('UPDATE memories SET text = ?, updated_at = ? WHERE id = ?')
      .run(text, Date.now(), id)
    return this.get(id)
  }

  forget(id: number): boolean {
    const before = this.count()
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    return this.count() < before
  }

  count(): number {
    const rows = this.db.prepare('SELECT COUNT(*) AS n FROM memories').all() as { n: number }[]
    return rows[0]?.n ?? 0
  }

  /** Bumps the use counter, which feeds pruning decisions later. */
  private touch(ids: number[]): void {
    if (ids.length === 0) return
    const statement = this.db.prepare(
      'UPDATE memories SET uses = uses + 1 WHERE id = ?',
    )
    for (const id of ids) statement.run(id)
  }

  close(): void {
    this.db.close()
  }
}

/**
 * Turns a natural-language query into an FTS5 MATCH expression.
 *
 * FTS5's syntax has operators (`AND`, `NEAR`, `"`, `*`, `:`) that a user's
 * sentence will trip over. Tokenizing to bare words and OR-ing them is both
 * safe and closer to what recall should do: find memories about *any* of these
 * things, ranked.
 */
export function toFtsQuery(query: string): string | undefined {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 12)
  if (words.length === 0) return undefined
  return words.map((w) => `"${w}"`).join(' OR ')
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'are', 'was', 'were', 'this', 'that', 'with',
  'from', 'have', 'has', 'not', 'but', 'can', 'what', 'when', 'why', 'how',
  'does', 'did', 'about', 'into', 'they', 'them', 'its', 'our', 'your',
])

function toMemory(row: Row): Memory {
  return {
    id: row.id,
    kind: row.kind as MemoryKind,
    text: row.text,
    source: row.source ?? undefined,
    project: row.project ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    uses: row.uses,
  }
}
