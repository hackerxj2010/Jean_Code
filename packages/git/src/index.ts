import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Tool, ToolResult } from '@jean/tools'
import { ToolError } from '@jean/tools'

/**
 * `@jean/git` — git operations (architecture §17).
 *
 * Git runs through `execFile` with an argument array, never a shell string.
 * That is not stylistic: branch names, commit messages, and paths come from the
 * model, and a shell would happily interpret whatever is in them.
 */

const run = promisify(execFile)

export interface GitResult {
  stdout: string
  stderr: string
  ok: boolean
}

/** Runs a git command in `cwd`. Never throws on a non-zero exit. */
export async function git(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run('git', args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      // Stop git from opening an editor or a credential prompt: this process
      // has no terminal to answer either.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
    })
    return { stdout, stderr, ok: true }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '', ok: false }
  }
}

export async function isRepository(cwd: string): Promise<boolean> {
  return (await git(['rev-parse', '--is-inside-work-tree'], cwd)).ok
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  const result = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  return result.ok ? result.stdout.trim() : undefined
}

export interface FileStatus {
  path: string
  /** Two-character porcelain code: index status then worktree status. */
  code: string
  staged: boolean
  untracked: boolean
}

/** Parses `git status --porcelain` into structured entries. */
export async function status(cwd: string): Promise<FileStatus[]> {
  // `--untracked-files=all` is not a detail: without it git collapses a new
  // directory into one entry (`src/`) and the files inside it are invisible.
  // An agent asking what changed wants the files, not a directory summary.
  const result = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd)
  if (!result.ok) return []

  const out: FileStatus[] = []
  // NUL-separated so paths with spaces or newlines survive intact.
  const records = result.stdout.split('\0').filter(Boolean)

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    const code = record.slice(0, 2)
    let path = record.slice(3)
    // A rename record is followed by its source path in the next field.
    if (code[0] === 'R' || code[0] === 'C') i++
    if (!path) continue
    out.push({
      path,
      code,
      staged: code[0] !== ' ' && code[0] !== '?',
      untracked: code === '??',
    })
  }
  return out
}

/** The default branch, as the remote reports it. Falls back to main/master. */
export async function defaultBranch(cwd: string): Promise<string> {
  const head = await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd)
  if (head.ok) {
    const match = /refs\/remotes\/origin\/(.+)$/.exec(head.stdout.trim())
    if (match?.[1]) return match[1]
  }
  for (const candidate of ['main', 'master']) {
    if ((await git(['rev-parse', '--verify', candidate], cwd)).ok) return candidate
  }
  return 'main'
}

/**
 * Groups changed files into commits by top-level area.
 *
 * A first cut at atomic commits (architecture §17.1): files under the same
 * package or directory belong together, and tests travel with the code they
 * cover. Dependency-ordered splitting needs the import graph, which is what
 * `crates/pi-ast` is for.
 */
export function groupForCommits(paths: string[]): { scope: string; paths: string[] }[] {
  const groups = new Map<string, string[]>()

  for (const path of paths) {
    const parts = path.split('/')
    // `packages/foo/src/x.ts` groups as `packages/foo`; `src/x.ts` as `src`.
    const scope =
      parts.length > 2 && (parts[0] === 'packages' || parts[0] === 'crates' || parts[0] === 'apps')
        ? `${parts[0]}/${parts[1]}`
        : (parts[0] ?? '.')
    const bucket = groups.get(scope)
    if (bucket) bucket.push(path)
    else groups.set(scope, [path])
  }

  // Plain code-unit ordering, not `localeCompare`: grouping must produce the
  // same commits on every machine, and ICU collation is locale-dependent.
  const byScope = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

  return [...groups.entries()]
    .map(([scope, groupPaths]) => ({ scope, paths: [...groupPaths].sort(byScope) }))
    .sort((a, b) => byScope(a.scope, b.scope))
}

export const gitStatusTool: Tool<Record<string, never>> = {
  name: 'git_status',
  risk: 'read',
  description:
    'Show the working tree status: which files are modified, staged, or untracked, and which branch is checked out.',
  parameters: { type: 'object', properties: {} },
  summarize: () => 'git status',

  async execute(_args, context): Promise<ToolResult> {
    if (!(await isRepository(context.cwd))) {
      return { output: 'This directory is not a git repository.' }
    }

    const [branch, files] = await Promise.all([currentBranch(context.cwd), status(context.cwd)])
    if (files.length === 0) {
      return { output: `On branch ${branch}. Working tree clean.` }
    }

    const rendered = files.map((f) => `  ${f.code} ${f.path}`).join('\n')
    return {
      output: `On branch ${branch}, ${files.length} changed file${files.length === 1 ? '' : 's'}:\n${rendered}`,
      display: { kind: 'git-status', branch, files },
    }
  },
}

