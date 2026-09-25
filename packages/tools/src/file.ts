import { constants } from 'node:fs'
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { nativeReady } from '@jean/native'
import { nativeAnchors, nativePatch } from './accelerate.ts'
import { anchorOf, patch as applyHashline, HashlineError } from './hashline.ts'
import { ReplaceError, replaceText, type Strategy } from './replace.ts'
import { isSpilledOutput } from './shell.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'
import { ToolError } from './types.ts'
import {
  describeDatabase,
  extractPdfText,
  isArchive,
  parseSshPath,
  readSsh,
  parseNotebook,
  readArchive,
  readCsv,
  renderNotebook,
} from '@jean/readers'

/**
 * File operations (architecture §8.1).
 *
 * `read` returns content with an anchor gutter so the agent can cite anchors
 * back in an `edit`. `edit` speaks hashline by default and unified diff on
 * request. `write` creates or replaces whole files.
 */

/** Files above this size are summarized rather than dumped into context. */
const LARGE_FILE_BYTES = 256 * 1024
/** Default line budget for one read. */
const DEFAULT_LINE_LIMIT = 2000
/** Longer lines are truncated: one minified bundle should not eat a context. */
const MAX_LINE_CHARS = 2000

/**
 * Resolves a path inside the workspace, refusing escapes.
 *
 * An agent editing outside its project root is almost always a bug or an
 * injection; the few legitimate cases (a global config) go through explicit
 * tools rather than a path that happens to contain `../`.
 */
export function resolveInWorkspace(path: string, context: ToolContext): string {
  const absolute = isAbsolute(path) ? path : resolve(context.cwd, path)
  const rel = relative(context.cwd, absolute)
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    throw new ToolError(
      `${path} is outside the project root (${context.cwd}).`,
      'Work inside the project, or ask the user to start Jean Code from the directory you need.',
    )
  }
  return absolute
}

export function displayPath(absolute: string, context: ToolContext): string {
  const rel = relative(context.cwd, absolute)
  return rel && !rel.startsWith('..') ? rel.split(sep).join('/') : absolute
}

/**
 * Files whose contents are credentials.
 *
 * Reading one of these puts a live secret into the transcript, which is then
 * sent to the model provider on every subsequent turn and written to the
 * session file on disk. That is a credential disclosure the user never agreed
 * to, and it happens silently — the agent is usually just orienting itself in
 * an unfamiliar project.
 */
const SECRET_FILES = [
  /^\.env($|\.)/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^credentials$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|[-_.])secrets?\.(ya?ml|json|toml)$/i,
]

/** True when a path names a file that holds credentials. */
export function isSecretFile(absolute: string): boolean {
  const name = absolute.split(/[\\/]/).pop() ?? ''
  // `.env.example` is a template of variable *names*, which is exactly what an
  // agent needs to see and carries no values.
  if (/^\.env\.(example|sample|template)$/i.test(name)) return false
  return SECRET_FILES.some((pattern) => pattern.test(name))
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Detects binary content the same way the Rust walker does: a NUL in the head. */
function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0)
}

/**
 * Something `read` can read that is not a local file: a web page, a pull
 * request. Registered by the packages that can reach them — `@jean/search`
 * for URLs, `@jean/github` for `pr://` and `issue://` — which this package
 * cannot import without a cycle.
 */
export interface ReadSource {
  name: string
  matches(path: string): boolean
  read(path: string, args: { offset?: number; limit?: number }, context: ToolContext): Promise<ToolResult>
}

const readSources = new Map<string, ReadSource>()

/** Adds a source `read` consults before the file system; a name registers once. */
export function registerReadSource(source: ReadSource): void {
  readSources.set(source.name, source)
}

