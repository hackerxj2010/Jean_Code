import { execFile } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { nativeReady, type IsoView } from '@jean/native'

/**
 * `@jean/subagents` — isolation and result validation for fanned-out work
 * (architecture §12).
 *
 * The fan-out mechanism itself lives in `@jean/agent`, because spawning needs
 * the orchestrator's registry and client. What lives here is what makes
 * *parallel writing* safe: worktree isolation, and schema validation of what
 * comes back.
 */

const run = promisify(execFile)

export interface Worktree {
  /** Absolute path the sub-agent should treat as its project root. */
  path: string
  branch: string
  /** Merges the work back and removes the worktree. */
  finish(options?: { merge?: boolean }): Promise<MergeResult>
  /** Discards the worktree without merging. */
  discard(): Promise<void>
  /** What has changed so far, without finishing: files and changed line count. */
  changes(): Promise<{ files: string[]; lines: number }>
}

export interface MergeResult {
  merged: boolean
  /** Files that changed in the worktree. */
  files: string[]
  /** Paths that conflicted, when the merge could not complete. */
  conflicts: string[]
  message: string
}

/**
 * Creates an isolated git worktree for a sub-agent.
 *
 * Git worktrees rather than the copy-on-write filesystem tricks in
 * `crates/pi-iso`: they work identically on every platform and they are
 * already how developers isolate parallel work.
 *
 * Two properties matter, and both used to be wrong:
 *
 * * **It starts from the files as they are now**, not from `HEAD`. The parent
 *   agent has usually edited things this session without committing; a
 *   sub-agent working from `HEAD` would test, extend, or "fix" code that no
 *   longer exists. The snapshot takes tracked changes (`git stash create`,
 *   which touches nothing) and untracked files, and links dependency
 *   directories so the sub-agent can run the project's tests.
 *
 * * **Its work comes back uncommitted.** Merging used to be `git merge`,
 *   which put commits on the user's branch that nobody asked for. Now each
 *   changed file is merged three-way at file level: if the parent has not
 *   touched a file since the snapshot, the sub-agent's version is written;
 *   if both changed it differently, nothing is written and the conflict is
 *   reported. Byte-exact, so line endings and binaries survive, and no
 *   conflict markers are ever left in the user's files.
 *
 * Returns `undefined` outside a git repository, or in one with no commits yet,
 * which the caller treats as "run in place" rather than an error.
 */