export const gitDiffTool: Tool<{ staged?: boolean; path?: string }> = {
  name: 'git_diff',
  risk: 'read',
  description:
    'Show the diff of uncommitted changes. Set `staged: true` for what is staged. Pass `path` to limit it to one file.',
  parameters: {
    type: 'object',
    properties: {
      staged: { type: 'boolean', description: 'Show staged changes instead of unstaged.' },
      path: { type: 'string', description: 'Limit the diff to this path.' },
    },
  },
  summarize: (args) => `git diff${args.staged ? ' --staged' : ''}${args.path ? ` ${args.path}` : ''}`,

  async execute(args, context): Promise<ToolResult> {
    const argv = ['diff', '--no-color']
    if (args.staged) argv.push('--staged')
    if (args.path) argv.push('--', args.path)

    const result = await git(argv, context.cwd)
    if (!result.ok) throw new ToolError(result.stderr.trim() || 'git diff failed')
    if (!result.stdout.trim()) {
      return { output: args.staged ? 'Nothing staged.' : 'No unstaged changes.' }
    }

    const truncated =
      result.stdout.length > 30_000
        ? `${result.stdout.slice(0, 30_000)}\n[diff truncated — narrow it with \`path\`]`
        : result.stdout
    return { output: truncated, display: { kind: 'git-diff', diff: result.stdout } }
  },
}

export const gitLogTool: Tool<{ limit?: number; path?: string }> = {
  name: 'git_log',
  risk: 'read',
  description:
    'Show recent commits. Use this to learn a repository’s conventions — commit message style, how changes are usually scoped — before making your own.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'Number of commits. Default 15.' },
      path: { type: 'string', description: 'Only commits touching this path.' },
    },
  },
  summarize: (args) => `git log${args.path ? ` ${args.path}` : ''}`,

  async execute(args, context): Promise<ToolResult> {
    const argv = ['log', `-${Math.min(args.limit ?? 15, 100)}`, '--format=%h %an %ar%n  %s']
    if (args.path) argv.push('--', args.path)

    const result = await git(argv, context.cwd)
    if (!result.ok) throw new ToolError(result.stderr.trim() || 'git log failed')
    return { output: result.stdout.trim() || 'No commits yet.' }
  },
}

export const gitCommitTool: Tool<{ message: string; paths?: string[] }> = {
  name: 'git_commit',
  risk: 'write',
  description: [
    'Stage files and create a commit.',
    '',
    'Only commit when the user asked for it. Match the repository’s existing message',
    'style — check `git_log` first. If `paths` is omitted, everything already staged is',
    'committed; nothing is staged for you.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The commit message.' },
      paths: { type: 'array', description: 'Files to stage before committing.' },
    },
    required: ['message'],
  },
  summarize: (args) => `git commit -m "${args.message.split('\n')[0]!.slice(0, 60)}"`,

  async execute(args, context): Promise<ToolResult> {
    if (!(await isRepository(context.cwd))) {
      throw new ToolError('This directory is not a git repository.')
    }
    if (!args.message.trim()) throw new ToolError('The commit message is empty.')

    if (args.paths?.length) {
      // `--` separates paths from options, so a file named `-f` is still a file.
      const add = await git(['add', '--', ...args.paths], context.cwd)
      if (!add.ok) throw new ToolError(`could not stage files: ${add.stderr.trim()}`)
    }

    const staged = await git(['diff', '--staged', '--name-only'], context.cwd)
    if (!staged.stdout.trim()) {
      throw new ToolError(
        'Nothing is staged, so there is nothing to commit.',
        'Pass `paths` to stage the files you want in this commit.',
      )
    }

    const commit = await git(['commit', '-m', args.message], context.cwd)
    if (!commit.ok) throw new ToolError(commit.stderr.trim() || 'git commit failed')

    const files = staged.stdout.trim().split('\n')
    return {
      output: `${commit.stdout.trim()}\n\nCommitted ${files.length} file${files.length === 1 ? '' : 's'}.`,
      display: { kind: 'git-commit', message: args.message, files },
    }
  },
}

export const gitTools: Tool[] = [gitStatusTool, gitDiffTool, gitLogTool, gitCommitTool]