export const readTool: Tool<{ path: string; offset?: number; limit?: number; raw?: boolean }> = {
  name: 'read',
  risk: 'read',
  description: [
    'Read a file, or list a directory.',
    '',
    'Also reads what is not a local file: a web page (`https://…`), a pull request or',
    'issue (`pr://123`, `issue://owner/repo/45`), a file on another machine over SSH',
    '(`ssh://user@host/path` or `user@host:path`), and a PDF\'s text (`offset`/`limit`',
    'count pages there).',
    '',
    'Each line comes back as `<line number> h:<anchor> │ <text>`. The line number is for',
    'orientation (`offset`, `grep`, and the `lsp_*` tools all speak it); the anchor is a',
    'content hash that `edit` can cite in hashline mode. Neither is part of the file —',
    'never copy them into `old_string`.',
    '',
    'Large files are truncated; use `offset` and `limit` to page through one. Read several',
    'files in the same turn by issuing multiple `read` calls together — they run in parallel.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File or directory path, relative to the project root.' },
      offset: { type: 'integer', description: '1-based line to start from. Default 1.' },
      limit: { type: 'integer', description: `Lines to read. Default ${DEFAULT_LINE_LIMIT}.` },
      raw: {
        type: 'boolean',
        description: 'Return content without the anchor gutter. Use when copying text verbatim.',
      },
    },
    required: ['path'],
  },
  summarize: (args) => `read ${args.path}`,

  async execute(args, context): Promise<ToolResult> {
    for (const source of readSources.values()) {
      if (source.matches(args.path)) return source.read(args.path, args, context)
    }
    const remote = parseSshPath(args.path)
    if (remote) return readRemote(args.path, remote, args, context)

    // Saved command output lives outside the project, and is the one place
    // outside it `read` may go: the shell tool points the agent there.
    const absolute =
      isAbsolute(args.path) && isSpilledOutput(args.path)
        ? args.path
        : resolveInWorkspace(args.path, context)
    const shown = displayPath(absolute, context)

    if (!(await exists(absolute))) {
      throw new ToolError(
        `${shown} does not exist.`,
        'Use `glob` to find the right path, or `write` to create the file.',
      )
    }

    // Refused rather than redacted: a redacted read still marks the file as
    // read, and a later `edit` would then compute anchors against content that
    // does not match the file on disk.
    if (isSecretFile(absolute)) {
      throw new ToolError(
        `${shown} holds credentials, so its contents are not readable.`,
        'Reading it would put live secrets into the transcript and send them to the model provider. Ask the user for any value you need, or read the matching .env.example if there is one.',
      )
    }

    const info = await stat(absolute)

    // Formats that are not usefully readable as text get a dedicated reader.
    // Each is a real file an agent meets often, and raw bytes tell it nothing.
    const special = await readSpecialFormat(absolute, shown, info.size, args)
    if (special) {
      context.session.readFiles.add(absolute)
      return special
    }

    if (info.isDirectory()) {
      const entries = await readdir(absolute, { withFileTypes: true })
      const listed = entries
        .filter((e) => !e.name.startsWith('.'))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      return {
        output:
          listed.length === 0
            ? `${shown}/ is empty.`
            : `${shown}/ (${listed.length} entries)\n${listed.join('\n')}`,
        display: { kind: 'directory', path: shown, entries: listed },
      }
    }

    const buffer = await readFile(absolute)
    if (isBinary(buffer)) {
      return {
        output: `${shown} is a binary file (${formatBytes(info.size)}). Not shown.`,
        display: { kind: 'binary', path: shown, bytes: info.size },
      }
    }

    const content = buffer.toString('utf8')
    // Remember the read so `edit` can insist the agent looked first.
    context.session.readFiles.add(absolute)

    const allLines = content.split('\n')
    const offset = Math.max(1, args.offset ?? 1)
    const limit = Math.max(1, args.limit ?? DEFAULT_LINE_LIMIT)
    const slice = allLines.slice(offset - 1, offset - 1 + limit)
    const truncated = offset - 1 + slice.length < allLines.length

    // Anchors from the `hashline` crate, which `edit` then patches against:
    // one implementation computing both ends of the round trip.
    const anchors = args.raw ? undefined : await nativeAnchors(slice.map((line) => line.replace(/\r$/, '')))
    const body = args.raw ? slice.map(clampLine).join('\n') : gutter(slice, offset, anchors)

    const header = `${shown} (${allLines.length} lines, ${formatBytes(info.size)})`
    const footer = truncated
      ? `\n\n[${allLines.length - (offset - 1 + slice.length)} more lines — read again with offset: ${offset + slice.length}]`
      : ''
    const warning =
      info.size > LARGE_FILE_BYTES && !truncated
        ? '\n[large file — consider `grep` to find the part you need]'
        : ''

    return {
      output: `${header}${warning}\n${body}${footer}`,
      display: { kind: 'file', path: shown, lines: allLines.length, offset, shown: slice.length },
    }
  },
}

