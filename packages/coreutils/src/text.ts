/**
 * Text-processing utilities (architecture §8.2).
 *
 * Every one is a pure function over strings. That is the point: running them
 * in-process removes a fork and an exec per pipeline stage, and — more usefully
 * — makes them behave identically on Windows, where `sed`, `awk`, and `tr` are
 * either absent or subtly different from the GNU versions everyone writes for.
 */

export interface UtilResult {
  stdout: string
  stderr: string
  exitCode: number
}

export function ok(stdout: string): UtilResult {
  return { stdout, stderr: '', exitCode: 0 }
}

export function fail(stderr: string, exitCode = 1): UtilResult {
  return { stdout: '', stderr, exitCode }
}

/** Splits into lines, dropping the trailing empty produced by a final newline. */
export function toLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Joins lines with a trailing newline, as every text utility emits. */
export function fromLines(lines: string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

// ---- head / tail ----------------------------------------------------------

export function head(text: string, count = 10, byBytes = false): UtilResult {
  if (byBytes) return ok(text.slice(0, count))
  return ok(fromLines(toLines(text).slice(0, count)))
}

export function tail(text: string, count = 10, byBytes = false): UtilResult {
  if (byBytes) return ok(text.slice(-count))
  const lines = toLines(text)
  return ok(fromLines(lines.slice(Math.max(0, lines.length - count))))
}

// ---- wc -------------------------------------------------------------------

export interface WcCounts {
  lines: number
  words: number
  bytes: number
  chars: number
}

export function wc(text: string): WcCounts {
  return {
    lines: toLines(text).length,
    words: text.split(/\s+/).filter(Boolean).length,
    // Bytes and characters differ for anything non-ASCII, and `wc -c` means bytes.
    bytes: Buffer.byteLength(text, 'utf8'),
    chars: [...text].length,
  }
}

// ---- sort / uniq ----------------------------------------------------------

export interface SortOptions {
  numeric?: boolean
  reverse?: boolean
  unique?: boolean
  ignoreCase?: boolean
  /** 1-based field to sort on, as `sort -k` counts. */
  key?: number
  separator?: string
}

export function sort(text: string, options: SortOptions = {}): UtilResult {
  const separator = options.separator ?? /\s+/
  let lines = toLines(text)

  const keyOf = (line: string): string => {
    if (!options.key) return line
    const fields = typeof separator === 'string' ? line.split(separator) : line.split(separator)
    return fields[options.key - 1] ?? ''
  }

  lines = [...lines].sort((a, b) => {
    let left = keyOf(a)
    let right = keyOf(b)
    if (options.ignoreCase) {
      left = left.toLowerCase()
      right = right.toLowerCase()
    }

    if (options.numeric) {
      // Non-numeric lines sort as zero, which is what GNU sort does.
      const na = Number.parseFloat(left) || 0
      const nb = Number.parseFloat(right) || 0
      return na - nb
    }
    // Plain code-unit comparison, not `localeCompare`: a pipeline's output must
    // not depend on the machine's locale.
    return left < right ? -1 : left > right ? 1 : 0
  })

  if (options.reverse) lines.reverse()
  if (options.unique) lines = lines.filter((line, i) => i === 0 || line !== lines[i - 1])

  return ok(fromLines(lines))
}

export interface UniqOptions {
  count?: boolean
  duplicatesOnly?: boolean
  uniqueOnly?: boolean
  ignoreCase?: boolean
}

/** `uniq` collapses *adjacent* duplicates only, exactly as the real one does. */
export function uniq(text: string, options: UniqOptions = {}): UtilResult {
  const lines = toLines(text)
  const groups: { line: string; count: number }[] = []

  for (const line of lines) {
    const previous = groups[groups.length - 1]
    const same = previous
      ? options.ignoreCase
        ? previous.line.toLowerCase() === line.toLowerCase()
        : previous.line === line
      : false

    if (same) previous!.count++
    else groups.push({ line, count: 1 })
  }

  let selected = groups
  if (options.duplicatesOnly) selected = groups.filter((g) => g.count > 1)
  if (options.uniqueOnly) selected = groups.filter((g) => g.count === 1)

  return ok(
    fromLines(
      selected.map((g) => (options.count ? `${String(g.count).padStart(7)} ${g.line}` : g.line)),
    ),
  )
}

// ---- cut / paste / join / comm --------------------------------------------

export interface CutOptions {
  /** 1-based field numbers. */
  fields?: number[]
  /** 1-based character positions. */
  characters?: number[]
  delimiter?: string
  outputDelimiter?: string
  /** Pass through lines with no delimiter, as `cut -s` inverts. */
  onlyDelimited?: boolean
}

export function cut(text: string, options: CutOptions): UtilResult {
  const delimiter = options.delimiter ?? '\t'
  const output = options.outputDelimiter ?? delimiter

  const lines = toLines(text).flatMap((line) => {
    if (options.characters) {
      return [options.characters.map((position) => line[position - 1] ?? '').join('')]
    }
    if (!options.fields) return [line]

    if (!line.includes(delimiter)) {
      // A line with no delimiter is passed through whole unless -s is set.
      return options.onlyDelimited ? [] : [line]
    }

    const fields = line.split(delimiter)
    return [options.fields.map((index) => fields[index - 1] ?? '').join(output)]
  })

  return ok(fromLines(lines))
}

/** `paste`: merges corresponding lines of several inputs. */
export function paste(inputs: string[], delimiter = '\t'): UtilResult {
  const columns = inputs.map(toLines)
  const height = Math.max(0, ...columns.map((c) => c.length))

  const rows: string[] = []
  for (let i = 0; i < height; i++) {
    rows.push(columns.map((column) => column[i] ?? '').join(delimiter))
  }
  return ok(fromLines(rows))
}

/** `join`: relational join of two sorted inputs on a shared field. */
export function join(
  left: string,
  right: string,
  options: { field1?: number; field2?: number; separator?: string } = {},
): UtilResult {
  const separator = options.separator ?? ' '
  const key1 = (options.field1 ?? 1) - 1
  const key2 = (options.field2 ?? 1) - 1

  const index = new Map<string, string[][]>()
  for (const line of toLines(right)) {
    const fields = line.split(separator)
    const key = fields[key2] ?? ''
    index.set(key, [...(index.get(key) ?? []), fields])
  }

  const out: string[] = []
  for (const line of toLines(left)) {
    const fields = line.split(separator)
    const key = fields[key1] ?? ''
    for (const match of index.get(key) ?? []) {
      // The join field first, then the rest of each side — GNU's output order.
      const rest1 = fields.filter((_, i) => i !== key1)
      const rest2 = match.filter((_, i) => i !== key2)
      out.push([key, ...rest1, ...rest2].join(separator))
    }
  }

  return ok(fromLines(out))
}

/** `comm`: which lines are unique to each sorted input, and which are shared. */
export function comm(
  left: string,
  right: string,
  suppress: { first?: boolean; second?: boolean; both?: boolean } = {},
): UtilResult {
  const a = toLines(left)
  const b = toLines(right)
  const inB = new Set(b)
  const inA = new Set(a)

  const out: string[] = []
  if (!suppress.first) for (const line of a) if (!inB.has(line)) out.push(line)
  if (!suppress.second) for (const line of b) if (!inA.has(line)) out.push(`\t${line}`)
  if (!suppress.both) for (const line of a) if (inB.has(line)) out.push(`\t\t${line}`)

  return ok(fromLines(out))
}

// ---- tr -------------------------------------------------------------------

/** Expands `a-z` ranges in a `tr` set. */
function expandSet(set: string): string {
  let out = ''
  for (let i = 0; i < set.length; i++) {
    if (set[i + 1] === '-' && set[i + 2]) {
      const start = set.charCodeAt(i)
      const end = set.charCodeAt(i + 2)
      for (let code = start; code <= end; code++) out += String.fromCharCode(code)
      i += 2
    } else {
      out += set[i]
    }
  }
  return out
}

export interface TrOptions {
  delete?: boolean
  squeeze?: boolean
  complement?: boolean
}

export function tr(text: string, from: string, to = '', options: TrOptions = {}): UtilResult {
  const source = expandSet(from)
  const target = expandSet(to)

  let out = ''
  for (const char of text) {
    const index = source.indexOf(char)
    const matched = options.complement ? index === -1 : index !== -1

    if (matched) {
      if (options.delete) continue
      // A short target set repeats its last character, as `tr` does.
      out += target[Math.min(index === -1 ? 0 : index, target.length - 1)] ?? char
    } else {
      out += char
    }
  }

  if (options.squeeze) {
    out = out.replace(/(.)\1+/g, (match, char: string) =>
      (options.complement ? !source.includes(char) : source.includes(char)) ? char : match,
    )
  }

  return ok(out)
}

// ---- sed ------------------------------------------------------------------

/**
 * A useful subset of `sed`: `s/pattern/replacement/flags`, `d`, and `p`.
 *
 * Not a full sed — the hold space and branching are not implemented, because
 * an agent that needs those is better served writing a script than composing a
 * sed program it cannot easily verify.
 */
export function sed(text: string, script: string): UtilResult {
  const substitute = /^s(.)(.*?[^\\])\1(.*?)\1([gip]*)$/.exec(script.trim())

  if (substitute) {
    const [, , pattern, replacement, flags] = substitute
    let regex: RegExp
    try {
      regex = new RegExp(pattern!, flags!.includes('g') ? 'g' : '')
    } catch (err) {
      return fail(`sed: invalid pattern: ${err instanceof Error ? err.message : String(err)}`)
    }
    // `\1` in sed is `$1` in JavaScript.
    const js = replacement!.replace(/\\(\d)/g, '$$$1')
    return ok(fromLines(toLines(text).map((line) => line.replace(regex, js))))
  }

  const del = /^\/(.*)\/d$/.exec(script.trim())
  if (del) {
    const regex = new RegExp(del[1]!)
    return ok(fromLines(toLines(text).filter((line) => !regex.test(line))))
  }

  const print = /^\/(.*)\/p$/.exec(script.trim())
  if (print) {
    const regex = new RegExp(print[1]!)
    return ok(fromLines(toLines(text).filter((line) => regex.test(line))))
  }

  return fail(`sed: unsupported script: ${script}`)
}

// ---- awk ------------------------------------------------------------------

/**
 * A useful subset of `awk`: `{print $1, $3}`, `/pattern/ {action}`, `NF`, `NR`.
 *
 * Same reasoning as `sed`: this covers what shell pipelines actually use awk
 * for — selecting and reordering fields — without pretending to be a language
 * implementation.
 */
export function awk(text: string, program: string, separator?: string): UtilResult {
  const match = /^(?:\/(.*?)\/\s*)?(?:\{(.*)\})?$/.exec(program.trim())
  if (!match) return fail(`awk: unsupported program: ${program}`)

  const [, filter, action] = match
  const pattern = filter ? new RegExp(filter) : undefined
  const split = separator ? (line: string) => line.split(separator) : (line: string) => line.split(/\s+/).filter(Boolean)

  const out: string[] = []
  let record = 0

  for (const line of toLines(text)) {
    record++
    if (pattern && !pattern.test(line)) continue

    if (!action) {
      out.push(line)
      continue
    }

    const printMatch = /^\s*print\s*(.*)$/.exec(action.trim())
    if (!printMatch) return fail(`awk: unsupported action: ${action}`)

    const expression = printMatch[1]!.trim()
    if (!expression) {
      out.push(line)
      continue
    }

    const fields = split(line)
    const rendered = expression
      .split(',')
      .map((term) => {
        const text = term.trim()
        if (text === '$0') return line
        if (text === 'NF') return String(fields.length)
        if (text === 'NR') return String(record)

        const field = /^\$(\d+)$/.exec(text)
        if (field) return fields[Number(field[1]) - 1] ?? ''

        // A quoted literal.
        const literal = /^"(.*)"$/.exec(text)
        if (literal) return literal[1]!
        return text
      })
      .join(' ')

    out.push(rendered)
  }

  return ok(fromLines(out))
}

// ---- formatting -----------------------------------------------------------

/** `fold`: hard-wraps at a width. */
export function fold(text: string, width = 80, breakAtSpaces = false): UtilResult {
  const out: string[] = []

  for (const line of toLines(text)) {
    if (line.length <= width) {
      out.push(line)
      continue
    }

    let rest = line
    while (rest.length > width) {
      let cut = width
      if (breakAtSpaces) {
        const space = rest.lastIndexOf(' ', width)
        if (space > 0) cut = space
      }
      out.push(rest.slice(0, cut))
      rest = rest.slice(breakAtSpaces && rest[cut] === ' ' ? cut + 1 : cut)
    }
    if (rest) out.push(rest)
  }

  return ok(fromLines(out))
}

/** `fmt`: reflows paragraphs to a width, preserving blank-line separation. */
export function fmt(text: string, width = 75): UtilResult {
  const out: string[] = []

  for (const paragraph of text.split(/\n\s*\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) continue

    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (candidate.length > width && line) {
        out.push(line)
        line = word
      } else {
        line = candidate
      }
    }
    if (line) out.push(line)
    out.push('')
  }

  while (out[out.length - 1] === '') out.pop()
  return ok(fromLines(out))
}

