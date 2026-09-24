/**
 * `@jean/scheduler` — cron, one-off, and trigger-based runs (architecture §21).
 *
 * The cron parser and next-fire calculation live here; [`Daemon`] fires them.
 *
 * The daemon polls a persisted `nextRunAt` rather than holding a timer per
 * schedule. Timers drift across a laptop suspend and have to be rebuilt on
 * every edit; polling persisted state is correct across both without special
 * cases, and survives the process being killed — which matters, because a
 * daemon that forgets what it was waiting for is worse than no daemon, since
 * the user believes it is running.
 */

export type ScheduleKind = 'cron' | 'once' | 'trigger' | 'always-on'

export interface Schedule {
  id: string
  kind: ScheduleKind
  /** A cron expression, an ISO timestamp, or a trigger name, by kind. */
  when: string
  prompt: string
  cwd: string
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  nextRunAt?: number
}

/** A parsed 5-field cron expression, expanded to the values each field allows. */
export interface CronFields {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

const FIELDS: [keyof CronFields, number, number][] = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['dayOfMonth', 1, 31],
  ['month', 1, 12],
  ['dayOfWeek', 0, 6],
]

/**
 * Parses a standard 5-field cron expression.
 *
 * Supports `*`, `a-b` ranges, `a,b,c` lists, and `/n` steps — which covers
 * essentially every schedule anyone writes by hand.
 */
export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(
      `a cron expression needs 5 fields (minute hour day-of-month month day-of-week); "${expression}" has ${parts.length}`,
    )
  }

  const fields = {} as CronFields
  for (const [index, [name, min, max]] of FIELDS.entries()) {
    fields[name] = parseField(parts[index]!, min, max, name)
  }
  return fields
}

function parseField(field: string, min: number, max: number, name: string): number[] {
  const values = new Set<number>()

  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid step "${stepText}" in the ${name} field`)
    }

    let from = min
    let to = max

    if (range !== undefined && range !== '*' && range !== '') {
      const [low, high] = range.split('-')
      from = Number(low)
      to = high === undefined ? from : Number(high)

      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        throw new Error(`"${range}" is not a valid ${name} value`)
      }
      if (from < min || to > max || from > to) {
        throw new Error(`${name} must be between ${min} and ${max}; got "${range}"`)
      }
      // `5/10` means "from 5 onward, every 10" — not just the single value 5.
      if (high === undefined && stepText !== undefined) to = max
    }

    for (let value = from; value <= to; value += step) values.add(value)
  }

  return [...values].sort((a, b) => a - b)
}

/**
 * The next time an expression fires, at or after `from`.
 *
 * Scans forward a minute at a time. Four years of minutes bounds the search and
 * covers every expression that can ever fire, February 29 included.
 */
export function nextRun(expression: string, from: Date = new Date()): Date {
  const fields = parseCron(expression)

  const candidate = new Date(from)
  candidate.setSeconds(0, 0)
  candidate.setMinutes(candidate.getMinutes() + 1)

  const limit = 366 * 4 * 24 * 60
  for (let i = 0; i < limit; i++) {
    if (
      fields.minute.includes(candidate.getMinutes()) &&
      fields.hour.includes(candidate.getHours()) &&
      fields.dayOfMonth.includes(candidate.getDate()) &&
      fields.month.includes(candidate.getMonth() + 1) &&
      fields.dayOfWeek.includes(candidate.getDay())
    ) {
      return candidate
    }
    candidate.setMinutes(candidate.getMinutes() + 1)
  }

  throw new Error(`"${expression}" never fires`)
}

/** Validates a schedule and computes when it would next run. */
export function describeSchedule(schedule: Schedule): { valid: boolean; detail: string } {
  try {
    switch (schedule.kind) {
      case 'cron': {
        const next = nextRun(schedule.when)
        return { valid: true, detail: `next run ${next.toLocaleString()}` }
      }
      case 'once': {
        const at = new Date(schedule.when)
        if (Number.isNaN(at.getTime())) throw new Error(`"${schedule.when}" is not a timestamp`)
        return {
          valid: true,
          detail: at.getTime() < Date.now() ? 'already past' : `runs at ${at.toLocaleString()}`,
        }
      }
      case 'trigger':
        return { valid: true, detail: `fires on "${schedule.when}"` }
      case 'always-on':
        return { valid: true, detail: 'runs continuously' }
    }
  } catch (err) {
    return { valid: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

export {
  Daemon,
  ScheduleStore,
  type DaemonOptions,
  type ScheduleRun,
} from './daemon.ts'