function clampLine(line: string): string {
  return line.length > MAX_LINE_CHARS
    ? `${line.slice(0, MAX_LINE_CHARS)}… [${line.length - MAX_LINE_CHARS} more chars]`
    : line
}

/**
 * The read gutter: line number, anchor, text.
 *
 * The anchor hashes the *unclamped* line, so a long line's anchor still
 * identifies the line on disk rather than its truncated display.
 */
export function gutter(lines: string[], firstLine: number, anchors?: string[]): string {
  const width = String(firstLine + lines.length - 1).length
  return lines
    .map((line, i) => {
      const n = String(firstLine + i).padStart(width)
      const anchor = anchors?.[i] ?? anchorOf(line.replace(/\r$/, ''))
      return `${n} h:${anchor} │ ${clampLine(line)}`
    })
    .join('\n')
}

export const writeTool: Tool<{ path: string; content: string }> = {
  name: 'write',
  risk: 'write',
  description: [
    'Create a file, or replace one entirely.',
    '',
    'For changes to an existing file, prefer `edit` — it is cheaper and it will not',
    'silently drop the parts of the file you did not reproduce. Use `write` for new',
    'files, or when replacing essentially all of a file.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the project root.' },
      content: { type: 'string', description: 'Complete file content.' },
    },
    required: ['path', 'content'],
  },
  summarize: (args, context) => {
    const shown = displayPath(resolveInWorkspace(args.path, context), context)
    const lines = args.content.split('\n').length
    return `write ${shown} (${lines} lines)`
  },

  async execute(args, context): Promise<ToolResult> {
    const absolute = resolveInWorkspace(args.path, context)
    const shown = displayPath(absolute, context)
    const existed = await exists(absolute)

    // Overwriting a file the agent has not read is how whole files get lost.
    if (existed && !context.session.readFiles.has(absolute)) {
      const info = await stat(absolute)
      if (info.size > 0) {
        throw new ToolError(
          `${shown} already exists and has not been read in this session.`,
          'Read it first, then `write` to replace it — or use `edit` to change part of it.',
        )
      }
    }

    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, args.content, 'utf8')
    context.session.readFiles.add(absolute)

    const lines = args.content.split('\n').length
    return {
      output: `${existed ? 'Replaced' : 'Created'} ${shown} (${lines} lines).`,
      touched: [absolute],
      display: { kind: 'write', path: shown, created: !existed, lines },
    }
  },
}

/** One `old_string` → `new_string` replacement. */
export interface Replacement {
  old_string: string
  new_string: string
  replace_all?: boolean
}

export interface EditArgs {
  path: string
  /** Replacement form. */
  old_string?: string
  new_string?: string
  replace_all?: boolean
  /** Several replacements, applied in order, all or nothing. */
  edits?: Replacement[]
  /** Hashline (or unified diff) form. */
  patch?: string
  mode?: 'hashline' | 'diff'
}

