import { createHash } from 'node:crypto'

/**
 * TypeScript hashline — the fallback path for `crates/hashline`.
 *
 * This is a deliberate second implementation, not a binding. The CLI must run
 * before anyone has compiled a native module, and the edit primitive is too
 * central to be optional. The two implementations share a spec (same
 * normalization, same anchor derivation, same recovery order) and the same test
 * cases, so they agree line for line.
 *
 * See `crates/hashline/src/lib.rs` for the reference implementation and the
 * rationale behind each recovery step.
 */

export const ANCHOR_LEN = 8

export type Op =
  | { kind: 'keep'; text: string }
  | { kind: 'del'; text: string }
  | { kind: 'add'; text: string }

export interface Hunk {
  anchor: string
  anchorText?: string
  ops: Op[]
}

export type Resolution =
  | 'exact'
  | 'disambiguated'
  | 'recovered-by-text'
  | 'recovered-by-context'

export interface Applied {
  content: string
  resolutions: Resolution[]
  delta: number
}

export class HashlineError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'anchor-not-found'
      | 'context-mismatch'
      | 'ambiguous-anchor'
      | 'parse',
  ) {
    super(message)
    this.name = 'HashlineError'
  }
}

/**
 * Normalizes a line for hashing: trims both ends, collapses internal
 * whitespace runs to one space. This is what makes anchors survive
 * re-indentation and tab/space churn.
 */
export function normalize(line: string): string {
  return line.trim().replace(/\s+/g, ' ')
}

/** The anchor for a line: first 8 hex digits of SHA-256 over its normal form. */
export function anchorOf(line: string): string {
  return createHash('sha256').update(normalize(line), 'utf8').digest('hex').slice(0, ANCHOR_LEN)
}

/** An anchor index over a file, built once and reused across hunks. */
export class Index {
  readonly lines: string[]
  private readonly byAnchor = new Map<string, number[]>()
  private readonly trailingNewline: boolean

  constructor(content: string) {
    this.trailingNewline = content.endsWith('\n')
    const body = this.trailingNewline ? content.slice(0, -1) : content
    this.lines =
      body === '' && !this.trailingNewline
        ? []
        : body.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))

    for (const [i, line] of this.lines.entries()) {
      const anchor = anchorOf(line)
      const bucket = this.byAnchor.get(anchor)
      if (bucket) bucket.push(i)
      else this.byAnchor.set(anchor, [i])
    }
  }

  matches(anchor: string): number[] {
    return this.byAnchor.get(anchor) ?? []
  }

  /**
   * Renders the file with an anchor gutter. This is the form `read` returns, so
   * the agent can cite anchors straight back in an edit.
   */
  annotate(startLine = 1): string {
    return this.lines
      .slice(startLine - 1)
      .map((line) => `h:${anchorOf(line)} \u2502 ${line}`)
      .join('\n')
  }

  render(lines: string[]): string {
    const joined = lines.join('\n')
    return this.trailingNewline ? `${joined}\n` : joined
  }
}

/** Applies hunks left to right, tracking line drift between them. */
export function apply(content: string, hunks: Hunk[]): Applied {
  const index = new Index(content)
  const lines = [...index.lines]
  const resolutions: Resolution[] = []
  let offset = 0

  for (const hunk of hunks) {
    const located = locate(index, lines, hunk, offset)
    const before = lines.length
    splice(lines, located.start, hunk)
    offset += lines.length - before
    resolutions.push(located.resolution)
  }

  return {
    content: index.render(lines),
    resolutions,
    delta: lines.length - index.lines.length,
  }
}

function locate(
  index: Index,
  current: string[],
  hunk: Hunk,
  offset: number,
): { start: number; resolution: Resolution } {
  const candidates = index.matches(hunk.anchor)

  if (candidates.length === 1) {
    const shifted = clamp(candidates[0]! + offset, current.length)
    if (verify(current, shifted, hunk)) return { start: shifted, resolution: 'exact' }
    // The drift guess was wrong; re-find the anchor in the live buffer.
    const live = current.findIndex((l, i) => anchorOf(l) === hunk.anchor && verify(current, i, hunk))
    if (live !== -1) return { start: live, resolution: 'exact' }
  }

  if (candidates.length > 1) {
    const viable = candidates
      .map((c) => clamp(c + offset, current.length))
      .filter((c) => verify(current, c, hunk))
    if (viable.length === 1) return { start: viable[0]!, resolution: 'disambiguated' }
    if (viable.length > 1) {
      throw new HashlineError(
        `anchor h:${hunk.anchor} matches ${viable.length} lines (${viable.map((v) => v + 1).join(', ')}); add anchor text or more context to disambiguate`,
        'ambiguous-anchor',
      )
    }
  }

  // Recovery 1: the anchor line's text, normalized.
  if (hunk.anchorText !== undefined) {
    const target = normalize(hunk.anchorText)
    for (const [i, line] of current.entries()) {
      if (normalize(line) === target && verify(current, i, hunk)) {
        return { start: i, resolution: 'recovered-by-text' }
      }
    }
  }

  // Recovery 2: slide the hunk's own required lines over the file.
  const required = hunk.ops
    .filter((op): op is Extract<Op, { kind: 'keep' | 'del' }> => op.kind !== 'add')
    .map((op) => normalize(op.text))

  if (required.length > 0) {
    const hits: number[] = []
    for (let start = 0; start + required.length <= current.length; start++) {
      if (required.every((want, k) => normalize(current[start + k]!) === want)) hits.push(start)
    }
    if (hits.length === 1) return { start: hits[0]!, resolution: 'recovered-by-context' }
  }

  const seen = hunk.anchorText ? ` (last seen as ${JSON.stringify(hunk.anchorText)})` : ''
  throw new HashlineError(`anchor h:${hunk.anchor} not found${seen}`, 'anchor-not-found')
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max)
}

