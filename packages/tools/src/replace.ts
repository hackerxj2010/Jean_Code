/**
 * String-replacement edits: `old_string` → `new_string`.
 *
 * Hashline anchors are the precise path, but frontier models are trained hard
 * on the replacement shape — it is what the most widely used harnesses expose —
 * and a model working in its native format makes fewer malformed edits. The
 * failure it *does* make is quoting the old text slightly wrong: indentation
 * off by a level, trailing whitespace dropped, a `\n` written as the two
 * characters `\` `n`. A strict matcher turns each of those into a wasted turn
 * and, often, a loop of identical retries.
 *
 * So matching runs as a cascade, strictest first. A looser matcher is only
 * consulted when every stricter one found nothing, and every matcher refuses an
 * ambiguous result rather than guessing — replacing the wrong one of two
 * similar blocks is worse than asking for more context.
 *
 * When nothing matches, the error names the most similar region of the file,
 * with line numbers, so the next attempt can be built from what is actually
 * there instead of from memory.
 */

export type Strategy =
  | 'exact'
  | 'line-trimmed'
  | 'whitespace-normalized'
  | 'escape-normalized'
  | 'trimmed-boundary'
  | 'block-anchor'

export interface ReplaceResult {
  content: string
  /** Occurrences replaced. */
  count: number
  /** The matcher that found the text. Anything but `exact` is worth reporting. */
  strategy: Strategy
  /** 1-based line range of the first replacement, in the *new* content. */
  firstLine: number
  lastLine: number
}

export class ReplaceError extends Error {
  constructor(
    message: string,
    readonly code: 'not-found' | 'ambiguous' | 'no-op' | 'empty',
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'ReplaceError'
  }
}

/** A located match: character offsets into the (LF-normalized) content. */
interface Span {
  start: number
  end: number
  /** Replacement text for this span, already adjusted to the file. */
  replacement: string
}

type Matcher = (content: string, oldText: string, newText: string) => Span[]

/**
 * Replaces `oldText` with `newText` in `content`.
 *
 * Line endings are normalized to LF for matching and restored afterwards, so a
 * model that writes `\n` edits a CRLF file correctly — on Windows, a checkout
 * with `core.autocrlf` makes that the common case rather than an edge case.
 */
export function replaceText(
  content: string,
  oldText: string,
  newText: string,
  options: { replaceAll?: boolean } = {},
): ReplaceResult {
  const crlf = content.includes('\r\n')
  const source = crlf ? content.replace(/\r\n/g, '\n') : content
  const find = oldText.replace(/\r\n/g, '\n')
  const replacement = newText.replace(/\r\n/g, '\n')

  if (find === '') {
    throw new ReplaceError(
      '`old_string` is empty, so there is nothing to find.',
      'empty',
      'To create a file use `write`. To insert text, quote the line it goes next to in `old_string` and repeat it in `new_string` with the addition.',
    )
  }
  if (find === replacement) {
    throw new ReplaceError(
      '`old_string` and `new_string` are identical, so the edit would change nothing.',
      'no-op',
    )
  }

  for (const [strategy, matcher] of MATCHERS) {
    const spans = nonOverlapping(matcher(source, find, replacement))
    if (spans.length === 0) continue

    if (spans.length > 1 && !options.replaceAll) {
      const lines = spans.map((s) => lineAt(source, s.start)).join(', ')
      throw new ReplaceError(
        `\`old_string\` matches ${spans.length} places (lines ${lines}).`,
        'ambiguous',
        'Include more surrounding lines so exactly one place matches, or pass `replace_all: true` to change every occurrence.',
      )
    }

    const applied = spliceAll(source, options.replaceAll ? spans : spans.slice(0, 1))
    const firstSpan = spans[0]!
    const firstLine = lineAt(applied, firstSpan.start)
    const lastLine = firstLine + Math.max(0, firstSpan.replacement.split('\n').length - 1)

    return {
      content: crlf ? applied.replace(/\n/g, '\r\n') : applied,
      count: options.replaceAll ? spans.length : 1,
      strategy,
      firstLine,
      lastLine,
    }
  }

  throw new ReplaceError(
    '`old_string` was not found in the file.',
    'not-found',
    suggestClosest(source, find),
  )
}