export const editTool: Tool<EditArgs> = {
  name: 'edit',
  risk: 'write',
  description: [
    'Edit an existing file. Read it first. Three forms — use whichever fits:',
    '',
    '1. Replace text: `old_string` → `new_string`. `old_string` must match the file and',
    '   be unique; include a few surrounding lines if it is not, or set `replace_all`.',
    '   Copy the file text itself, never the line numbers or anchors from `read`.',
    '',
    '2. Several replacements at once: `edits: [{old_string, new_string, replace_all?}, ...]`.',
    '   Applied in order, each against the result of the previous; if any fails, none',
    '   are written. Prefer this over many single edits to the same file.',
    '',
    '3. Hashline patch: cite an anchor from `read` and list the changed lines:',
    '     anchor: h:3f8a2b1c -> "export class RateLimiter {"',
    '     patch: |-|',
    '       - private counter = 0;',
    '       + private counter = new Map<string, number>();',
    '   `-` removes, `+` adds, other lines are context. The anchor survives the file',
    '   shifting, which makes this form best for many edits to a file that keeps changing.',
    '',
    'Matching tolerates small slips — wrong indentation, collapsed whitespace, escaped',
    'newlines — and re-indents your new text to fit. When nothing matches, the error',
    'shows the closest region of the file so you can retry from what is really there.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to edit, relative to the project root.' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Text to put in its place.' },
      replace_all: {
        type: 'boolean',
        description: 'Replace every occurrence of `old_string` instead of requiring one.',
      },
      edits: {
        type: 'array',
        description: 'Several replacements applied in order, atomically.',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' },
          },
          required: ['old_string', 'new_string'],
        },
      },
      patch: { type: 'string', description: 'One or more hashline anchor/patch blocks.' },
      mode: {
        type: 'string',
        enum: ['hashline', 'diff'],
        description: 'Dialect of `patch`. Defaults to hashline.',
      },
    },
    required: ['path'],
  },
  summarize: (args, context) => {
    const shown = displayPath(resolveInWorkspace(args.path, context), context)
    if (args.edits?.length) {
      return `edit ${shown} (${args.edits.length} change${args.edits.length === 1 ? '' : 's'})`
    }
    if (typeof args.old_string === 'string') {
      return `edit ${shown}${args.replace_all ? ' (all occurrences)' : ''}`
    }
    const hunks = (args.patch?.match(/^\s*anchor:/gm) ?? []).length || 1
    return `edit ${shown} (${hunks} hunk${hunks === 1 ? '' : 's'})`
  },

  async execute(args, context): Promise<ToolResult> {
    const absolute = resolveInWorkspace(args.path, context)
    const shown = displayPath(absolute, context)

    if (!(await exists(absolute))) {
      throw new ToolError(
        `${shown} does not exist, so there is nothing to edit.`,
        'Use `write` to create it.',
      )
    }
    if (!context.session.readFiles.has(absolute)) {
      throw new ToolError(
        `${shown} has not been read in this session, so its current content is unknown.`,
        'Call `read` on it first, then edit from what that shows.',
      )
    }

    const before = await readFile(absolute, 'utf8')

    const replacements = replacementsOf(args)
    if (replacements) {
      return applyReplacements(absolute, shown, before, replacements)
    }
    if (typeof args.patch !== 'string' || args.patch.trim() === '') {
      throw new ToolError(
        'Nothing to apply: pass `old_string` and `new_string`, an `edits` list, or a hashline `patch`.',
      )
    }

    if (args.mode === 'diff') {
      const applied = applyUnifiedDiff(before, args.patch)
      await writeFile(absolute, applied.content, 'utf8')
      return {
        output: `Applied ${applied.hunks} hunk${applied.hunks === 1 ? '' : 's'} to ${shown}.`,
        touched: [absolute],
        display: { kind: 'edit', path: shown, mode: 'diff', before, after: applied.content },
      }
    }

    // The `hashline` crate applies the patch; the TypeScript port is the
    // fallback when the bridge is not built. Both reject a bad patch with the
    // same error codes, so the advice below does not depend on which ran.
    let result: ReturnType<typeof applyHashline>
    try {
      result = (await nativePatch(before, args.patch)) ?? applyHashline(before, args.patch)
    } catch (err) {
      if (err instanceof HashlineError) {
        throw new ToolError(err.message, hintFor(err))
      }
      throw err
    }

    await writeFile(absolute, result.content, 'utf8')

    // Recovered anchors are worth reporting: the agent's picture of the file is
    // out of date, and it should re-read before making further edits.
    const recovered = result.resolutions.filter((r) => r.startsWith('recovered'))
    const note =
      recovered.length > 0
        ? ` ${recovered.length} anchor${recovered.length === 1 ? ' was' : 's were'} stale and recovered from context — re-read the file before editing it again.`
        : ''
    const delta = result.delta === 0 ? '' : ` ${result.delta > 0 ? '+' : ''}${result.delta} lines.`

    return {
      output: `Applied ${result.resolutions.length} hunk${result.resolutions.length === 1 ? '' : 's'} to ${shown}.${delta}${note}`,
      touched: [absolute],
      display: {
        kind: 'edit',
        path: shown,
        mode: 'hashline',
        before,
        after: result.content,
        resolutions: result.resolutions,
      },
    }
  },
}

