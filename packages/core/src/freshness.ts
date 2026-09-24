import { statSync } from 'node:fs'

/**
 * Notices files changing underneath the agent.
 *
 * The agent's picture of a file is whatever it last read or wrote. When the
 * user edits the same file in their editor, a formatter rewrites it, or a
 * build regenerates it, that picture is silently wrong — and the next edit is
 * built on it. Telling the model which files moved is cheap, and it turns a
 * confusing failed edit into a re-read.
 */
export class Freshness {
  private readonly seen = new Map<string, { mtimeMs: number; size: number }>()

  constructor(private readonly limit = 500) {}

  /** Records a file's current state as the one the agent knows. */
  observe(path: string): void {
    const stamp = stampOf(path)
    this.seen.delete(path) // re-insert so the map stays ordered by recency
    if (stamp) this.seen.set(path, stamp)
    if (this.seen.size > this.limit) {
      const oldest = this.seen.keys().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
  }

  /**
   * Files that changed since the agent last saw them, each reported once:
   * after reporting, the new state becomes the known one.
   */
  changed(): { path: string; deleted: boolean }[] {
    const out: { path: string; deleted: boolean }[] = []
    for (const [path, known] of this.seen) {
      const now = stampOf(path)
      if (!now) {
        out.push({ path, deleted: true })
        this.seen.delete(path)
      } else if (now.mtimeMs !== known.mtimeMs || now.size !== known.size) {
        out.push({ path, deleted: false })
        this.seen.set(path, now)
      }
    }
    return out
  }
}

function stampOf(path: string): { mtimeMs: number; size: number } | undefined {
  try {
    const info = statSync(path)
    return info.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : undefined
  } catch {
    return undefined
  }
}