// ---------------------------------------------------------------------------
// Matchers, strictest first.

const exact: Matcher = (content, oldText, newText) => {
  const spans: Span[] = []
  let from = 0
  for (;;) {
    const at = content.indexOf(oldText, from)
    if (at === -1) break
    spans.push({ start: at, end: at + oldText.length, replacement: newText })
    from = at + oldText.length
  }
  return spans
}

/** Lines equal once each is trimmed: the indentation-was-wrong case. */
const lineTrimmed: Matcher = (content, oldText, newText) =>
  lineWindows(content, oldText, newText, (a, b) => a.trim() === b.trim())

/** Runs of whitespace collapsed: `foo(a,  b)` against `foo(a, b)`. */
const whitespaceNormalized: Matcher = (content, oldText, newText) =>
  lineWindows(content, oldText, newText, (a, b) => collapse(a) === collapse(b))

/**
 * The model sent escape sequences as literal text — `\n` as a backslash and an
 * `n`. Happens when a tool argument is double-encoded somewhere upstream.
 */
const escapeNormalized: Matcher = (content, oldText, newText) => {
  if (!/\\[ntr"'\\`]/.test(oldText)) return []
  const find = unescape(oldText)
  if (find === oldText) return []
  const replacement = unescape(newText)
  const direct = exact(content, find, replacement)
  return direct.length > 0 ? direct : lineTrimmed(content, find, replacement)
}

/** Stray whitespace at the edges of `old_string` that the file does not have. */
const trimmedBoundary: Matcher = (content, oldText, newText) => {
  const trimmed = oldText.trim()
  if (trimmed === oldText || trimmed === '') return []
  const lead = oldText.slice(0, oldText.indexOf(trimmed))
  const trail = oldText.slice(oldText.indexOf(trimmed) + trimmed.length)
  let replacement = newText
  if (lead && replacement.startsWith(lead)) replacement = replacement.slice(lead.length)
  if (trail && replacement.endsWith(trail)) {
    replacement = replacement.slice(0, replacement.length - trail.length)
  }
  return exact(content, trimmed, replacement)
}

/**
 * First and last lines match and the middle is close: the model reproduced a
 * block from memory and got a line or two of the interior slightly wrong.
 *
 * The loosest matcher, so the strictest about ambiguity — it accepts only a
 * single clear winner above a high similarity bar.
 */
const blockAnchor: Matcher = (content, oldText, newText) => {
  const { body: findBody, replacement, consumeNewline } = splitTrailingNewline(oldText, newText)
  const want = findBody.split('\n')
  if (want.length < 3) return []

  const lines = content.split('\n')
  const first = want[0]!.trim()
  const last = want[want.length - 1]!.trim()
  if (first === '' || last === '') return []

  const minLen = Math.max(3, Math.floor(want.length * 0.75))
  const maxLen = Math.ceil(want.length * 1.25) + 1
  const candidates: { start: number; end: number; score: number }[] = []

  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== first) continue
    for (let len = minLen; len <= maxLen && i + len <= lines.length; len++) {
      if (lines[i + len - 1]!.trim() !== last) continue
      const window = lines.slice(i, i + len)
      const score = similarity(
        window.slice(1, -1).map((l) => l.trim()).join('\n'),
        want.slice(1, -1).map((l) => l.trim()).join('\n'),
      )
      candidates.push({ start: i, end: i + len, score })
    }
  }

  const good = candidates.filter((c) => c.score >= 0.8).sort((a, b) => b.score - a.score)
  if (good.length === 0) return []
  // Two near-equal candidates means the text does not identify a block.
  if (good.length > 1 && good[1]!.score >= good[0]!.score - 0.05) return []

  const best = good[0]!
  return [toSpan(content, lines, best.start, best.end, want, replacement, consumeNewline)]
}

const MATCHERS: [Strategy, Matcher][] = [
  ['exact', exact],
  ['line-trimmed', lineTrimmed],
  ['whitespace-normalized', whitespaceNormalized],
  ['escape-normalized', escapeNormalized],
  ['trimmed-boundary', trimmedBoundary],
  ['block-anchor', blockAnchor],
]

// ---------------------------------------------------------------------------
// Line-window machinery shared by the fuzzy matchers.