function hintFor(err: HashlineError): string {
  switch (err.code) {
    case 'anchor-not-found':
      return 'Re-read the file and use an anchor from the fresh output. Include the anchor text (`-> "the line"`) so a stale anchor can still be recovered.'
    case 'ambiguous-anchor':
      return 'Add more context lines to the hunk, or quote the anchor text, so one landing site is unambiguous.'
    case 'context-mismatch':
      return 'The context lines do not match the file. Re-read it and rebuild the hunk from what is actually there.'
    case 'parse':
      return 'Each hunk needs an `anchor: h:xxxxxxxx` line followed by `patch: |-|` and the changed lines. Or use `old_string`/`new_string` instead.'
  }
}

/** The replacement form of an edit call, if that is what was sent. */
function replacementsOf(args: EditArgs): Replacement[] | undefined {
  if (Array.isArray(args.edits) && args.edits.length > 0) {
    return args.edits.map((edit, i) => {
      if (typeof edit?.old_string !== 'string' || typeof edit?.new_string !== 'string') {
        throw new ToolError(`edits[${i}] needs both \`old_string\` and \`new_string\` as strings.`)
      }
      return edit
    })
  }
  if (typeof args.old_string === 'string') {
    if (typeof args.new_string !== 'string') {
      throw new ToolError(
        '`old_string` was given without `new_string`.',
        'Pass `new_string: ""` to delete the text.',
      )
    }
    return [
      { old_string: args.old_string, new_string: args.new_string, replace_all: args.replace_all },
    ]
  }
  return undefined
}

/**
 * Applies replacements in order, writing only if every one of them lands.
 *
 * All-or-nothing matters: a batch that half-applies leaves the file in a state
 * the model never described, and its next edit is built on a picture of the
 * file that is wrong in ways it cannot see.
 */
async function applyReplacements(
  absolute: string,
  shown: string,
  before: string,
  replacements: Replacement[],
): Promise<ToolResult> {
  let content = before
  const notes: string[] = []
  const regions: { first: number; last: number }[] = []
  let total = 0

  for (let i = 0; i < replacements.length; i++) {
    const edit = replacements[i]!
    const label = replacements.length > 1 ? `edits[${i}]: ` : ''
    let result: ReturnType<typeof replaceText>
    try {
      result = replaceText(content, edit.old_string, edit.new_string, {
        replaceAll: edit.replace_all === true,
      })
    } catch (err) {
      if (err instanceof ReplaceError) {
        const nothing = replacements.length > 1 ? ' No edits were written.' : ''
        throw new ToolError(`${label}${err.message}${nothing}`, err.hint)
      }
      throw err
    }
    content = result.content
    total += result.count
    regions.push({ first: result.firstLine, last: result.lastLine })
    if (result.strategy !== 'exact') notes.push(`${label}${STRATEGY_NOTES[result.strategy]}`)
  }

  await writeFile(absolute, content, 'utf8')

  const delta = content.split('\n').length - before.split('\n').length
  const deltaText = delta === 0 ? '' : ` ${delta > 0 ? '+' : ''}${delta} lines.`
  const noteText = notes.length > 0 ? `\nNote: ${notes.join(' ')}` : ''
  const count = `${total} replacement${total === 1 ? '' : 's'}`

  return {
    output: `Edited ${shown}: ${count}.${deltaText}${noteText}\n\n${snippet(content, regions)}`,
    touched: [absolute],
    display: { kind: 'edit', path: shown, mode: 'replace', before, after: content },
  }
}

