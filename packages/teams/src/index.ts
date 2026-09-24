import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/**
 * `@jean/teams` — the shared state a team of agents coordinates through
 * (architecture §11).
 *
 * Two structures do the work: a task list teammates claim from, and a mailbox
 * they message each other through. Both live on disk as JSON so teammates in
 * separate processes — or separate terminal panes — see the same state.
 *
 * Concurrency is handled with an exclusive-create lock file rather than an
 * in-process mutex, for exactly that reason: the writers are not in the same
 * process.
 */

export type TaskStatus = 'pending' | 'claimed' | 'in_progress' | 'completed' | 'blocked'

export interface Task {
  id: string
  title: string
  description?: string
  status: TaskStatus
  /** Teammate that claimed it. */
  owner?: string
  /** Task ids that must complete before this one can start. */
  dependsOn: string[]
  /** Files this task owns, so two teammates never edit the same one. */
  files: string[]
  createdAt: number
  updatedAt: number
  result?: string
}

export interface Message {
  id: string
  from: string
  /** A teammate name, or `*` to broadcast. */
  to: string
  text: string
  at: number
  read: boolean
}

/**
 * A cross-process lock built on exclusive file creation, which is atomic on
 * every filesystem that matters.
 *
 * The stale-lock timeout exists because a teammate can be killed while holding
 * the lock; without it, one crash would wedge the whole team permanently.
 */
export class FileLock {
  private static readonly STALE_MS = 30_000
  private static readonly RETRY_MS = 25

  constructor(private readonly path: string) {}

  async acquire(timeoutMs = 5000): Promise<() => void> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      try {
        // `wx` fails if the file exists — that is the atomic test-and-set.
        const fd = openSync(this.path, 'wx')
        writeFileSync(this.path, String(process.pid), 'utf8')
        closeSync(fd)
        return () => {
          try {
            rmSync(this.path, { force: true })
          } catch {
            // Already released.
          }
        }
      } catch {
        if (this.isStale()) {
          try {
            rmSync(this.path, { force: true })
          } catch {
            // Another process cleaned it up first; loop and retry.
          }
          continue
        }
        await sleep(FileLock.RETRY_MS)
      }
    }

    throw new Error(`could not acquire ${this.path} within ${timeoutMs}ms`)
  }

  private isStale(): boolean {
    try {
      const age = Date.now() - Number(readFileSync(`${this.path}.at`, 'utf8'))
      return age > FileLock.STALE_MS
    } catch {
      // No timestamp file: fall back to the lock file's own mtime.
      try {
        const { mtimeMs } = require('node:fs').statSync(this.path)
        return Date.now() - mtimeMs > FileLock.STALE_MS
      } catch {
        return false
      }
    }
  }
}

/** The shared task list. */
export class TaskList {
  private readonly file: string
  private readonly lock: FileLock

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'tasks.json')
    this.lock = new FileLock(join(dir, 'tasks.lock'))
  }

  read(): Task[] {
    if (!existsSync(this.file)) return []
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Task[]
    } catch {
      return []
    }
  }

  /** Reads, mutates, and writes under the lock. */
  private async transaction<T>(mutate: (tasks: Task[]) => T): Promise<T> {
    const release = await this.lock.acquire()
    try {
      const tasks = this.read()
      const result = mutate(tasks)
      // Write to a temp file and rename: a reader never sees a half-written list.
      const temp = `${this.file}.tmp`
      writeFileSync(temp, JSON.stringify(tasks, null, 2), 'utf8')
      renameSync(temp, this.file)
      return result
    } finally {
      release()
    }
  }

  async add(
    task: Omit<Task, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'dependsOn' | 'files'> &
      Partial<Pick<Task, 'dependsOn' | 'files'>>,
  ): Promise<Task> {
    return this.transaction((tasks) => {
      const now = Date.now()
      const created: Task = {
        id: String(tasks.length + 1),
        title: task.title,
        description: task.description,
        status: 'pending',
        dependsOn: task.dependsOn ?? [],
        files: task.files ?? [],
        createdAt: now,
        updatedAt: now,
      }
      tasks.push(created)
      return created
    })
  }

  /**
   * Claims the next task a teammate can actually start.
   *
   * Atomic under the lock, which is what stops two teammates from claiming the
   * same task and doing the work twice.
   */
  async claim(owner: string): Promise<Task | undefined> {
    return this.transaction((tasks) => {
      const done = new Set(tasks.filter((t) => t.status === 'completed').map((t) => t.id))
      const ownedFiles = new Set(
        tasks.filter((t) => t.status === 'claimed' || t.status === 'in_progress').flatMap((t) => t.files),
      )

      const next = tasks.find(
        (task) =>
          task.status === 'pending' &&
          task.dependsOn.every((id) => done.has(id)) &&
          // Never hand out a task whose files another teammate is already in.
          !task.files.some((file) => ownedFiles.has(file)),
      )
      if (!next) return undefined

      next.status = 'claimed'
      next.owner = owner
      next.updatedAt = Date.now()
      return next
    })
  }

  async update(id: string, changes: Partial<Task>): Promise<Task | undefined> {
    return this.transaction((tasks) => {
      const task = tasks.find((t) => t.id === id)
      if (!task) return undefined
      Object.assign(task, changes, { updatedAt: Date.now() })
      return task
    })
  }

  async complete(id: string, result?: string): Promise<Task | undefined> {
    return this.update(id, { status: 'completed', result })
  }

  /** True when everything is done — the lead's signal to synthesize and stop. */
  isFinished(): boolean {
    const tasks = this.read()
    return tasks.length > 0 && tasks.every((t) => t.status === 'completed')
  }

  render(): string {
    const tasks = this.read()
    if (tasks.length === 0) return 'No tasks.'
    return tasks
      .map((task) => {
        const mark =
          task.status === 'completed'
            ? '[x]'
            : task.status === 'in_progress' || task.status === 'claimed'
              ? '[>]'
              : task.status === 'blocked'
                ? '[!]'
                : '[ ]'
        const owner = task.owner ? ` (${task.owner})` : ''
        return `${mark} ${task.id}. ${task.title}${owner}`
      })
      .join('\n')
  }
}

/** Direct messaging between teammates, without routing through the lead. */
export class Mailbox {
  private readonly file: string
  private readonly lock: FileLock

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'mailbox.json')
    this.lock = new FileLock(join(dir, 'mailbox.lock'))
  }

  private read(): Message[] {
    if (!existsSync(this.file)) return []
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Message[]
    } catch {
      return []
    }
  }

  private async write(mutate: (messages: Message[]) => void): Promise<void> {
    const release = await this.lock.acquire()
    try {
      const messages = this.read()
      mutate(messages)
      const temp = `${this.file}.tmp`
      writeFileSync(temp, JSON.stringify(messages, null, 2), 'utf8')
      renameSync(temp, this.file)
    } finally {
      release()
    }
  }

  async send(from: string, to: string, text: string): Promise<void> {
    await this.write((messages) => {
      messages.push({
        id: String(messages.length + 1),
        from,
        to,
        text,
        at: Date.now(),
        read: false,
      })
    })
  }

  /** Unread messages for `recipient`, marked read as they are handed over. */
  async inbox(recipient: string): Promise<Message[]> {
    let delivered: Message[] = []
    await this.write((messages) => {
      delivered = messages.filter((m) => !m.read && (m.to === recipient || m.to === '*'))
      for (const message of delivered) message.read = true
    })
    return delivered
  }
}

/** The on-disk home for one team's shared state. */
export function teamDirectory(cwd: string, teamId: string): string {
  return join(cwd, '.jean', 'teams', teamId)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
