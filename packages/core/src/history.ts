import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Automatic per-turn file history, for `/rewind` and `/undo`.
 *
 * Before the agent first changes a file in a turn, the file's content is kept.
 * Rewinding a turn puts every file it touched back exactly as it was — created
 * files are removed, deleted ones restored — so "undo what you just did" is
 * one command rather than a request for the model to write more edits, which
 * compounds whatever went wrong.
 *
 * Unlike an explicit checkpoint, this costs nothing until a file is changed,
 * and then only that file. What it does not see: changes made by commands the
 * agent ran through the shell. Those are the user's to review with git.
 */

interface Turn {
  /** Event-store length when the turn began: rewinding truncates to here. */
  eventIndex: number
  prompt: string
  /** Content before the turn's first change; `null` means it did not exist. */
  files: Map<string, Buffer | null>
}

export interface RewindResult {
  /** Event-store length to truncate to. */
  eventIndex: number
  /** The prompt of the earliest rewound turn, to put back in the input box. */
  prompt: string
  restored: string[]
  removed: string[]
  turns: number
}

export class FileHistory {
  private readonly stack: Turn[] = []

  constructor(private readonly maxTurns = 100) {}

  beginTurn(eventIndex: number, prompt: string): void {
    this.stack.push({ eventIndex, prompt, files: new Map() })
    if (this.stack.length > this.maxTurns) this.stack.shift()
  }

  /** Records a file's content before its first change this turn. */
  capture(path: string): void {
    const turn = this.stack[this.stack.length - 1]
    if (!turn || turn.files.has(path)) return
    let content: Buffer | null = null
    try {
      if (statSync(path).isFile()) content = readFileSync(path)
    } catch {
      content = null // did not exist: rewinding removes it
    }
    turn.files.set(path, content)
  }

  /** The turns that can be rewound, newest last. */
  turns(): { prompt: string; files: number }[] {
    return this.stack.map((t) => ({ prompt: t.prompt, files: t.files.size }))
  }

  /**
   * Restores the files of the last `steps` turns and forgets those turns.
   *
   * Turns are undone newest first, so a file changed in several of them ends
   * at its content before the earliest.
   */
  rewind(steps = 1): RewindResult | undefined {
    if (this.stack.length === 0) return undefined
    const count = Math.min(Math.max(1, steps), this.stack.length)
    const undone = this.stack.splice(this.stack.length - count, count).reverse()

    const restored = new Set<string>()
    const removed = new Set<string>()
    for (const turn of undone) {
      for (const [path, content] of turn.files) {
        if (content === null) {
          rmSync(path, { force: true })
          removed.add(path)
          restored.delete(path)
        } else {
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, content)
          restored.add(path)
          removed.delete(path)
        }
      }
    }

    const earliest = undone[undone.length - 1]!
    return {
      eventIndex: earliest.eventIndex,
      prompt: earliest.prompt,
      restored: [...restored],
      removed: [...removed],
      turns: count,
    }
  }
}