const STRATEGY_NOTES: Record<Exclude<Strategy, 'exact'>, string> = {
  'line-trimmed':
    'old_string matched after ignoring indentation; new_string was re-indented to fit.',
  'whitespace-normalized': 'old_string matched after collapsing whitespace.',
  'escape-normalized':
    'old_string contained literal escape sequences (like \\n); they were decoded before matching.',
  'trimmed-boundary': 'old_string matched after trimming whitespace at its ends.',
  'block-anchor':
    'old_string matched a block whose first and last lines agree but whose middle differed slightly — check the result below.',
}

/**
 * The edited regions, with a little context, in `read`'s gutter format.
 *
 * Showing the result is what lets the model verify its own edit without a
 * second `read` — and the anchors in it are valid for a follow-up hashline
 * edit, because they hash content, not position.
 */
function snippet(content: string, regions: { first: number; last: number }[]): string {
  const lines = content.split('\n')
  const CONTEXT = 3
  const merged: { first: number; last: number }[] = []
  for (const region of [...regions].sort((a, b) => a.first - b.first)) {
    const first = Math.max(1, region.first - CONTEXT)
    const last = Math.min(lines.length, region.last + CONTEXT)
    const previous = merged[merged.length - 1]
    if (previous && first <= previous.last + 1) previous.last = Math.max(previous.last, last)
    else merged.push({ first, last })
  }

  // A sweeping `replace_all` can touch hundreds of places; past a point the
  // snippet stops being a check and becomes a second copy of the file.
  const shown = merged.slice(0, 6)
  const parts = shown.map((r) => gutter(lines.slice(r.first - 1, r.last), r.first))
  if (merged.length > shown.length) {
    parts.push(`[${merged.length - shown.length} more edited regions not shown]`)
  }
  return parts.join('\n…\n')
}

/**
 * Minimal unified-diff applier for `mode: "diff"`.
 *
 * Hashline is the default and the better path; this exists for patches that
 * arrive from outside — a `git diff` pasted by the user, or a tool that only
 * speaks unified diff.
 */
export function applyUnifiedDiff(
  content: string,
  diff: string,
): { content: string; hunks: number } {
  const lines = content.split('\n')
  const out: string[] = []
  let cursor = 0
  let hunks = 0

  const diffLines = diff.split(/\r?\n/)
  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i]!
    const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line)
    if (!header) continue

    hunks++
    const start = Number(header[1]) - 1
    if (start < cursor) {
      throw new ToolError(
        `diff hunk ${hunks} starts at line ${start + 1}, before the previous hunk ended.`,
        'Hunks must be in ascending order and must not overlap.',
      )
    }
    out.push(...lines.slice(cursor, start))
    cursor = start

    for (i++; i < diffLines.length; i++) {
      const body = diffLines[i]!
      if (body.startsWith('@@')) {
        i--
        break
      }
      if (body.startsWith('---') || body.startsWith('+++')) continue

      const marker = body[0]
      const text = body.slice(1)
      if (marker === '+') {
        out.push(text)
      } else if (marker === '-' || marker === ' ' || body === '') {
        const actual = lines[cursor]
        if (marker !== '+' && actual === undefined) {
          throw new ToolError(`diff hunk ${hunks} runs past the end of the file.`)
        }
        if (body !== '' && actual!.trimEnd() !== text.trimEnd()) {
          throw new ToolError(
            `diff hunk ${hunks} expected ${JSON.stringify(text)} at line ${cursor + 1} but found ${JSON.stringify(actual)}.`,
            'Regenerate the diff against the current file.',
          )
        }
        if (marker !== '-') out.push(actual ?? '')
        cursor++
      }
    }
  }

  if (hunks === 0) {
    throw new ToolError('no `@@` hunk headers found in the patch.', 'Use hashline mode instead.')
  }
  out.push(...lines.slice(cursor))
  return { content: out.join('\n'), hunks }
}

