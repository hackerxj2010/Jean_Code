import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { isSecretFile, resolveInWorkspace } from './file.ts'
import { literalOf, nativeEntries, nativeSearch, nativeWalk } from './accelerate.ts'
import type { Tool, ToolResult } from './types.ts'
import { ToolError } from './types.ts'

/**
 * `glob` and `grep` (architecture §8.1).
 *
 * The TypeScript fallback for `crates/pi-walker`: one ignore-aware traversal
 * serving both tools, with the same gitignore semantics as the Rust walker.
 */

/** Directories never worth walking into, before any .gitignore is read. */
const ALWAYS_IGNORE = new Set([
  '.git',
  'node_modules',
  'target',
  'dist',
  'build',
  '.turbo',
  '.next',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
])

const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_WALK_ENTRIES = 200_000

export interface WalkOptions {
  respectGitignore?: boolean
  includeHidden?: boolean
  maxDepth?: number
  limit?: number
  signal?: AbortSignal
}

/**
 * Compiles a gitignore-style pattern.
 *
 * Mirrors `crates/pi-walker/src/glob.rs`: `*` stops at `/`, `**` crosses it,
 * a leading `/` anchors, a trailing `/` means directories only, `!` negates.
 */
export function compilePattern(pattern: string): {
  test: (path: string, isDir: boolean) => boolean
  negated: boolean
} {
  let body = pattern.trim()
  const negated = body.startsWith('!')
  if (negated) body = body.slice(1)

  const dirOnly = body.endsWith('/')
  if (dirOnly) body = body.slice(0, -1)

  const anchored = body.includes('/')
  if (body.startsWith('/')) body = body.slice(1)

  const regex = globToRegExp(body)

  return {
    negated,
    test(path: string, isDir: boolean): boolean {
      if (dirOnly && !isDir) return false
      if (anchored) {
        if (regex.test(path)) return true
        // An anchored directory pattern also covers everything beneath it.
        const parts = path.split('/')
        for (let i = 1; i < parts.length; i++) {
          if (regex.test(parts.slice(0, i).join('/'))) return true
        }
        return false
      }
      return regex.test(path) || path.split('/').some((seg) => regex.test(seg))
    },
  }
}

/** Translates a glob into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let out = '^'
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` may match zero directories, so make the separator optional.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i++
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if (ch === '[') {
      const close = glob.indexOf(']', i + 1)
      if (close === -1) {
        out += '\\['
      } else {
        const body = glob.slice(i + 1, close)
        const negate = body.startsWith('!') || body.startsWith('^')
        out += `[${negate ? '^' : ''}${escapeClass(negate ? body.slice(1) : body)}]`
        i = close
      }
    } else if ('.+^${}()|\\/'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return new RegExp(`${out}$`)
}

function escapeClass(body: string): string {
  return body.replace(/[\\\]]/g, '\\$&')
}

/** An ordered stack of ignore rules; the last match wins. */
export class IgnoreSet {
  private readonly rules: ReturnType<typeof compilePattern>[] = []

  addFile(contents: string): void {
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      this.rules.push(compilePattern(trimmed))
    }
  }

  add(pattern: string): void {
    this.rules.push(compilePattern(pattern))
  }

  clone(): IgnoreSet {
    const copy = new IgnoreSet()
    copy.rules.push(...this.rules)
    return copy
  }

  isIgnored(relPath: string, isDir: boolean): boolean {
    let ignored = false
    for (const rule of this.rules) {
      if (rule.test(relPath, isDir)) ignored = !rule.negated
    }
    return ignored
  }
}

export interface WalkEntry {
  relPath: string
  absPath: string
  isDir: boolean
  size: number
}

/**
 * Walks `root`, yielding non-ignored entries, shallowest first.
 *
 * The Rust walker does the traversal when it is built: in parallel, and
 * reporting each entry's type and size so nothing here needs a `stat`. The
 * TypeScript walk below is the fallback, with the same ignore rules.
 */
export async function* walk(
  root: string,
  options: WalkOptions = {},
): AsyncGenerator<WalkEntry, void, void> {
  const native = await nativeEntries(root, {
    includeHidden: options.includeHidden,
    respectGitignore: options.respectGitignore,
    maxDepth: options.maxDepth,
    limit: Math.min(options.limit ?? MAX_WALK_ENTRIES, MAX_WALK_ENTRIES),
    extraIgnores: [...ALWAYS_IGNORE],
  })
  if (native !== undefined) {
    for (const entry of native) {
      if (options.signal?.aborted) return
      yield { relPath: entry.relPath, absPath: join(root, entry.relPath), isDir: entry.isDir, size: entry.size }
    }
    return
  }

  yield* walkInTypeScript(root, options)
}

