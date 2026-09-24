import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { jeanHome, resolvePath, type JeanConfig } from '@jean/config'
import { JsonlBackend } from './backends/jsonl.ts'
import { NativeBackend } from './backends/native.ts'
import { SqliteBackend } from './backends/sqlite.ts'
import type { Memory, MemoryBackend, MemoryKind, RecallOptions } from './types.ts'

/**
 * `@jean/memory` — persistent memory across sessions (architecture §10).
 *
 * Four operations: `retain` stores a fact, `recall` finds relevant ones,
 * `learn` extracts facts worth keeping from a session, and `reflect` prunes
 * what stopped being true. Everything is local; nothing is uploaded.
 */

export * from './types.ts'
export { JsonlBackend } from './backends/jsonl.ts'
export { NativeBackend } from './backends/native.ts'
export { SqliteBackend, toFtsQuery } from './backends/sqlite.ts'

/**
 * Opens the configured backend.
 *
 * The `pi-mnemopi` log first, then SQLite, then JSONL: a missing binding must not stop the agent from
 * starting — memory is an enhancement, not a prerequisite — so a failure falls
 * back to JSONL and says so.
 */
export function openMemory(config: JeanConfig): {
  backend: MemoryBackend
  warning?: string
} {
  const backend = config.memory.backend ?? 'native'
  if (backend === 'none') {
    return { backend: new NullBackend() }
  }

  // `resolvePath`, not the raw value: a configured path is very often written
  // as `~/.jean/memory.db`, and using that literally creates a directory
  // actually named `~` in whatever the working directory happens to be.
  const path = config.memory.path
    ? resolvePath(config.memory.path)
    : join(jeanHome(), 'memory.db')

  if (backend === 'jsonl') {
    return { backend: new JsonlBackend(path.replace(/\.db$/, '.jsonl')) }
  }

  // The Rust log (`pi-mnemopi`) is the default. Without the Rust core it
  // cannot open, and SQLite below takes over — silently, since SQLite is a
  // perfectly good store and `jean doctor` names whichever is in use.
  if (backend === 'native') {
    const logPath = `${path.replace(/\.db$/, '')}.log`
    try {
      const fresh = !NativeBackend.exists(logPath)
      const native = new NativeBackend(logPath)
      // Memories kept in SQLite before the log was the default come across
      // the first time it opens, so switching loses nothing.
      if (fresh && existsSync(path)) {
        try {
          const previous = new SqliteBackend(path)
          native.importFrom(previous)
          previous.close()
        } catch {
          // An unreadable old store is not a reason to refuse the new one.
        }
      }
      return { backend: native }
    } catch {
      // Not built, or disabled: fall through to SQLite.
    }
  }

  try {
    return { backend: new SqliteBackend(path) }
  } catch (err) {
    const jsonlPath = path.replace(/\.db$/, '.jsonl')
    return {
      backend: new JsonlBackend(jsonlPath),
      warning: `SQLite memory is unavailable (${err instanceof Error ? err.message : String(err)}); using ${jsonlPath} instead.`,
    }
  }
}

/** A backend that stores nothing, for `memory.backend: "none"`. */
export class NullBackend implements MemoryBackend {
  readonly name = 'none'
  retain(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt' | 'uses'>): Memory {
    const now = Date.now()
    return { ...memory, id: 0, createdAt: now, updatedAt: now, uses: 0 }
  }
  recall(): Memory[] {
    return []
  }
  recent(): Memory[] {
    return []
  }
  get(): undefined {
    return undefined
  }
  update(): undefined {
    return undefined
  }
  forget(): boolean {
    return false
  }
  count(): number {
    return 0
  }
  close(): void {}
}

/**
 * Renders memories for the system prompt.
 *
 * Kind-prefixed so the model can weigh them: a stated preference is binding,
 * a learned pattern is a hint.
 */
export function renderMemories(memories: Memory[]): string[] {
  return memories.map((memory) => {
    const label =
      memory.kind === 'feedback'
        ? 'Instruction'
        : memory.kind === 'preference'
          ? 'Preference'
          : memory.kind === 'project'
            ? 'Project fact'
            : memory.kind === 'pattern'
              ? 'Pattern'
              : 'Reference'
    return `${label}: ${memory.text}`
  })
}

/**
 * Recalls memories relevant to a prompt, scoped to this project first.
 *
 * Project-scoped memories are always more relevant than global ones for a
 * coding task, so they are queried separately and placed first rather than
 * competing on raw relevance score.
 */
export function recallForPrompt(
  backend: MemoryBackend,
  prompt: string,
  project: string,
  limit: number,
): Memory[] {
  const scoped = backend.recall(prompt, { project, limit })
  if (scoped.length >= limit) return scoped

  const global = backend
    .recall(prompt, { limit: limit - scoped.length })
    .filter((m) => !m.project && !scoped.some((s) => s.id === m.id))

  return [...scoped, ...global]
}

/** Stores a fact, defaulting the project scope to the current directory. */
export function retain(
  backend: MemoryBackend,
  kind: MemoryKind,
  text: string,
  options: { project?: string; source?: string } = {},
): Memory {
  return backend.retain({
    kind,
    text: text.trim(),
    project: options.project,
    source: options.source,
  })
}

export type { Memory, MemoryBackend, MemoryKind, RecallOptions }