/**
 * A trailing newline on `old_string` means "and the line break after it". The
 * window matchers work on whole lines, so the newline is set aside and put back
 * — or, if `new_string` dropped it, consumed from the file.
 */
function splitTrailingNewline(
  oldText: string,
  newText: string,
): { body: string; replacement: string; consumeNewline: boolean } {
  if (!oldText.endsWith('\n')) return { body: oldText, replacement: newText, consumeNewline: false }
  const body = oldText.slice(0, -1)
  if (newText.endsWith('\n')) return { body, replacement: newText.slice(0, -1), consumeNewline: false }
  return { body, replacement: newText, consumeNewline: true }
}

function lineWindows(
  content: string,
  oldText: string,
  newText: string,
  equal: (fileLine: string, wantLine: string) => boolean,
): Span[] {
  const { body, replacement, consumeNewline } = splitTrailingNewline(oldText, newText)
  const want = body.split('\n')
  // A single blank line matches everywhere; there is nothing to anchor on.
  if (want.every((line) => line.trim() === '')) return []

  const lines = content.split('\n')
  const spans: Span[] = []

  outer: for (let i = 0; i + want.length <= lines.length; i++) {
    for (let k = 0; k < want.length; k++) {
      if (!equal(lines[i + k]!, want[k]!)) continue outer
    }
    spans.push(toSpan(content, lines, i, i + want.length, want, replacement, consumeNewline))
    i += want.length - 1
  }
  return spans
}

/** Converts a line window into a character span with a re-indented replacement. */
function toSpan(
  content: string,
  lines: string[],
  startLine: number,
  endLine: number,
  want: string[],
  replacement: string,
  consumeNewline: boolean,
): Span {
  let start = 0
  for (let i = 0; i < startLine; i++) start += lines[i]!.length + 1
  let end = start
  for (let i = startLine; i < endLine; i++) end += lines[i]!.length + 1
  end -= 1 // the window ends before its last line's newline
  if (consumeNewline && content[end] === '\n') end += 1

  const window = lines.slice(startLine, endLine)
  // Line k of the quote corresponds to line k of the window only when they are
  // the same length; the block matcher can match a window of a different size,
  // and then only its first and last lines are known to correspond.
  const pairs: [string, string][] =
    window.length === want.length
      ? want.map((line, k) => [line, window[k]!])
      : [
          [want[0]!, window[0]!],
          [want[want.length - 1]!, window[window.length - 1]!],
        ]
  return { start, end, replacement: reindent(replacement, indentMap(pairs)) }
}

function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)![0]
}

/**
 * How each indentation level the model used maps onto the file.
 *
 * Learned from the lines the model quoted and the lines they matched. A single
 * base offset is not enough: a model that writes two-space indentation against
 * a four-space file is wrong by a *factor*, so every nesting level is off by a
 * different amount.
 */
function indentMap(pairs: [string, string][]): Map<string, string> {
  const map = new Map<string, string>()
  for (const [quoted, actual] of pairs) {
    if (quoted.trim() === '' || actual.trim() === '') continue
    const from = indentOf(quoted)
    if (!map.has(from)) map.set(from, indentOf(actual))
  }
  return map
}

/**
 * Moves `text` from the indentation the model assumed to the one the file has.
 *
 * Levels the model quoted map exactly. A level it did not quote — a new, deeper
 * block in `new_string` — is placed relative to the nearest quoted level, with
 * the extra depth scaled by the ratio between the file's indent unit and the
 * model's.
 */
function reindent(text: string, map: Map<string, string>): string {
  if ([...map].every(([from, to]) => from === to)) return text

  const known = [...map].sort((a, b) => a[0].length - b[0].length)
  const ratio = unitRatio(known)

  return text
    .split('\n')
    .map((line) => {
      if (line.trim() === '') return line
      const indent = indentOf(line)
      const body = line.slice(indent.length)
      const direct = map.get(indent)
      if (direct !== undefined) return direct + body

      // Nearest quoted level at or below this one, else the shallowest.
      let base = known[0]!
      for (const entry of known) if (entry[0].length <= indent.length) base = entry
      const extra = indent.length - base[0].length
      const unitChar = base[1].includes('\t') ? '\t' : ' '
      if (extra <= 0) return base[1] + body
      const scaled = unitChar === '\t' ? Math.max(1, Math.round(extra * ratio)) : Math.round(extra * ratio)
      return base[1] + unitChar.repeat(scaled) + body
    })
    .join('\n')
}