/** Recordings `pi-voice` describes — itself, or through ffmpeg. */
const AUDIO = ['.wav', '.flac', '.aiff', '.aif', '.aifc', '.au', '.snd', '.mp3', '.ogg', '.oga', '.opus', '.m4a', '.webm', '.aac']

/** The most text one PDF read returns; the rest is paged with `offset`. */
const PDF_MAX_CHARS = 60_000

/** A PDF's text, page by page; `offset` and `limit` count pages. */
async function readPdf(absolute: string, shown: string, args: { offset?: number; limit?: number }): Promise<ToolResult> {
  const { pages, via } = extractPdfText(await readFile(absolute), absolute)
  const first = Math.max(1, args.offset ?? 1)
  const wanted = pages.slice(first - 1, args.limit ? first - 1 + args.limit : undefined)
  const out: string[] = []
  let chars = 0
  let shownPages = 0
  for (const [index, text] of wanted.entries()) {
    const block = `--- page ${first + index} ---\n${text || '(no text on this page — it may be an image)'}`
    if (chars + block.length > PDF_MAX_CHARS && shownPages > 0) break
    out.push(block)
    chars += block.length
    shownPages++
  }
  const last = first + shownPages - 1
  const more = last < pages.length ? `\n\n[pages ${last + 1}–${pages.length} not shown — read again with offset: ${last + 1}]` : ''
  const empty = pages.every((page) => !page.trim())
  return {
    output: `${shown} — PDF, ${pages.length} page${pages.length === 1 ? '' : 's'}${via === 'pdftotext' ? ' (pdftotext)' : ''}${empty ? '; no extractable text, so probably scanned images' : ''}\n\n${out.join('\n\n')}${more}`,
    display: { kind: 'pdf', pages: pages.length },
  }
}

