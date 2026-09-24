/**
 * Memory system types (architecture §10).
 *
 * Memory is what makes the agent get better at *this* codebase over time
 * rather than starting cold every session. Everything is stored locally; none
 * of it leaves the machine.
 */

/**
 * What a memory is about. The kind drives recall weighting and how the memory
 * is rendered into the system prompt.
 */
export type MemoryKind =
  /** How the user works and what they prefer. */
  | 'preference'
  /** A correction or instruction the user gave about how to do the work. */
  | 'feedback'
  /** A durable fact about this project that is expensive to rediscover. */
  | 'project'
  /** A pattern learned from solving something hard. */
  | 'pattern'
  /** A pointer to an external resource. */
  | 'reference'

export const MEMORY_KINDS: MemoryKind[] = [
  'preference',
  'feedback',
  'project',
  'pattern',
  'reference',
]

export interface Memory {
  id: number
  kind: MemoryKind
  text: string
  /** Where it came from: a session id, a file, or the user directly. */
  source?: string
  /** Project root this belongs to. Absent means it applies everywhere. */
  project?: string
  createdAt: number
  updatedAt: number
  /** Times this memory has been recalled. Feeds pruning. */
  uses: number
}

export interface RecallOptions {
  limit?: number
  project?: string
  kind?: MemoryKind
}

/** What every backend implements. */
export interface MemoryBackend {
  readonly name: string
  retain(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt' | 'uses'>): Memory
  recall(query: string, options?: RecallOptions): Memory[]
  recent(options?: RecallOptions): Memory[]
  get(id: number): Memory | undefined
  update(id: number, text: string): Memory | undefined
  forget(id: number): boolean
  count(): number
  close(): void
}