/** `expand`: tabs to spaces, respecting tab stops. */
export function expand(text: string, tabSize = 8): UtilResult {
  const lines = toLines(text).map((line) => {
    let out = ''
    for (const char of line) {
      if (char === '\t') out += ' '.repeat(tabSize - (out.length % tabSize))
      else out += char
    }
    return out
  })
  return ok(fromLines(lines))
}

/** `unexpand`: leading spaces back to tabs. */
export function unexpand(text: string, tabSize = 8): UtilResult {
  const lines = toLines(text).map((line) => {
    const indent = /^ +/.exec(line)?.[0].length ?? 0
    const tabs = Math.floor(indent / tabSize)
    return tabs > 0 ? '\t'.repeat(tabs) + line.slice(tabs * tabSize) : line
  })
  return ok(fromLines(lines))
}

/** `nl`: numbers lines. */
export function nl(text: string, options: { start?: number; skipBlank?: boolean } = {}): UtilResult {
  let counter = options.start ?? 1
  const lines = toLines(text).map((line) => {
    if (options.skipBlank !== false && line.trim() === '') return '      \t'
    return `${String(counter++).padStart(6)}\t${line}`
  })
  return ok(fromLines(lines))
}

/** `column -t`: aligns whitespace-separated fields into columns. */
export function column(text: string, separator = /\s+/): UtilResult {
  const rows = toLines(text).map((line) => line.split(separator).filter(Boolean))
  const widths: number[] = []

  for (const row of rows) {
    for (const [index, cell] of row.entries()) {
      widths[index] = Math.max(widths[index] ?? 0, cell.length)
    }
  }

  const lines = rows.map((row) =>
    row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index]!))).join('  '),
  )
  return ok(fromLines(lines))
}