/** A file or directory on another machine, through the system `ssh`. */
async function readRemote(
  path: string,
  target: import('@jean/readers').SshTarget,
  args: { offset?: number; limit?: number },
  context: ToolContext,
): Promise<ToolResult> {
  let result: Awaited<ReturnType<typeof readSsh>>
  try {
    result = await readSsh(target, { signal: context.signal })
  } catch (error) {
    throw new ToolError(
      `Could not read ${path} over SSH: ${error instanceof Error ? error.message : String(error)}`,
      'SSH runs in batch mode: the host needs key-based login (an agent, or a key in ~/.ssh) and a known host key.',
    )
  }
  if (result.directory) return { output: `${path}/\n${result.text.trimEnd()}`, display: { kind: 'directory', path } }
  const lines = result.text.split('\n')
  const offset = Math.max(1, args.offset ?? 1)
  const slice = lines.slice(offset - 1, offset - 1 + Math.max(1, args.limit ?? DEFAULT_LINE_LIMIT))
  const width = String(offset + slice.length).length
  const numbered = slice.map((text, i) => `${String(offset + i).padStart(width)}  ${text}`).join('\n')
  const cut = result.truncated ? '\n\n[the file is larger than 512 KB; only its start was fetched]' : ''
  return {
    output: `${path} (remote, ${lines.length} lines — edit it on the host, not with \`edit\`)\n${numbered}${cut}`,
    display: { kind: 'remote-file', path },
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const fileTools: Tool[] = [readTool, writeTool, editTool]

export { join, resolve }

/**
 * Dispatches to a format-specific reader, or returns undefined for plain text.
 *
 * A failure here degrades to reading the file as text rather than erroring: a
 * `.csv` with a malformed row is still worth showing, and a corrupt archive is
 * better reported by whatever the raw bytes reveal than by a parse failure.
 */
async function readSpecialFormat(
  absolute: string,
  shown: string,
  size: number,
  args: { offset?: number; limit?: number } = {},
): Promise<ToolResult | undefined> {
  const lower = absolute.toLowerCase()

  try {
    if (lower.endsWith('.pdf')) return readPdf(absolute, shown, args)

    if (lower.endsWith('.ipynb')) {
      const { cells, language } = parseNotebook(await readFile(absolute, 'utf8'))
      const code = cells.filter((c) => c.type === 'code').length
      return {
        output: `${shown} — ${cells.length} cells (${code} code)${language ? `, ${language}` : ''}\n\n${renderNotebook(cells)}`,
        display: { kind: 'notebook', cells: cells.length },
      }
    }

    if (lower.endsWith('.csv') || lower.endsWith('.tsv')) {
      const rendered = await readCsv(absolute, { delimiter: lower.endsWith('.tsv') ? '\t' : ',' })
      return { output: `${shown}:\n\n${rendered}`, display: { kind: 'csv' } }
    }

    if (/\.(db|sqlite|sqlite3)$/i.test(lower)) {
      const tables = await describeDatabase(absolute)
      if (tables.length === 0) return { output: `${shown} has no tables.` }

      const rendered = tables
        .map((table) => {
          const columns = table.columns
            .map((c) => `    ${c.name} ${c.type}${c.primaryKey ? ' PRIMARY KEY' : ''}${c.notNull ? ' NOT NULL' : ''}`)
            .join('\n')
          return `  ${table.name} (${table.rowCount} rows)\n${columns}`
        })
        .join('\n\n')

      return {
        output: `${shown} — ${tables.length} table${tables.length === 1 ? '' : 's'}:\n\n${rendered}\n\nQuery it with the \`sql\` tool.`,
        display: { kind: 'database', tables: tables.length },
      }
    }

    // A recording is read by `pi-voice`: what an agent can use from it is
    // its shape — length, loudness, where the speech is — not its bytes.
    if (AUDIO.some((extension) => lower.endsWith(extension))) {
      const native = await nativeReady()
      if (native) {
        const audio = await native.voiceProbe(absolute)
        const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`
        const speech =
          audio.speech.length === 0
            ? '  no speech detected'
            : audio.speech.map((s) => `  ${seconds(s.startMs)} – ${seconds(s.endMs)}`).join('\n')
        return {
          output: [
            `${shown} — ${audio.format === 'ffmpeg' ? 'audio (decoded by ffmpeg)' : `${audio.format.toUpperCase()} audio`}, ${seconds(audio.durationMs)}, ${audio.sampleRate} Hz, ${audio.channels} channel${audio.channels === 1 ? '' : 's'}, ${audio.bitsPerSample}-bit`,
            `Level: rms ${audio.rms.toFixed(3)}, peak ${audio.peak.toFixed(3)}`,
            `Speech (${audio.speech.length} segment${audio.speech.length === 1 ? '' : 's'}):`,
            speech,
            '',
            'Use `transcribe` to turn the speech into text.',
          ].join('\n'),
          display: { kind: 'audio', durationMs: audio.durationMs },
        }
      }
    }

    if (isArchive(absolute)) {
      const entries = await readArchive(absolute)
      const files = entries.filter((e) => !e.isDirectory)
      const listed = files
        .slice(0, 200)
        .map((e) => `  ${String(e.size).padStart(10)}  ${e.path}`)
        .join('\n')

      const more = files.length > 200 ? `\n  ... ${files.length - 200} more entries` : ''
      return {
        output: `${shown} — ${files.length} files, ${size} bytes packed:\n\n${listed}${more}`,
        display: { kind: 'archive', entries: files.length },
      }
    }
  } catch (err) {
    // Reported, not thrown: falling through to the text reader is usually more
    // useful than refusing to show the file at all.
    return {
      output: `${shown} could not be parsed as its declared format (${err instanceof Error ? err.message : String(err)}).`,
      isError: true,
    }
  }

  return undefined
}