/** True when the hunk's context and deletions match the buffer at `start`. */
function verify(current: string[], start: number, hunk: Hunk): boolean {
  let cursor = start
  for (const op of hunk.ops) {
    if (op.kind === 'add') continue
    const have = current[cursor]
    if (have === undefined || normalize(have) !== normalize(op.text)) return false
    cursor++
  }
  return true
}

function splice(lines: string[], start: number, hunk: Hunk): void {
  const reindent = indentDelta(lines, start, hunk)
  const out: string[] = []
  let cursor = start

  for (const op of hunk.ops) {
    if (op.kind === 'add') {
      out.push(applyIndent(op.text, reindent))
      continue
    }
    const have = lines[cursor]
    if (have === undefined || normalize(have) !== normalize(op.text)) {
      throw new HashlineError(
        `hunk h:${hunk.anchor} landed at line ${cursor + 1} but expected ${JSON.stringify(op.text)}, found ${JSON.stringify(have ?? '<end of file>')}`,
        'context-mismatch',
      )
    }
    if (op.kind === 'keep') out.push(have)
    cursor++
  }

  lines.splice(start, cursor - start, ...out)
}

type Reindent = { kind: 'none' } | { kind: 'prefix'; text: string } | { kind: 'strip'; count: number }

/**
 * Works out how to re-indent inserted lines so a patch written against
 * 2-space source lands correctly in 4-space source.
 */
function indentDelta(lines: string[], start: number, hunk: Hunk): Reindent {
  const anchored = hunk.ops.find((op) => op.kind !== 'add')
  const patchIndent = anchored ? leadingWs(anchored.text) : ''
  const fileIndent = leadingWs(lines[start] ?? '')

  if (patchIndent === fileIndent) return { kind: 'none' }
  if (fileIndent.startsWith(patchIndent)) {
    return { kind: 'prefix', text: fileIndent.slice(patchIndent.length) }
  }
  if (patchIndent.startsWith(fileIndent)) {
    return { kind: 'strip', count: patchIndent.length - fileIndent.length }
  }
  return { kind: 'none' }
}

function applyIndent(text: string, reindent: Reindent): string {
  if (text.trim() === '') return text
  switch (reindent.kind) {
    case 'none':
      return text
    case 'prefix':
      return reindent.text + text
    case 'strip': {
      const ws = leadingWs(text)
      return text.slice(Math.min(ws.length, reindent.count))
    }
  }
}

function leadingWs(line: string): string {
  const match = /^\s*/.exec(line)
  return match ? match[0] : ''
}

/**
 * Parses the textual patch format:
 *
 * ```text
 * anchor: h:3f8a2b1c -> "export class RateLimiter {"
 * patch: |-|
 *   - private counter = 0;
 *   + private counter = new Map();
 * ```
 */
export function parse(input: string): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | undefined
  let inBody = false
  let bodyIndent: number | undefined

  for (const raw of input.split(/\r?\n/)) {
    const trimmed = raw.trimStart()

    if (trimmed.startsWith('anchor:')) {
      if (current) hunks.push(current)
      current = { ...parseAnchor(trimmed.slice(7)), ops: [] }
      inBody = false
      bodyIndent = undefined
      continue
    }
    if (trimmed.startsWith('patch:')) {
      if (!current) throw new HashlineError('`patch:` appeared before any `anchor:`', 'parse')
      inBody = true
      bodyIndent = undefined
      continue
    }
    if (!inBody || !current) continue
    if (raw.trim() === '' && current.ops.length === 0) continue

    if (bodyIndent === undefined) bodyIndent = raw.length - raw.trimStart().length
    const stripped =
      raw.length >= bodyIndent && raw.slice(0, bodyIndent).trim() === ''
        ? raw.slice(bodyIndent)
        : raw.trimStart()

    const marker = stripped[0]
    if (marker === '-') current.ops.push({ kind: 'del', text: stripMarker(stripped) })
    else if (marker === '+') current.ops.push({ kind: 'add', text: stripMarker(stripped) })
    else current.ops.push({ kind: 'keep', text: stripped })
  }

  if (current) hunks.push(current)
  if (hunks.length === 0) throw new HashlineError('no `anchor:` block found', 'parse')
  for (const hunk of hunks) {
    if (hunk.ops.length === 0) {
      throw new HashlineError(`hunk h:${hunk.anchor} has an empty patch body`, 'parse')
    }
  }
  return hunks
}

function stripMarker(line: string): string {
  const rest = line[0] === '-' || line[0] === '+' ? line.slice(1) : line
  return rest.startsWith(' ') ? rest.slice(1) : rest
}

function parseAnchor(rest: string): { anchor: string; anchorText?: string } {
  const text = rest.trim()
  const arrow = text.includes('->') ? '->' : text.includes('\u2192') ? '\u2192' : undefined
  const [anchorPart, textPart] = arrow
    ? [text.slice(0, text.indexOf(arrow)), text.slice(text.indexOf(arrow) + arrow.length)]
    : [text, undefined]

  const anchor = anchorPart.trim().replace(/^h:/, '').trim().toLowerCase()
  if (!anchor || !/^[0-9a-f]+$/.test(anchor)) {
    throw new HashlineError(`anchor ${JSON.stringify(anchorPart.trim())} is not a hex hash`, 'parse')
  }

  const anchorText = textPart?.trim().replace(/^"|"$/g, '') || undefined
  return { anchor, anchorText }
}

/** Parse and apply in one call. */
export function patch(content: string, patchText: string): Applied {
  return apply(content, parse(patchText))
}