/** `rev`: reverses each line's characters. */
export function rev(text: string): UtilResult {
  return ok(fromLines(toLines(text).map((line) => [...line].reverse().join(''))))
}

/** `shuf`: random permutation, seeded so a run is reproducible. */
export function shuf(text: string, count?: number, seed = Date.now()): UtilResult {
  const lines = toLines(text)

  // A small deterministic PRNG: an agent that shuffles should be able to
  // reproduce the run it is reporting on.
  let state = seed >>> 0
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }

  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[lines[i], lines[j]] = [lines[j]!, lines[i]!]
  }

  return ok(fromLines(count === undefined ? lines : lines.slice(0, count)))
}

/** `seq`: a numeric sequence. */
export function seq(start: number, end?: number, step = 1): UtilResult {
  const from = end === undefined ? 1 : start
  const to = end === undefined ? start : end

  if (step === 0) return fail('seq: step cannot be zero')
  if (step > 0 && from > to) return ok('')
  if (step < 0 && from < to) return ok('')

  const out: string[] = []
  // A float step accumulates error; deriving each value from the index avoids it.
  const count = Math.floor(Math.abs((to - from) / step)) + 1
  for (let i = 0; i < count; i++) {
    const value = from + i * step
    out.push(Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, ''))
  }

  return ok(fromLines(out))
}

/** `yes`: repeats a string. Capped, since the real one never terminates. */
export function yes(text = 'y', count = 100): UtilResult {
  return ok(fromLines(Array.from({ length: Math.min(count, 100_000) }, () => text)))
}
