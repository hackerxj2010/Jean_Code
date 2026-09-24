/**
 * The tools' way into the Rust core (architecture §8).
 *
 * Every helper here returns `undefined` when the native path is unavailable —
 * the binary is not built, `JEAN_NATIVE=0`, or the call failed — rather than
 * throwing or falling back internally. The caller already has a TypeScript
 * path, and having it choose keeps the fallback visible at the call site
 * instead of buried here.
 *
 * ## What is routed, and why
 *
 * Traversal is the cost of `glob`, `grep`, and every `walk()`: the TypeScript
 * walker takes ~480 ms on this repository where the Rust one takes ~87 ms. The
 * Rust walk also reports each entry's type and size, which saves a `stat` per
 * path on this side. Literal content search is done in the same parallel pass.
 *
 * Work that is already in memory — a patch, a line's anchor — is routed too,
 * because the Rust crates are the reference implementation and the TypeScript
 * ports are held to them by the parity tests. The round trip is a millisecond
 * or two, against a model call measured in seconds.
 */

import { nativeReady, type AstMatch, type PatchApplied, type SearchHit } from '@jean/native'
import { HashlineError } from './hashline.ts'

export { closeNative } from '@jean/native'

/** Whether the native bridge is built and answering. Cached per process. */
export async function nativeAvailable(): Promise<boolean> {
  return (await nativeReady()) !== undefined
}

/**
 * Files under `root` matching `include` (or every entry, without it), as paths
 * relative to it.
 */
export async function nativeWalk(
  root: string,
  options: { limit?: number; include?: string; extraIgnores?: string[] } = {},
): Promise<string[] | undefined> {
  const native = await nativeReady()
  if (!native) return undefined

  try {
    const result =
      options.include !== undefined
        ? await native.glob(root, options.include, options.limit, { extraIgnores: options.extraIgnores })
        : await native.walk(root, { limit: options.limit, extraIgnores: options.extraIgnores })
    return result.paths
  } catch {
    // A single failed call does not disable the bridge: it may be this
    // argument, not the child.
    return undefined
  }
}

export interface NativeEntry {
  relPath: string
  isDir: boolean
  size: number
}

/**
 * Every entry under `root` with its type and size, shallowest first.
 *
 * Shallowest first because that is the order the TypeScript walker yields in
 * (breadth-first), and callers that stop early — a codemap under a file
 * budget — should keep the files near the root either way.
 */
export async function nativeEntries(
  root: string,
  options: {
    includeHidden?: boolean
    respectGitignore?: boolean
    maxDepth?: number
    limit?: number
    extraIgnores?: string[]
  } = {},
): Promise<NativeEntry[] | undefined> {
  const native = await nativeReady()
  if (!native) return undefined

  try {
    const result = await native.walk(root, {
      details: true,
      skipHidden: !options.includeHidden,
      respectGitignore: options.respectGitignore !== false,
      maxDepth: options.maxDepth,
      limit: options.limit,
      extraIgnores: options.extraIgnores,
    })
    const entries = (result.entries ?? []).map((entry) => ({
      relPath: entry.path,
      isDir: entry.dir,
      size: entry.size,
    }))
    const depth = (path: string) => path.split('/').length
    entries.sort(
      (a, b) =>
        depth(a.relPath) - depth(b.relPath) || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0),
    )
    return entries
  } catch {
    return undefined
  }
}

/** Literal content search over a tree, in the walker's own parallel pass. */
export async function nativeSearch(
  root: string,
  literal: string,
  options: { caseSensitive?: boolean; include?: string; limit?: number; extraIgnores?: string[] } = {},
): Promise<SearchHit[] | undefined> {
  const native = await nativeReady()
  if (!native) return undefined

  try {
    return await native.search(root, literal, options)
  } catch {
    return undefined
  }
}

/**
 * Structural search over a tree.
 *
 * The Rust matcher and the TypeScript one in `@jean/codemap` agree on the
 * pattern language; this is the faster of the two and covers more languages.
 */
export async function nativeSearchTree(
  root: string,
  pattern: string,
  options: { glob?: string; limit?: number } = {},
): Promise<AstMatch[] | undefined> {
  const native = await nativeReady()
  if (!native) return undefined

  try {
    return await native.searchTree(root, pattern, options)
  } catch {
    return undefined
  }
}

/**
 * The text a JavaScript regular expression matches, when it matches only one
 * literal string — `foo`, `foo\.bar`, `a\(b\)` — and `undefined` for anything
 * with a real metacharacter. Such a pattern can go to the Rust literal search
 * and mean exactly the same thing there.
 */
export function literalOf(pattern: string): string | undefined {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '\\') {
      const next = pattern[i + 1]
      // `\d`, `\w`, `\b`, `\s`… are classes and assertions, not characters.
      if (next === undefined || !/[.*+?^${}()|[\]\\/\-]/.test(next)) return undefined
      out += next
      i++
      continue
    }
    if (/[.*+?^${}()|[\]]/.test(c)) return undefined
    out += c
  }
  return out === '' ? undefined : out
}

/** The anchor of each line, from the `hashline` crate. */
export async function nativeAnchors(lines: string[]): Promise<string[] | undefined> {
  const native = await nativeReady()
  if (!native) return undefined

  try {
    const anchors = await native.anchors(lines)
    return anchors.length === lines.length ? anchors : undefined
  } catch {
    return undefined
  }
}

const PATCH_ERROR = /^\[(anchor-not-found|context-mismatch|ambiguous-anchor|parse)\] ([\s\S]*)$/

/**
 * Applies a hashline patch in the `hashline` crate.
 *
 * A patch the crate rejects throws the same {@link HashlineError} the
 * TypeScript port would, code and all, so the caller's advice to the agent
 * does not depend on which side ran. `undefined` means the bridge itself was
 * unavailable, and the caller should apply the patch in TypeScript.
 */
export async function nativePatch(content: string, patch: string): Promise<PatchApplied | undefined> {
  const native = await nativeReady()
  if (!native) return undefined

  try {
    return await native.applyPatch(content, patch)
  } catch (error) {
    const match = PATCH_ERROR.exec(error instanceof Error ? error.message : String(error))
    if (match) throw new HashlineError(match[2]!, match[1] as HashlineError['code'])
    return undefined
  }
}

/**
 * The simple commands a shell line would run, as the `pi-shell` parser sees
 * them: quotes resolved (`'r''m'` is `rm`), and command substitutions
 * (`$(curl x)`) listed as commands of their own. `undefined` when the bridge
 * is unavailable or the line does not parse.
 *
 * This is what the deny list and the permission rules check, alongside the raw
 * text: a text match is defeated by quoting that the shell then removes.
 */
export async function nativeCommandLines(command: string): Promise<string[] | undefined> {
  const native = await nativeReady()
  if (!native) return undefined

  try {
    const inspected = await native.shellInspect(command)
    return inspected.parsed ? inspected.commands.map((c) => c.line) : undefined
  } catch {
    return undefined
  }
}

/**
 * Kills a process and every process it started, through `pi-sys`. Returns
 * false when the bridge is unavailable or the kill failed, so the caller can
 * fall back to killing just the process it holds.
 *
 * `child.kill()` on a shell ends the shell and orphans what it launched — the
 * dev server, the test runner — which then holds its port until reboot.
 */
export async function nativeKillTree(pid: number): Promise<boolean> {
  const native = await nativeReady()
  if (!native) return false

  try {
    const report = await native.killTree(pid, true)
    return report.failed.length === 0
  } catch {
    return false
  }
}