async function* walkInTypeScript(
  root: string,
  options: WalkOptions,
): AsyncGenerator<WalkEntry, void, void> {
  const ignores = new IgnoreSet()
  if (options.respectGitignore !== false) {
    for (const name of ['.gitignore', '.ignore', '.jeanignore']) {
      const text = await readFile(join(root, name), 'utf8').catch(() => undefined)
      if (text) ignores.addFile(text)
    }
  }

  let yielded = 0
  const queue: { dir: string; rel: string; depth: number; ignores: IgnoreSet }[] = [
    { dir: root, rel: '', depth: 0, ignores },
  ]

  while (queue.length > 0) {
    const current = queue.shift()!
    if (options.signal?.aborted) return

    const entries = await readdir(current.dir, { withFileTypes: true }).catch(() => [])

    // A nested .gitignore extends the parent's rules for this subtree only.
    let local = current.ignores
    if (options.respectGitignore !== false && current.depth > 0) {
      const nested = await readFile(join(current.dir, '.gitignore'), 'utf8').catch(() => undefined)
      if (nested) {
        local = local.clone()
        local.addFile(nested)
      }
    }

    for (const entry of entries) {
      const name = entry.name
      if (!options.includeHidden && name.startsWith('.')) continue
      if (ALWAYS_IGNORE.has(name)) continue

      const relPath = current.rel ? `${current.rel}/${name}` : name
      const absPath = join(current.dir, name)
      const isDir = entry.isDirectory()

      if (local.isIgnored(relPath, isDir)) continue
      if (entry.isSymbolicLink()) continue

      const info = await stat(absPath).catch(() => undefined)
      if (!info) continue

      yield { relPath, absPath, isDir, size: isDir ? 0 : info.size }
      yielded++
      if (options.limit && yielded >= options.limit) return
      if (yielded >= MAX_WALK_ENTRIES) return

      if (isDir && (options.maxDepth === undefined || current.depth + 1 < options.maxDepth)) {
        queue.push({ dir: absPath, rel: relPath, depth: current.depth + 1, ignores: local })
      }
    }
  }
}

export const globTool: Tool<{ pattern: string; path?: string; limit?: number }> = {
  name: 'glob',
  risk: 'read',
  description: [
    'Find files by path pattern. Respects .gitignore.',
    '',
    'Patterns: `*` matches within one path segment, `**` crosses segments,',
    '`?` matches one character, `[abc]` a character class.',
    'Examples: `**/*.ts`, `src/**/test_*.py`, `packages/*/package.json`.',
    '',
    'Returns paths only. Use `grep` to search file contents.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, relative to the search root.' },
      path: { type: 'string', description: 'Directory to search. Defaults to the project root.' },
      limit: { type: 'integer', description: 'Maximum paths to return. Default 200.' },
    },
    required: ['pattern'],
  },
  summarize: (args) => `glob ${args.pattern}`,

  async execute(args, context): Promise<ToolResult> {
    const root = args.path ? resolveInWorkspace(args.path, context) : context.cwd
    const limit = Math.min(args.limit ?? 200, 2000)
    const pattern = args.pattern.replace(/^\.\//, '')
    const matcher = globToRegExp(pattern)
    let found: string[] = []

    // The Rust walker where it is available: enumeration is the whole cost of
    // this tool, and it is ~5× faster there. Measured, not assumed — the same
    // benchmark showed in-memory work is *slower* across the bridge, which is
    // why only the traversal is routed.
    const accelerated = await nativeWalk(root, { limit, include: pattern, extraIgnores: [...ALWAYS_IGNORE] })

    if (accelerated !== undefined) {
      found = accelerated
    } else {
      for await (const entry of walk(root, { signal: context.signal })) {
        if (entry.isDir) continue
        if (matcher.test(entry.relPath)) {
          found.push(entry.relPath)
          if (found.length >= limit) break
        }
      }
    }

    found.sort()
    if (found.length === 0) {
      return {
        output: `No files match \`${args.pattern}\`${args.path ? ` under ${args.path}` : ''}.`,
        display: { kind: 'glob', pattern: args.pattern, matches: [] },
      }
    }

    return {
      output: `${found.length} file${found.length === 1 ? '' : 's'} matching \`${args.pattern}\`:\n${found.join('\n')}${found.length >= limit ? '\n[limit reached]' : ''}`,
      display: { kind: 'glob', pattern: args.pattern, matches: found },
    }
  },
}