/**
 * File indent width per model indent width, from two known levels.
 *
 * With a single known level there is no second point to measure a unit from,
 * so depth is kept as the model wrote it.
 */
function unitRatio(known: [string, string][]): number {
  if (known.length < 2) return 1
  const [lowFrom, lowTo] = known[0]!
  const [highFrom, highTo] = known[known.length - 1]!
  // Measured in characters on both sides, so a tab-indented file measures in
  // tabs and the model's spaces map onto them.
  const modelSpan = highFrom.length - lowFrom.length
  const fileSpan = highTo.length - lowTo.length
  if (modelSpan <= 0 || fileSpan <= 0) return 1
  return fileSpan / modelSpan
}

// ---------------------------------------------------------------------------
// Helpers.

function collapse(line: string): string {
  return line.trim().replace(/\s+/g, ' ')
}

function unescape(text: string): string {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\`/g, '`')
    .replace(/\\\\/g, '\\')
}

function nonOverlapping(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const out: Span[] = []
  let lastEnd = -1
  for (const span of sorted) {
    if (span.start < lastEnd) continue
    out.push(span)
    lastEnd = span.end
  }
  return out
}

function spliceAll(content: string, spans: Span[]): string {
  let out = ''
  let cursor = 0
  for (const span of spans) {
    out += content.slice(cursor, span.start) + span.replacement
    cursor = span.end
  }
  return out + content.slice(cursor)
}

/** 1-based line number of a character offset. */
function lineAt(content: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++
  }
  return line
}

/**
 * Normalized edit similarity in [0, 1].
 *
 * Levenshtein over characters for inputs small enough to afford it, and a
 * line-overlap ratio above that — the decision it feeds only needs to tell
 * "nearly the same" from "different", not rank close calls precisely.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  if (a.length * b.length > 4_000_000) return lineOverlap(a, b)

  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length)
}

function lineOverlap(a: string, b: string): number {
  const left = a.split('\n')
  const right = new Set(b.split('\n'))
  const shared = left.filter((line) => right.has(line)).length
  return shared / Math.max(left.length, right.size)
}

/**
 * Finds the region of the file most like `oldText` and describes it.
 *
 * This is what turns "not found" from a dead end into a correction: the model
 * sees the text it should have quoted, with line numbers, and can retry from
 * that rather than from its memory of the file.
 */
function suggestClosest(content: string, oldText: string): string {
  const generic =
    'Re-read the file and copy the text exactly, including indentation. Quote a few complete lines rather than a fragment.'
  const want = oldText.replace(/\n$/, '').split('\n').map((l) => l.trim())
  const lines = content.split('\n')
  if (want.length === 0 || lines.length * want.length > 3_000_000) return generic

  const wantSet = new Map<string, number>()
  for (const line of want) if (line) wantSet.set(line, (wantSet.get(line) ?? 0) + 1)

  let bestStart = -1
  let bestScore = 0
  for (let i = 0; i < lines.length; i++) {
    let score = 0
    for (let k = 0; k < want.length && i + k < lines.length; k++) {
      const line = lines[i + k]!.trim()
      if (line === '') continue
      if (line === want[k]) score += 2
      else if (wantSet.has(line)) score += 1
    }
    if (score > bestScore) {
      bestScore = score
      bestStart = i
    }
  }

  // Too few recognisable lines is not a suggestion, it is noise that would
  // send the model after the wrong block.
  if (bestStart === -1 || bestScore < Math.max(2, want.length * 0.5)) return generic

  const end = Math.min(lines.length, bestStart + want.length)
  const width = String(end).length
  const excerpt = lines
    .slice(bestStart, end)
    .map((line, k) => {
      const n = String(bestStart + k + 1).padStart(width)
      const marker = line.trim() === want[k] ? ' ' : '≠'
      return `${n}${marker}│ ${line}`
    })
    .join('\n')

  return `The closest text in the file is at lines ${bestStart + 1}-${end} (≠ marks lines that differ from your old_string):\n${excerpt}\nCopy from this excerpt exactly and retry.`
}