export async function createWorktree(cwd: string, name: string): Promise<Worktree | undefined> {
  // Outside git — or in a repository with nothing committed — there is no
  // worktree to make, and parallel sub-agents would otherwise write into the
  // same tree. `pi-iso` makes a private copy instead.
  const inRepo = await git(['rev-parse', '--is-inside-work-tree'], cwd)
  if (!inRepo.ok) return createIsolatedCopy(cwd, name)
  const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], cwd)
  if (!head.ok) return createIsolatedCopy(cwd, name)

  // A commit object for the working tree's tracked changes, created without
  // touching the working tree, the index, or the stash list.
  const stash = await git(['stash', 'create'], cwd)
  const start = stash.stdout.trim() || head.stdout.trim()

  const safeName = name.replace(/[^A-Za-z0-9_-]/g, '-')
  const branch = `jean/${safeName}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const path = mkdtempSync(join(tmpdir(), `jean-wt-${safeName}-`))

  const created = await git(['worktree', 'add', '-q', '-b', branch, path, start], cwd)
  if (!created.ok) {
    rmSync(path, { recursive: true, force: true })
    return undefined
  }

  await copyUntracked(cwd, path)
  linkDependencies(cwd, path)

  // Freeze the snapshot as one commit, so "what the sub-agent changed" is a
  // plain diff against it.
  await git(['add', '-A'], path)
  await git([...IDENTITY, 'commit', '-q', '--allow-empty', '--no-verify', '-m', `jean: snapshot for ${name}`], path)
  const base = (await git(['rev-parse', 'HEAD'], path)).stdout.trim()

  return {
    path,
    branch,

    async finish(options = {}): Promise<MergeResult> {
      await git(['add', '-A'], path)
      const changes = await changedFiles(path, base)
      const files = changes.map((c) => c.path)

      if (files.length === 0) {
        await cleanup(cwd, path, branch)
        return { merged: false, files: [], conflicts: [], message: 'The sub-agent changed nothing.' }
      }

      // Keep the work on the branch whatever happens next, so a refused merge
      // loses nothing.
      await git([...IDENTITY, 'commit', '-q', '--no-verify', '-m', `jean: ${name}`], path)

      if (options.merge === false) {
        await removeWorktree(cwd, path)
        return {
          merged: false,
          files,
          conflicts: [],
          message: `Left on branch ${branch}: ${files.length} file(s) changed. Apply it yourself when ready.`,
        }
      }

      const plan = await planMerge(cwd, path, base, changes)
      if (plan.conflicts.length > 0) {
        await removeWorktree(cwd, path)
        return {
          merged: false,
          files,
          conflicts: plan.conflicts,
          message: `Could not merge ${name}: ${plan.conflicts.length} file(s) were also changed in the main tree (${plan.conflicts.join(', ')}). Nothing was written; the work is on branch ${branch}.`,
        }
      }

      for (const step of plan.writes) {
        const target = join(cwd, step.path)
        if (step.content === undefined) {
          rmSync(target, { force: true })
        } else {
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, step.content)
        }
      }

      await cleanup(cwd, path, branch)
      return {
        merged: true,
        files,
        conflicts: [],
        message: `Merged ${files.length} file(s) from ${name} into the working tree (uncommitted).`,
      }
    },

    async discard(): Promise<void> {
      await cleanup(cwd, path, branch)
    },

    async changes(): Promise<{ files: string[]; lines: number }> {
      await git(['add', '-A'], path)
      const numstat = await git(['diff', '--cached', '--numstat', base], path)
      let lines = 0
      const files: string[] = []
      for (const row of numstat.stdout.split('\n').filter(Boolean)) {
        const [added, removed, file] = row.split('\t')
        // Binary files report `-`; count them as one line so they are not free.
        lines += (Number(added) || 1) + (Number(removed) || 0)
        if (file) files.push(file)
      }
      return { files, lines }
    },
  }
}

/** Never copied into an isolated view: dependencies are linked, the rest is regenerated. */
const ISOLATION_EXCLUDES = [
  '.git', 'node_modules', '.venv', 'venv', 'target', 'dist', 'build', '.next', '.turbo', '.cache', '__pycache__',
]

/** Past this many files a copy takes long enough that running in place is the better trade. */
const MAX_ISOLATED_FILES = 20_000

/**
 * A private copy of a project that is not a git repository, made and merged
 * by `crates/pi-iso`.
 *
 * The copy leaves out dependencies and build output and links the dependency
 * directories back, as the git worktree does. Merging back is planned against
 * the snapshot taken at creation: a file the sub-agent changed that nobody
 * else touched is written; one that also changed in the main tree meanwhile is
 * a conflict, and a plan with any conflict writes nothing.
 *
 * `undefined` when the native bridge is not built or the project is too large
 * to copy, which the caller treats as "run in place" as before.
 */
export async function createIsolatedCopy(cwd: string, name: string): Promise<Worktree | undefined> {
  const native = await nativeReady()
  if (!native) return undefined

  try {
    const listed = await native.walk(cwd, {
      filesOnly: true,
      respectGitignore: false,
      skipHidden: false,
      extraIgnores: ISOLATION_EXCLUDES,
      limit: MAX_ISOLATED_FILES + 1,
    })
    if (listed.count > MAX_ISOLATED_FILES) return undefined
  } catch {
    return undefined
  }

  const safeName = name.replace(/[^A-Za-z0-9_-]/g, '-')
  const path = mkdtempSync(join(tmpdir(), `jean-iso-${safeName}-`))
  let view: IsoView
  try {
    view = await native.isoCreate(cwd, path, ISOLATION_EXCLUDES)
  } catch {
    rmSync(path, { recursive: true, force: true })
    return undefined
  }
  linkDependencies(cwd, path)

  const discard = async (): Promise<void> => {
    // Links first: deleting the view must never follow one into the real tree.
    unlinkDependencies(path)
    await native.isoDiscard(view.id).catch(() => false)
    rmSync(path, { recursive: true, force: true })
  }

  return {
    path,
    branch: `(isolated copy, ${view.backend})`,

    async finish(options = {}): Promise<MergeResult> {
      const changed = await native.isoChanges(view.id)
      const files = changed.map((change) => change.path)

      if (files.length === 0) {
        await discard()
        return { merged: false, files: [], conflicts: [], message: 'The sub-agent changed nothing.' }
      }

      if (options.merge === false) {
        unlinkDependencies(path)
        return {
          merged: false,
          files,
          conflicts: [],
          message: `Left in ${path}: ${files.length} file(s) changed. Copy them back yourself when ready.`,
        }
      }

      const merged = await native.isoMerge(view.id)
      if (merged.conflicts.length > 0) {
        unlinkDependencies(path)
        const conflicts = merged.conflicts.map((conflict) => conflict.path)
        return {
          merged: false,
          files,
          conflicts,
          message: `Could not merge ${name}: ${conflicts.length} file(s) were also changed in the main tree (${conflicts.join(', ')}). Nothing was written; the work is still in ${path}.`,
        }
      }

      await discard()
      return {
        merged: true,
        files,
        conflicts: [],
        message: `Merged ${merged.applied} file(s) from ${name} into the working tree.`,
      }
    },

    discard,

    async changes(): Promise<{ files: string[]; lines: number }> {
      const changed = await native.isoChanges(view.id)
      let lines = 0
      for (const change of changed) {
        const ours = readMaybe(join(path, change.path))
        const theirs = readMaybe(join(cwd, change.path))
        const count = (buffer: Buffer | undefined) => (buffer ? buffer.toString('utf8').split('\n').length : 0)
        // Not a diff, but the same order of magnitude, and a binary file still counts.
        lines += Math.max(1, Math.abs(count(ours) - count(theirs)) || Math.min(count(ours), count(theirs)))
      }
      return { files: changed.map((change) => change.path), lines }
    },
  }
}

/** Commits in the scratch worktree must not depend on the user's git identity or signing setup. */
const IDENTITY = ['-c', 'user.name=Jean Code', '-c', 'user.email=jean@localhost', '-c', 'commit.gpgsign=false']

interface Change {
  path: string
  status: 'A' | 'M' | 'D'
}

/** Files that differ from `base` in the (staged) worktree. */
async function changedFiles(worktree: string, base: string): Promise<Change[]> {
  const out = await git(['diff', '--cached', '--name-status', '--no-renames', '-z', base], worktree)
  const fields = out.stdout.split('\0').filter(Boolean)
  const changes: Change[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i]!.charAt(0)
    changes.push({ path: fields[i + 1]!, status: status === 'A' ? 'A' : status === 'D' ? 'D' : 'M' })
  }
  return changes
}

/**
 * Decides, file by file, what merging the sub-agent's work would do.
 *
 * Nothing is written here: a merge with any conflict writes nothing at all,
 * because half of a sub-agent's change is usually worse than none of it.
 */
async function planMerge(
  cwd: string,
  worktree: string,
  base: string,
  changes: Change[],
): Promise<{ writes: { path: string; content: Buffer | undefined }[]; conflicts: string[] }> {
  const writes: { path: string; content: Buffer | undefined }[] = []
  const conflicts: string[] = []

  for (const change of changes) {
    const original = change.status === 'A' ? undefined : await blob(worktree, `${base}:${change.path}`)
    const current = readMaybe(join(cwd, change.path))
    const theirs = change.status === 'D' ? undefined : readMaybe(join(worktree, change.path))

    if (same(current, original)) {
      writes.push({ path: change.path, content: theirs })
    } else if (!same(current, theirs)) {
      conflicts.push(change.path)
    }
    // Otherwise the main tree already has exactly this change.
  }
  return { writes, conflicts }
}

function same(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.equals(b)
}

function readMaybe(path: string): Buffer | undefined {
  try {
    return statSync(path).isFile() ? readFileSync(path) : undefined
  } catch {
    return undefined
  }
}

async function blob(cwd: string, spec: string): Promise<Buffer | undefined> {
  try {
    const { stdout } = await run('git', ['show', spec], {
      cwd,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout as unknown as Buffer
  } catch {
    return undefined
  }
}

/** Untracked, non-ignored files are in no commit; copy them into the snapshot. */
async function copyUntracked(cwd: string, worktree: string): Promise<void> {
  const listed = await git(['ls-files', '--others', '--exclude-standard', '-z'], cwd)
  for (const rel of listed.stdout.split('\0').filter(Boolean)) {
    const source = join(cwd, rel)
    const target = join(worktree, rel)
    try {
      if (!statSync(source).isFile()) continue
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
    } catch {
      // A file that vanished or cannot be read is simply not in the snapshot.
    }
  }
}

/**
 * Makes installed dependencies visible in the worktree without copying them.
 *
 * They are ignored, so no commit carries them, and without them the sub-agent
 * cannot run the tests it was probably spawned to make pass. Junctions on
 * Windows need no privileges; build output is deliberately not linked, since
 * two agents building into one directory would corrupt each other.
 */
function linkDependencies(cwd: string, worktree: string): void {
  for (const dir of ['node_modules', '.venv', 'venv']) {
    const source = join(cwd, dir)
    const target = join(worktree, dir)
    try {
      if (!statSync(source).isDirectory() || existsSync(target)) continue
      symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      // Linking is a convenience; the sub-agent can still install if it must.
    }
  }
}

async function removeWorktree(cwd: string, path: string): Promise<void> {
  unlinkDependencies(path)
  await git(['worktree', 'remove', '--force', path], cwd)
  rmSync(path, { recursive: true, force: true })
}

async function cleanup(cwd: string, path: string, branch: string): Promise<void> {
  await removeWorktree(cwd, path)
  await git(['branch', '-D', branch], cwd)
}

/**
 * Removes dependency links before the worktree is deleted, so a recursive
 * delete can never follow one into the user's real `node_modules`.
 */
function unlinkDependencies(worktree: string): void {
  for (const dir of ['node_modules', '.venv', 'venv']) {
    const target = join(worktree, dir)
    try {
      if (lstatSync(target).isSymbolicLink()) unlinkSync(target)
    } catch {
      // Not linked, or already gone.
    }
  }
}

async function git(args: string[], cwd: string): Promise<{ stdout: string; ok: boolean }> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })
    return { stdout, ok: true }
  } catch (err) {
    return { stdout: (err as { stdout?: string }).stdout ?? '', ok: false }
  }
}

/**
 * Validates a sub-agent's structured result against a JSON Schema subset.
 *
 * Sub-agents are asked for typed objects rather than prose so the parent does
 * not have to parse English. This checks that what came back is usable, and
 * says precisely what is wrong when it is not, so the parent can re-ask.
 */
export interface Schema {
  type: 'object'
  properties: Record<string, { type: string; description?: string; items?: { type: string } }>
  required?: string[]
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
  value?: Record<string, unknown>
}

export function validateResult(raw: string, schema: Schema): ValidationResult {
  // Models wrap JSON in prose and fences more often than not; find the object.
  const json = extractJson(raw)
  if (!json) {
    return { valid: false, errors: ['no JSON object found in the result'] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    return {
      valid: false,
      errors: [`result was not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
    }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, errors: ['result must be a JSON object'] }
  }

  const value = parsed as Record<string, unknown>
  const errors: string[] = []

  for (const key of schema.required ?? []) {
    if (value[key] === undefined) errors.push(`missing required field "${key}"`)
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    const provided = value[key]
    if (provided === undefined) continue
    if (!typeMatches(spec.type, provided)) {
      errors.push(`"${key}" must be a ${spec.type}`)
    }
  }

  return { valid: errors.length === 0, errors, value }
}

/** Finds the outermost JSON object in a blob of text. */
export function extractJson(text: string): string | undefined {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text)
  const candidate = fenced?.[1] ?? text

  const start = candidate.indexOf('{')
  if (start === -1) return undefined

  // Balance braces, ignoring any inside string literals.
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return candidate.slice(start, i + 1)
  }

  return undefined
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
    case 'integer':
      return typeof value === 'number'
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    default:
      return true
  }
}
