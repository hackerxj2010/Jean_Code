import { readFile } from 'node:fs/promises'
import { nativeReady } from '@jean/native'
import { walk } from '@jean/tools'
import { languageForFile } from './symbols.ts'

/**
 * Structural search.
 *
 * Matches code by shape rather than by text. `grep` for `catch (e) {}` misses
 * `catch (err) {}`, `catch(e){}`, and the multi-line form; a structural pattern
 * with a metavariable matches all three and nothing else.
 *
 * The architecture calls for tree-sitter, which is a native dependency this
 * build does not take. This is a pattern-to-regex compiler instead: it handles
 * the flat, single-statement patterns that cover the overwhelming majority of
 * "find every place that does X" searches, and it is honest about what it
 * cannot do — nested structure and balanced delimiters need a real parser.
 */

export interface StructuralMatch {
  path: string
  line: number
  text: string
  /** What each metavariable captured. */
  captures: Record<string, string>
}

export interface PatternOptions {
  /** Restricts to files of one language. */
  language?: string
  include?: RegExp
  limit?: number
  signal?: AbortSignal
}

/**
 * Compiles a pattern into a regular expression.
 *
 * `$NAME` captures one expression — an identifier, a literal, a call, or a
 * parenthesized group. `$$$` matches any run of arguments or statements.
 * Everything else is literal, with whitespace made flexible so formatting does
 * not defeat the match.
 */
export function compilePattern(pattern: string): { regex: RegExp; names: string[] } {
  const names: string[] = []
  let out = ''
  let i = 0

  while (i < pattern.length) {
    // `$$$` — a wildcard run, as in `foo($$$)`.
    if (pattern.startsWith('$$$', i)) {
      out += '[\\s\\S]*?'
      i += 3
      continue
    }

    // `$NAME` — a single captured expression.
    const metavariable = /^\$([A-Z_][A-Z0-9_]*)/.exec(pattern.slice(i))
    if (metavariable) {
      const name = metavariable[1]!
      names.push(name)
      // One expression: an identifier with member access and an optional call,
      // a string, or a number. Deliberately not "anything up to the next
      // token", which would swallow the rest of the line.
      out += `(?<${name}>[A-Za-z_$][\\w$]*(?:\\.[\\w$]+)*(?:\\([^()]*\\))?|"[^"]*"|'[^']*'|\`[^\`]*\`|-?\\d+(?:\\.\\d+)?)`
      i += metavariable[0].length
      continue
    }

    const char = pattern[i]!

    // Whitespace in a pattern matches any whitespace, including none between
    // punctuation — so `catch (e) {}` also matches `catch(e){}`.
    if (/\s/.test(char)) {
      out += '\\s*'
      while (i < pattern.length && /\s/.test(pattern[i]!)) i++
      continue
    }

    out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    i++
  }

  return { regex: new RegExp(out, 'g'), names }
}

/** Searches text for a compiled pattern. */
export function matchInText(
  text: string,
  pattern: string,
  path = '<text>',
): StructuralMatch[] {
  const { regex, names } = compilePattern(pattern)
  const matches: StructuralMatch[] = []

  // Line offsets, so a match's index becomes a line number without re-scanning.
  const lineStarts: number[] = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineStarts.push(i + 1)
  }

  regex.lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    // A zero-width match would loop forever.
    if (match[0].length === 0) {
      regex.lastIndex++
      continue
    }

    let line = lineStarts.findIndex((start) => start > match!.index)
    line = line === -1 ? lineStarts.length : line

    const captures: Record<string, string> = {}
    for (const name of names) {
      const value = match.groups?.[name]
      if (value !== undefined) captures[name] = value
    }

    matches.push({
      path,
      line,
      text: match[0].replace(/\s+/g, ' ').trim().slice(0, 200),
      captures,
    })
  }

  return matches
}

/**
 * Searches a directory tree.
 *
 * The `pi-ast` crate does it when the bridge is built: it matches over a real
 * token stream, so a metavariable takes a whole bracketed expression and a
 * commented-out call is not a call — the two things the regex compiler above
 * gets wrong. Its results are held to the same contract as this file's: only
 * languages the code map covers, the same language and include filters.
 *
 * When the crate finds nothing, the regex search still runs. A comment
 * directive such as `@ts-ignore` is text rather than code, and is exactly what
 * a token matcher skips.
 */
export async function searchStructural(
  root: string,
  pattern: string,
  options: PatternOptions = {},
): Promise<StructuralMatch[]> {
  const limit = options.limit ?? 200

  const structural = await searchNative(root, pattern, options, limit)
  if (structural !== undefined && structural.length > 0) return structural

  return searchWithRegex(root, pattern, options, limit)
}

async function searchNative(
  root: string,
  pattern: string,
  options: PatternOptions,
  limit: number,
): Promise<StructuralMatch[] | undefined> {
  const native = await nativeReady()
  if (!native) return undefined

  const filtered = options.language !== undefined || options.include !== undefined
  let hits: Awaited<ReturnType<typeof native.searchTree>>
  try {
    // Over-fetched when a filter applies here, after the search.
    hits = await native.searchTree(root, pattern, { limit: filtered ? limit * 4 : limit * 2 })
  } catch {
    return undefined
  }

  const matches: StructuralMatch[] = []
  for (const hit of hits) {
    const path = hit.path ?? ''
    const language = languageForFile(path)
    if (!language) continue
    if (options.language && language !== options.language) continue
    if (options.include && !options.include.test(path)) continue
    matches.push({
      path,
      line: hit.line,
      text: hit.text.replace(/\s+/g, ' ').trim().slice(0, 200),
      captures: hit.captures,
    })
    if (matches.length >= limit) break
  }
  return matches
}

async function searchWithRegex(
  root: string,
  pattern: string,
  options: PatternOptions,
  limit: number,
): Promise<StructuralMatch[]> {
  const matches: StructuralMatch[] = []

  for await (const entry of walk(root, { signal: options.signal })) {
    if (entry.isDir || entry.size > 2_000_000) continue
    if (options.include && !options.include.test(entry.relPath)) continue

    const language = languageForFile(entry.relPath)
    if (!language) continue
    if (options.language && language !== options.language) continue

    const text = await readFile(entry.absPath, 'utf8').catch(() => undefined)
    if (text === undefined) continue

    for (const match of matchInText(text, pattern, entry.relPath)) {
      matches.push(match)
      if (matches.length >= limit) return matches
    }
  }

  return matches
}

/**
 * Patterns worth suggesting, since the syntax is not obvious.
 *
 * Each is a real search someone runs during a review or a migration.
 */
export const EXAMPLE_PATTERNS: { pattern: string; finds: string }[] = [
  { pattern: 'catch ($E) {}', finds: 'swallowed exceptions' },
  { pattern: 'console.log($$$)', finds: 'leftover logging' },
  { pattern: 'await $CALL', finds: 'every awaited call' },
  { pattern: 'if ($COND) return', finds: 'guard clauses' },
  { pattern: 'JSON.parse($ARG)', finds: 'parses that may throw' },
  { pattern: 'process.env.$NAME', finds: 'environment reads' },
  { pattern: 'new $CLASS($$$)', finds: 'construction sites' },
  { pattern: '@ts-ignore', finds: 'suppressed type errors' },
]