export const grepTool: Tool<{
  pattern: string
  path?: string
  include?: string
  caseSensitive?: boolean
  context?: number
  limit?: number
}> = {
  name: 'grep',
  risk: 'read',
  description: [
    'Search file contents with a regular expression. Respects .gitignore.',
    '',
    'Returns `path:line: text` for each match. Use `include` to restrict by',
    'filename glob (`**/*.ts`), and `context` to see surrounding lines.',
    '',
    'This is the fastest way to locate code — reach for it before reading files.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression (JavaScript syntax).' },
      path: { type: 'string', description: 'Directory to search. Defaults to the project root.' },
      include: { type: 'string', description: 'Only search files matching this glob.' },
      caseSensitive: { type: 'boolean', description: 'Default false.' },
      context: { type: 'integer', description: 'Lines of context around each match. Default 0.' },
      limit: { type: 'integer', description: 'Maximum matches. Default 100.' },
    },
    required: ['pattern'],
  },
  summarize: (args) => `grep ${args.pattern}${args.include ? ` in ${args.include}` : ''}`,

  async execute(args, context): Promise<ToolResult> {
    let regex: RegExp
    try {
      regex = new RegExp(args.pattern, args.caseSensitive ? '' : 'i')
    } catch (err) {
      throw new ToolError(
        `\`${args.pattern}\` is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
        'Escape regex metacharacters if you meant them literally.',
      )
    }

    const root = args.path ? resolveInWorkspace(args.path, context) : context.cwd
    const include = args.include ? globToRegExp(args.include) : undefined
    const limit = Math.min(args.limit ?? 100, 1000)
    const around = Math.min(Math.max(args.context ?? 0, 0), 5)

    const matches: { path: string; line: number; text: string }[] = []
    let filesScanned = 0
    let truncated = false

    // A pattern that is really a literal string goes to the Rust search, which
    // walks, reads, and matches in one parallel pass. Anything using regex
    // syntax stays with the JavaScript engine — the dialects differ at the
    // edges, and a search must not change meaning with the side that ran it.
    const literal = literalOf(args.pattern)
    const hits =
      literal === undefined
        ? undefined
        : await nativeSearch(root, literal, {
            caseSensitive: args.caseSensitive ?? false,
            include: args.include,
            // One more than asked, to know whether the limit cut anything off.
            limit: limit + 1,
            extraIgnores: [...ALWAYS_IGNORE],
          })

    if (hits !== undefined) {
      // A grep hit prints the matching line, so a credentials file is dropped
      // here exactly as the TypeScript path drops it.
      const visible = hits.filter((hit) => !isSecretFile(join(root, hit.path)))
      truncated = visible.length > limit
      const kept = visible.slice(0, limit)
      filesScanned = new Set(kept.map((hit) => hit.path)).size

      if (around === 0) {
        for (const hit of kept) matches.push({ path: hit.path, line: hit.line, text: hit.text })
      } else {
        await withContext(root, kept, around, matches)
      }
    }

    for await (const entry of hits !== undefined ? noEntries() : walk(root, { signal: context.signal })) {
      if (entry.isDir || entry.size > MAX_FILE_BYTES) continue
      if (include && !include.test(entry.relPath)) continue
      // A grep hit prints the matching line, so scanning a credentials file
      // leaks it just as surely as reading it would. `glob` still lists these
      // files: knowing a `.env` exists is useful, seeing inside it is not.
      if (isSecretFile(entry.absPath)) continue

      const buffer = await readFile(entry.absPath).catch(() => undefined)
      if (!buffer || buffer.subarray(0, 8192).includes(0)) continue
      filesScanned++

      const lines = buffer.toString('utf8').split('\n')
      for (const [i, line] of lines.entries()) {
        if (!regex.test(line)) continue

        if (around > 0) {
          const from = Math.max(0, i - around)
          const to = Math.min(lines.length - 1, i + around)
          for (let k = from; k <= to; k++) {
            matches.push({ path: entry.relPath, line: k + 1, text: lines[k]! })
          }
        } else {
          matches.push({ path: entry.relPath, line: i + 1, text: line })
        }

        if (matches.length >= limit) {
          truncated = true
          break
        }
      }
      if (truncated) break
    }

    if (matches.length === 0) {
      return {
        output: `No matches for \`${args.pattern}\` in ${filesScanned} file${filesScanned === 1 ? '' : 's'}.`,
        display: { kind: 'grep', pattern: args.pattern, matches: [] },
      }
    }

    const rendered = matches
      .map((m) => `${m.path}:${m.line}: ${m.text.trim().slice(0, 300)}`)
      .join('\n')
    const files = new Set(matches.map((m) => m.path)).size

    return {
      output: `${matches.length} match${matches.length === 1 ? '' : 'es'} in ${files} file${files === 1 ? '' : 's'}:\n${rendered}${truncated ? '\n[limit reached — narrow the pattern or raise `limit`]' : ''}`,
      display: { kind: 'grep', pattern: args.pattern, matches },
    }
  },
}

async function* noEntries(): AsyncGenerator<WalkEntry, void, void> {}

/** Expands hits into the lines around them, reading each file once. */
async function withContext(
  root: string,
  hits: { path: string; line: number }[],
  around: number,
  out: { path: string; line: number; text: string }[],
): Promise<void> {
  const byFile = new Map<string, number[]>()
  for (const hit of hits) byFile.set(hit.path, [...(byFile.get(hit.path) ?? []), hit.line])

  for (const [path, lines] of byFile) {
    const text = await readFile(join(root, path), 'utf8').catch(() => undefined)
    if (text === undefined) continue
    const all = text.split(/\r?\n/)
    for (const line of lines) {
      const from = Math.max(1, line - around)
      const to = Math.min(all.length, line + around)
      for (let k = from; k <= to; k++) out.push({ path, line: k, text: all[k - 1]! })
    }
  }
}

export const searchTools: Tool[] = [globTool, grepTool]

export { relative, sep }
