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

/** A rewind that `/redo` can take back: the turns, and what they had left behind. */
interface Undone {
  turns: Turn[]
  /** Each touched file as the rewound turns left it; `null` means it did not exist. */
  after: Map<string, Buffer | null>
  /** The transcript the rewind cut off. */
  events: unknown[]
}

export interface RedoResult {
  turns: number
  prompt: string
  restored: string[]
  removed: string[]
  /** The transcript to put back, in order. */
  events: unknown[]
}

export class FileHistory {
  private readonly stack: Turn[] = []
  private readonly undone: Undone[] = []

  constructor(private readonly maxTurns = 100) {}

  beginTurn(eventIndex: number, prompt: string): void {
    this.stack.push({ eventIndex, prompt, files: new Map() })
    if (this.stack.length > this.maxTurns) this.stack.shift()
    // A new turn is a new direction: what was undone before it is gone.
    this.undone.length = 0
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

    // What the turns left behind, kept before it is overwritten, so `redo`
    // can put it back exactly.
    const after = new Map<string, Buffer | null>()
    for (const turn of undone) {
      for (const path of turn.files.keys()) {
        if (after.has(path)) continue
        try {
          after.set(path, statSync(path).isFile() ? readFileSync(path) : null)
        } catch {
          after.set(path, null)
        }
      }
    }
    this.undone.push({ turns: [...undone].reverse(), after, events: [] })

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

  /** Keeps the transcript the last rewind cut off, for `redo` to restore. */
  rememberRewound(events: unknown[]): void {
    const last = this.undone[this.undone.length - 1]
    if (last) last.events = events
  }

  /** How many rewinds can be taken back. */
  redoable(): number {
    return this.undone.length
  }

  /**
   * Takes back the last rewind: every file as those turns had left it, and
   * the turns rewindable again. The caller puts the transcript back.
   */
  redo(): RedoResult | undefined {
    const entry = this.undone.pop()
    if (!entry) return undefined
    const restored: string[] = []
    const removed: string[] = []
    for (const [path, content] of entry.after) {
      if (content === null) {
        rmSync(path, { force: true })
        removed.push(path)
      } else {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, content)
        restored.push(path)
      }
    }
    this.stack.push(...entry.turns)
    return {
      turns: entry.turns.length,
      prompt: entry.turns[0]?.prompt ?? '',
      restored,
      removed,
      events: entry.events,
    }
  }
}
