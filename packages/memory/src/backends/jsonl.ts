import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Memory, MemoryBackend, RecallOptions } from '../types.ts'

/**
 * Newline-delimited JSON memory backend.
 *
 * The fallback when no SQLite binding is available, and a reasonable choice in
 * its own right: the file is human-readable, diffable, and trivially synced
 * between machines. Recall is a scored scan rather than an index, which is fine
 * at the scale a personal memory store actually reaches.
 */
export class JsonlBackend implements MemoryBackend {
  readonly name = 'jsonl'
  private memories: Memory[] = []
  private nextId = 1

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path)) this.load()
  }

  private load(): void {
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const memory = JSON.parse(line) as Memory
        // A later line for the same id supersedes an earlier one: that is how
        // updates are represented in an append-only file.
        const existing = this.memories.findIndex((m) => m.id === memory.id)
        if (existing >= 0) this.memories[existing] = memory
        else this.memories.push(memory)
        this.nextId = Math.max(this.nextId, memory.id + 1)
      } catch {
        // Skip a corrupt line rather than losing the whole store.
      }
    }
  }

  retain(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt' | 'uses'>): Memory {
    const now = Date.now()
    const full: Memory = { ...memory, id: this.nextId++, createdAt: now, updatedAt: now, uses: 0 }
    this.memories.push(full)
    appendFileSync(this.path, `${JSON.stringify(full)}\n`, 'utf8')
    return full
  }

  /** Scores by term overlap and recency — the same ordering FTS5 produces. */
  recall(query: string, options: RecallOptions = {}): Memory[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 2)
    if (terms.length === 0) return this.recent(options)

    const now = Date.now()
    const scored = this.filtered(options)
      .map((memory) => {
        const text = memory.text.toLowerCase()
        const hits = terms.filter((t) => text.includes(t)).length
        if (hits === 0) return undefined
        const ageDays = (now - memory.updatedAt) / 86_400_000
        return { memory, score: hits / terms.length + 2 / (1 + ageDays / 30) }
      })
      .filter((s): s is { memory: Memory; score: number } => s !== undefined)

    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, options.limit ?? 10).map((s) => s.memory)
    for (const memory of top) memory.uses++
    return top
  }

  recent(options: RecallOptions = {}): Memory[] {
    return this.filtered(options)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, options.limit ?? 10)
  }

  private filtered(options: RecallOptions): Memory[] {
    return this.memories.filter(
      (m) =>
        (!options.project || m.project === options.project) &&
        (!options.kind || m.kind === options.kind),
    )
  }

  get(id: number): Memory | undefined {
    return this.memories.find((m) => m.id === id)
  }

  update(id: number, text: string): Memory | undefined {
    const memory = this.get(id)
    if (!memory) return undefined
    memory.text = text
    memory.updatedAt = Date.now()
    appendFileSync(this.path, `${JSON.stringify(memory)}\n`, 'utf8')
    return memory
  }

  forget(id: number): boolean {
    const index = this.memories.findIndex((m) => m.id === id)
    if (index < 0) return false
    this.memories.splice(index, 1)
    // A delete cannot be expressed by appending, so the file is rewritten.
    this.rewrite()
    return true
  }

  private rewrite(): void {
    writeFileSync(this.path, this.memories.map((m) => `${JSON.stringify(m)}\n`).join(''), 'utf8')
  }

  count(): number {
    return this.memories.length
  }

  close(): void {
    this.rewrite()
  }
}
