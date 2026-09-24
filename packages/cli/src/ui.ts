/**
 * Terminal rendering.
 *
 * A line-based renderer rather than a full-screen TUI: it degrades correctly
 * when output is piped, when the terminal is narrow, and when NO_COLOR is set,
 * and it keeps scrollback intact — which matters more day to day than a
 * repainting interface. `@jean/tui2` is where the full-screen renderer lives.
 */

/**
 * The escape character, built from its code point.
 *
 * A literal escape byte in source is invisible, and editors, linters, and diff
 * tools all mangle it eventually. This costs nothing and cannot rot.
 */
const ESC = String.fromCharCode(27)
const RESET = `${ESC}[0m`
/** Erase from the cursor to the end of the line. */
const CLEAR_LINE = `${ESC}[K`

const NO_COLOR = Boolean(process.env.NO_COLOR) || !process.stdout.isTTY

function sgr(code: number, text: string): string {
  return NO_COLOR ? text : `${ESC}[${code}m${text}${RESET}`
}

export const color = {
  dim: (t: string) => sgr(2, t),
  bold: (t: string) => sgr(1, t),
  red: (t: string) => sgr(31, t),
  green: (t: string) => sgr(32, t),
  yellow: (t: string) => sgr(33, t),
  blue: (t: string) => sgr(34, t),
  magenta: (t: string) => sgr(35, t),
  cyan: (t: string) => sgr(36, t),
  gray: (t: string) => sgr(90, t),
}

export const symbols = {
  prompt: '›',
  bullet: '•',
  arrow: '→',
  check: '✓',
  cross: '✗',
  warn: '!',
  tool: '▫',
}

/**
 * Where line output goes.
 *
 * Normally stdout. The full-screen renderer owns the terminal while it runs, so
 * it redirects this into its own transcript — otherwise a slash command's
 * output would land underneath the frame being painted and vanish on the next
 * flush.
 */
let sink: ((text: string) => void) | undefined

export function setOutputSink(fn?: (text: string) => void): void {
  sink = fn
}

export function write(text: string): void {
  if (sink) {
    sink(text.replace(/\n$/, ''))
    return
  }
  process.stdout.write(text)
}

export function line(text = ''): void {
  if (sink) {
    sink(text)
    return
  }
  process.stdout.write(`${text}\n`)
}

export function errorLine(text: string): void {
  process.stderr.write(`${text}\n`)
}

/** Terminal width, clamped to something readable. */
export function width(): number {
  return Math.min(Math.max(process.stdout.columns ?? 80, 40), 120)
}

/** Wraps text to the terminal width, preserving existing newlines and indent. */
export function wrapText(text: string, indent = 0): string {
  const limit = width() - indent
  const pad = ' '.repeat(indent)
  const out: string[] = []

  for (const paragraph of text.split('\n')) {
    if (paragraph.length <= limit) {
      out.push(pad + paragraph)
      continue
    }
    let current = ''
    for (const word of paragraph.split(' ')) {
      if (current && current.length + word.length + 1 > limit) {
        out.push(pad + current)
        current = word
      } else {
        current = current ? `${current} ${word}` : word
      }
    }
    if (current) out.push(pad + current)
  }

  return out.join('\n')
}

/**
 * A spinner that stays quiet when it cannot draw.
 *
 * Piped output and non-TTY terminals get nothing rather than a stream of
 * escape sequences in a log file.
 */
export class Spinner {
  private static readonly FRAMES = [
    '⠋',
    '⠙',
    '⠹',
    '⠸',
    '⠼',
    '⠴',
    '⠦',
    '⠧',
    '⠇',
    '⠏',
  ]
  private timer?: ReturnType<typeof setInterval>
  private frame = 0
  private text = ''
  private readonly enabled: boolean

  constructor(enabled = true) {
    this.enabled = enabled && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
  }

  start(text: string): void {
    this.text = text
    if (!this.enabled || this.timer) return
    this.timer = setInterval(() => {
      const frame = Spinner.FRAMES[this.frame++ % Spinner.FRAMES.length]!
      // Truncated to one terminal line. `\r` only returns to the start of the
      // *current* line, so a spinner message long enough to wrap leaves every
      // earlier row on screen and redraws below it — the frame appears to print
      // the whole command over and over.
      process.stdout.write(`\r${color.cyan(frame)} ${color.dim(this.fit(this.text))}${CLEAR_LINE}`)
    }, 80)
  }

  update(text: string): void {
    this.text = text
  }

  private fit(text: string): string {
    return clipToWidth(text, 3)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    if (this.enabled) process.stdout.write(`\r${CLEAR_LINE}`)
  }
}

/** Renders a line-level diff of a file edit for the tool card. */
export function renderDiff(before: string, after: string, maxLines = 30): string {
  const a = before.split('\n')
  const b = after.split('\n')
  const out: string[] = []

  // A line-level LCS is enough here: this is a summary for a human skimming a
  // tool card, not a patch anyone will apply.
  const common = longestCommonSubsequence(a, b)
  let i = 0
  let j = 0
  let changed = 0

  const emit = (text: string) => {
    changed++
    if (changed <= maxLines) out.push(text)
  }

  for (const point of [...common, { ai: a.length, bi: b.length }]) {
    while (i < point.ai) emit(color.red(`- ${a[i++]}`))
    while (j < point.bi) emit(color.green(`+ ${b[j++]}`))
    if (point.ai < a.length) {
      i++
      j++
    }
  }

  if (changed > maxLines) out.push(color.dim(`  ... ${changed - maxLines} more changed lines`))
  if (changed === 0) return color.dim('  (no textual change)')
  return out.join('\n')
}

function longestCommonSubsequence(a: string[], b: string[]): { ai: number; bi: number }[] {
  // The quadratic table is fine for a tool card and disastrous for a large
  // file, so oversized inputs render as "everything changed" instead.
  if (a.length > 2000 || b.length > 2000) return []

  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }

  const out: { ai: number; bi: number }[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ ai: i, bi: j })
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i++
    } else {
      j++
    }
  }
  return out
}

/** Formats a duration for tool cards. */
export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/** Formats a USD cost, or an empty string when it rounds to nothing. */
export function cost(usd: number): string {
  if (usd <= 0) return ''
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
}

/**
 * Clips text to a single terminal line, flattening any newlines.
 *
 * Used for status lines that must occupy exactly one row. A spinner redraws
 * with `\r`, which only returns to the start of the current line — so text that
 * wraps leaves its earlier rows on screen and the frame appears to reprint the
 * whole command on every tick.
 *
 * `reserve` is the number of columns already spent on a prefix (a spinner frame,
 * a status mark) plus one to stay clear of the final column, where some
 * terminals wrap eagerly.
 */
export function clipToWidth(text: string, reserve = 0): string {
  const flat = text.replace(/\s*\n\s*/g, ' ')
  const room = Math.max(10, (process.stdout.columns ?? 80) - reserve)
  return flat.length <= room ? flat : `${flat.slice(0, room - 1)}…`
}
