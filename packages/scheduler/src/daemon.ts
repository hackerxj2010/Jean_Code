import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { describeSchedule, nextRun, type Schedule } from './index.ts'

/**
 * The scheduler daemon (architecture §21).
 *
 * Fires schedules whose time has come. The design constraint that shapes
 * everything here: this process can be killed at any moment, so a schedule's
 * next fire time has to be derivable from persisted state rather than held in
 * a timer. A daemon that forgets what it was waiting for on restart is worse
 * than no daemon, because the user believes it is running.
 */

export interface ScheduleRun {
  scheduleId: string
  startedAt: number
  finishedAt?: number
  ok: boolean
  output?: string
  error?: string
}

export interface DaemonOptions {
  /** Where schedules and their history live. */
  storePath: string
  /** Runs one schedule's prompt and returns what the agent said. */
  run: (schedule: Schedule) => Promise<string>
  /** How often to check for due schedules. */
  tickMs?: number
  onLog?: (message: string) => void
  onError?: (message: string) => void
}

interface StoreShape {
  schedules: Schedule[]
  history: ScheduleRun[]
}

export class ScheduleStore {
  private data: StoreShape = { schedules: [], history: [] }

  constructor(private readonly path: string) {
    this.load()
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoreShape>
      this.data = { schedules: parsed.schedules ?? [], history: parsed.history ?? [] }
    } catch {
      // A corrupt store starts empty rather than stopping the daemon: the user
      // can re-add schedules, and refusing to start hides the problem behind a
      // process that simply is not there.
      this.data = { schedules: [], history: [] }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    // History is capped: an always-on schedule would otherwise grow this file
    // without bound until it is too large to parse.
    this.data.history = this.data.history.slice(-500)
    writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
  }

  add(schedule: Omit<Schedule, 'id' | 'createdAt'>): Schedule {
    const validation = describeSchedule({ ...schedule, id: 'probe', createdAt: 0 } as Schedule)
    if (!validation.valid) throw new Error(validation.detail)

    const created: Schedule = {
      ...schedule,
      id: `sch_${Math.random().toString(36).slice(2, 10)}`,
      createdAt: Date.now(),
      nextRunAt: schedule.kind === 'cron' ? nextRun(schedule.when).getTime() : undefined,
    }

    this.data.schedules.push(created)
    this.save()
    return created
  }

  remove(id: string): boolean {
    const before = this.data.schedules.length
    this.data.schedules = this.data.schedules.filter((s) => s.id !== id)
    if (this.data.schedules.length === before) return false
    this.save()
    return true
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const schedule = this.data.schedules.find((s) => s.id === id)
    if (!schedule) return false

    schedule.enabled = enabled
    // Re-armed from now, not from whenever it was disabled: a schedule paused
    // for a week should not fire seven times the moment it is re-enabled.
    if (enabled && schedule.kind === 'cron') {
      schedule.nextRunAt = nextRun(schedule.when).getTime()
    }
    this.save()
    return true
  }

  all(): Schedule[] {
    return [...this.data.schedules]
  }

  get(id: string): Schedule | undefined {
    return this.data.schedules.find((s) => s.id === id)
  }

  history(scheduleId?: string, limit = 20): ScheduleRun[] {
    const runs = scheduleId
      ? this.data.history.filter((r) => r.scheduleId === scheduleId)
      : this.data.history
    return runs.slice(-limit).reverse()
  }

  recordRun(run: ScheduleRun): void {
    this.data.history.push(run)
    this.save()
  }

  /**
   * Marks a schedule as fired and computes its next time.
   *
   * A `once` schedule disables itself rather than being deleted, so the user
   * can see it ran and read its output.
   */
  markFired(id: string): void {
    const schedule = this.data.schedules.find((s) => s.id === id)
    if (!schedule) return

    schedule.lastRunAt = Date.now()
    if (schedule.kind === 'cron') {
      schedule.nextRunAt = nextRun(schedule.when).getTime()
    } else if (schedule.kind === 'once') {
      schedule.enabled = false
      schedule.nextRunAt = undefined
    }
    this.save()
  }

  /** Schedules due at `now`. */
  due(now = Date.now()): Schedule[] {
    return this.data.schedules.filter((schedule) => {
      if (!schedule.enabled) return false

      switch (schedule.kind) {
        case 'cron':
          return schedule.nextRunAt !== undefined && schedule.nextRunAt <= now
        case 'once': {
          const at = new Date(schedule.when).getTime()
          return !Number.isNaN(at) && at <= now && !schedule.lastRunAt
        }
        case 'always-on':
          // Restarted whenever it is not currently running, which `Daemon`
          // tracks; the store only reports eligibility.
          return true
        case 'trigger':
          // Fired by `Daemon.fireTrigger`, not by the clock.
          return false
      }
    })
  }
}

export class Daemon {
  private readonly options: DaemonOptions
  private readonly store: ScheduleStore
  private timer?: ReturnType<typeof setInterval>
  /** Schedules currently executing, so a slow run is not started twice. */
  private readonly running = new Set<string>()
  private stopped = true

  constructor(options: DaemonOptions) {
    this.options = options
    this.store = new ScheduleStore(options.storePath)
  }

  get schedules(): ScheduleStore {
    return this.store
  }

  /**
   * Starts ticking.
   *
   * The tick is a poll rather than a per-schedule timer. A timer array would
   * drift across a laptop suspend and would have to be rebuilt on every edit;
   * polling a persisted `nextRunAt` is correct across both without special
   * cases.
   */
  start(): void {
    if (!this.stopped) return
    this.stopped = false

    const tick = this.options.tickMs ?? 30_000
    this.timer = setInterval(() => void this.tick(), tick)
    this.timer.unref?.()
    void this.tick()

    this.options.onLog?.(`scheduler started, ticking every ${Math.round(tick / 1000)}s`)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  get isRunning(): boolean {
    return !this.stopped
  }

  /** Runs one pass over due schedules. Exposed for tests. */
  async tick(now = Date.now()): Promise<number> {
    if (this.stopped) return 0

    const due = this.store.due(now).filter((schedule) => !this.running.has(schedule.id))
    for (const schedule of due) void this.execute(schedule)
    return due.length
  }

  /** Fires every schedule watching a named trigger. */
  async fireTrigger(name: string): Promise<number> {
    const matching = this.store
      .all()
      .filter((s) => s.kind === 'trigger' && s.enabled && s.when === name)
      .filter((s) => !this.running.has(s.id))

    for (const schedule of matching) void this.execute(schedule)
    return matching.length
  }

  private async execute(schedule: Schedule): Promise<void> {
    this.running.add(schedule.id)
    const run: ScheduleRun = { scheduleId: schedule.id, startedAt: Date.now(), ok: false }

    try {
      this.options.onLog?.(`running ${schedule.id}: ${schedule.prompt.slice(0, 60)}`)
      const output = await this.options.run(schedule)
      run.ok = true
      run.output = output.slice(0, 4000)
    } catch (err) {
      run.error = err instanceof Error ? err.message : String(err)
      this.options.onError?.(`${schedule.id} failed: ${run.error}`)
    } finally {
      run.finishedAt = Date.now()
      this.store.recordRun(run)
      // Marked fired whether or not it succeeded: a schedule that retries on
      // every tick because it keeps failing is a runaway.
      this.store.markFired(schedule.id)
      this.running.delete(schedule.id)
    }
  }

  /** Schedules currently executing. */
  active(): string[] {
    return [...this.running]
  }
}
