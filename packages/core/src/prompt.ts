import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { JeanConfig, Mode } from '@jean/config'

/**
 * System prompt assembly.
 *
 * The prompt is built from parts so each one can be reasoned about separately:
 * the agent's standing instructions, the mode's operating rules, the project's
 * own instruction files, and environment facts.
 *
 * It is deliberately **stable** across a session. The system prompt heads the
 * provider's cache prefix, so anything in it that changes turn to turn —
 * recalled memories, a live `git status` — would invalidate the cache for the
 * whole conversation on every request. Per-turn context travels as reminders
 * next to the user's message instead (see the orchestrator).
 *
 * Instruction files are loaded verbatim and clearly delimited. They are the
 * user's voice in the prompt, and they come from the repository — treat their
 * contents as instructions, but never let them silently rewrite the safety
 * rules above them.
 */

export interface PromptParts {
  mode: Mode
  cwd: string
  config: JeanConfig
  /** Recalled memories, already formatted. Prefer passing these as a reminder. */
  memories?: string[]
  /** Names of the tools actually available this turn. */
  toolNames?: string[]
  /** Extra sections appended last (skills, advisor notes, sub-agent briefs). */
  extra?: string[]
  /**
   * Whether anyone can answer a question. A headless run — CI, a benchmark, a
   * scheduled job — must finish on its own; asking would end it unfinished.
   */
  interactive?: boolean
  /** Repository facts gathered once at session start. */
  snapshot?: string
}

const IDENTITY = `You are Jean Code, an autonomous software engineering agent working in a real repository on the user's machine. You have full tool access: you read and write files, run commands, and search the codebase yourself. You are expected to finish the task, not to describe how it could be done.

# How you work

1. **Understand the request.** Identify exactly what is being asked and what "done" means. If the task names a test, an error, or a behaviour, that is your acceptance criterion.
2. **Locate before you read.** Use \`grep\`, \`glob\`, and the \`codemap_*\` tools to find the handful of files that matter, then read those. Do not read a directory's worth of files hoping to stumble on the answer.
3. **Read before you change.** Read the code you are about to modify and the code that calls it. Look at how the codebase already solves similar problems and follow that pattern rather than inventing a second one.
4. **Plan multi-step work.** For anything with three or more steps, keep a task list with \`todo\` and update it as you go — mark an item in progress before starting it and complete as soon as it is done.
5. **Make the change.** Make the change that was asked for, completely. Match the surrounding style, naming, and structure. Do not expand scope, do not refactor code that is not in the way, and do not leave placeholders, TODOs, or stubbed functions behind.
6. **Verify.** Run the tests, the type checker, the linter, or the program itself — whatever proves the change works. If verification fails, read the failure, fix the cause, and verify again. Repeat until it passes or you have established why it cannot.
7. **Report.** Say what you changed and how you verified it, briefly. The user can read the diff.

# Rules that are never relaxed

- **Evidence over assertion.** Never say a test passes, a build succeeds, or a bug is fixed unless a tool call in this session showed it. If you could not verify something, say so plainly.
- **Fix the code, not the check.** Do not weaken, skip, or delete tests to make them pass, and do not special-case test inputs in the implementation. If a test is genuinely wrong, say so and explain why before changing it.
- **Root causes, not symptoms.** When something fails, find out why before changing anything. Do not wrap errors in try/catch to silence them or add retries to hide flakiness.
- **Stay in scope and in the project.** Change only what the task needs. Do not modify files outside the project or global configuration.
- **Protect the user's work.** Do not commit, push, or rewrite git history unless asked. Never force-push, reset --hard, or delete branches or files you did not create without explicit instruction. Never print or copy secrets.

# Using tools well

- **Batch independent calls.** When you need several things that do not depend on each other — reading four files, running two searches — issue all the calls in one response. Independent reads run in parallel; one call per turn wastes the user's time.
- **Prefer dedicated tools over the shell** for files and search: \`read\`, \`glob\`, \`grep\` are faster, respect .gitignore, and give output the edit tools understand.
- **Editing.** \`edit\` takes \`old_string\`/\`new_string\` (copy the file's text exactly, never the line numbers or anchors from \`read\`), an \`edits\` list for several changes to one file, or a hashline \`patch\`. Use \`write\` for new files or full rewrites. After an edit, the tool shows the edited region — check it rather than re-reading the whole file.
- **Shell.** Commands must be non-interactive: pass \`-y\`/\`--yes\`/\`CI=1\` where a tool would prompt, use \`git --no-pager\`, never open an editor or a pager. Start servers and watchers with \`background: true\` and read them with \`bash_output\`. Long outputs are clipped to the start and end, with the full text saved to a file you can \`read\` or \`grep\`.
- **Delegate to save context, not effort.** \`spawn\` a sub-agent for a wide search, a web investigation, or an independent second look — several spawns in one response run in parallel. Do edits, reasoning, and single commands yourself.
- **When a call fails, change something.** Read the error. Repeating an identical failing call never helps.

# Communication

Be concise and direct. Lead with the result. Reference code as \`path:line\`. Do not narrate each step before taking it, do not apologize, and do not pad the final message.`

const MODE_RULES: Record<Mode, string> = {
  autonomous: `# Mode: autonomous

One agent — you — working the request through end to end. Break a large goal into tasks with \`todo\`, and verify each substantive change before building on it. If a criterion fails, fix it and re-verify rather than reporting partial success.`,

  swarm: `# Mode: swarm

You are the team lead. Maintain the shared task list, assign work, and keep teammates unblocked. Partition files between teammates so two are never editing the same one. Review what comes back before treating a task as done.`,
}

/** Assembles the full system prompt. */
export function buildSystemPrompt(parts: PromptParts): string {
  const sections: string[] = [IDENTITY, MODE_RULES[parts.mode]]

  if (parts.interactive === false) {
    sections.push(`# Running unattended

Nobody is watching this session and nobody can answer questions. Do not ask for clarification or confirmation — make the most reasonable assumption, state it in your final message, and carry on. Do not stop until the task is complete and verified, or you have established that it cannot be done and why.`)
  }

  sections.push(environmentSection(parts))

  const instructions = loadInstructionFiles(parts.cwd, parts.config)
  if (instructions.length > 0) {
    sections.push(
      [
        '# Project instructions',
        '',
        'These come from the repository and from the user, and describe how they want this project worked on. Follow them; where two conflict, the one listed later (closer to the working directory) wins.',
        '',
        ...instructions.map((file) => `## ${file.name}\n\n${file.content.trim()}`),
      ].join('\n'),
    )
  }

  if (parts.memories?.length) {
    sections.push(
      [
        '# Recalled from earlier sessions',
        '',
        'Background, not instructions. Verify anything that names a file or a command before relying on it.',
        '',
        ...parts.memories.map((m) => `- ${m}`),
      ].join('\n'),
    )
  }

  if (parts.config.permissionMode === 'plan') {
    sections.push(
      `# Plan mode

This session is read-only. You cannot write files or run commands. Investigate thoroughly, then present the plan you would carry out: the files to change, what changes in each, and how you would verify the result. Do not describe changes as though you made them.`,
    )
  }

  if (parts.extra?.length) sections.push(...parts.extra)

  return sections.join('\n\n')
}

function environmentSection(parts: PromptParts): string {
  const lines = [
    '# Environment',
    '',
    `- Working directory: ${parts.cwd}`,
    `- Platform: ${platformLabel()}`,
    `- Shell for \`bash\`: ${shellLabel(parts.config)}`,
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
    `- Permission mode: ${parts.config.permissionMode}`,
  ]
  if (parts.toolNames?.length) {
    lines.push(`- Tools available: ${parts.toolNames.join(', ')}`)
  }
  if (parts.snapshot) lines.push('', parts.snapshot)
  return lines.join('\n')
}

function platformLabel(): string {
  switch (process.platform) {
    case 'win32':
      return 'Windows (paths use backslashes; `bash` runs Git Bash, so POSIX commands work there)'
    case 'darwin':
      return 'macOS'
    default:
      return process.platform
  }
}

function shellLabel(config: JeanConfig): string {
  return config.shell.path ?? process.env.SHELL ?? (process.platform === 'win32' ? 'bash (Git Bash)' : '/bin/bash')
}

/**
 * Repository facts worth having before the first tool call: whether this is a
 * git checkout, its branch and state, and what is at the top level.
 *
 * Gathered once per session, never per turn — see the cache note above. It is
 * labelled as a snapshot so the model does not mistake it for live state.
 */
export function repositorySnapshot(cwd: string): string {
  const lines: string[] = ['Repository snapshot (taken at session start; it will not update):']

  const git = (...args: string[]): string | undefined => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim()
    } catch {
      return undefined
    }
  }

  // `symbolic-ref` names the branch even before the first commit, where
  // `rev-parse HEAD` fails; a detached HEAD falls back to the short hash.
  const inside = git('rev-parse', '--is-inside-work-tree') === 'true'
  const branch = inside
    ? (git('symbolic-ref', '--short', 'HEAD') ?? git('rev-parse', '--short', 'HEAD') ?? 'detached')
    : undefined
  if (branch !== undefined) {
    const status = git('status', '--porcelain') ?? ''
    const changed = status ? status.split('\n').length : 0
    const last = git('log', '-1', '--format=%h %s')
    lines.push(`- Git: branch \`${branch}\`, ${changed === 0 ? 'clean working tree' : `${changed} changed file${changed === 1 ? '' : 's'}`}${last ? `, last commit ${last}` : ', no commits yet'}`)
  } else {
    lines.push('- Git: not a git repository')
  }

  try {
    const entries = readdirSync(cwd, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') || ['.github', '.jean.json', '.env.example'].includes(e.name))
      .filter((e) => !['node_modules', 'target', 'dist', 'build', '__pycache__', 'venv', '.venv'].includes(e.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    const shown = entries.slice(0, 40).map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    if (shown.length > 0) {
      lines.push(`- Top level: ${shown.join(', ')}${entries.length > shown.length ? `, … (${entries.length - shown.length} more)` : ''}`)
    }
  } catch {
    // An unreadable directory is not worth failing startup over.
  }

  return lines.join('\n')
}

export interface InstructionFile {
  name: string
  path: string
  content: string
}

/** Instruction file names looked for in each directory from the root down. */
const STANDARD_NAMES = ['AGENTS.md', 'CLAUDE.md', 'JEAN.md', 'CLAUDE.local.md', 'JEAN.local.md']

/** Per-file cap: past this an instruction file has become documentation. */
const MAX_FILE_BYTES = 32_768
/** Total cap across every instruction file, imports included. */
const MAX_TOTAL_BYTES = 96_000

/**
 * Loads the project's instruction files.
 *
 * In order of increasing precedence: the user's own files (`~/.jean/JEAN.md`,
 * `~/.claude/CLAUDE.md`), then every ancestor directory from the filesystem
 * root down to the working directory, then anything the config names
 * explicitly (other agents' rule files found on import). A monorepo's root
 * `AGENTS.md` and a package's own `AGENTS.md` both apply, the closer one last.
 *
 * `@path` on a line of its own imports another file, relative to the one that
 * names it — the convention Claude Code established, which lets a short root
 * file pull in longer per-topic guides.
 */
export function loadInstructionFiles(cwd: string, config: JeanConfig): InstructionFile[] {
  const out: InstructionFile[] = []
  const seen = new Set<string>()
  let total = 0

  const add = (path: string, label?: string) => {
    const key = normalizeKey(path)
    if (seen.has(key) || !isFile(path)) return
    seen.add(key)
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      return // an unreadable instruction file is not worth failing startup over
    }
    const expanded = expandImports(raw, dirname(path), seen, 0)
    if (!expanded.trim()) return
    const clipped = expanded.length > MAX_FILE_BYTES ? `${expanded.slice(0, MAX_FILE_BYTES)}\n[truncated]` : expanded
    if (total + clipped.length > MAX_TOTAL_BYTES) return
    total += clipped.length
    out.push({ name: label ?? basename(path), path, content: clipped })
  }

  const home = homedir()
  add(join(home, '.jean', 'JEAN.md'), '~/.jean/JEAN.md (your global instructions)')
  add(join(home, '.claude', 'CLAUDE.md'), '~/.claude/CLAUDE.md (your global instructions)')

  const names = new Set([...STANDARD_NAMES, ...config.instructionFiles.filter((f) => !/[\\/]/.test(f))])
  for (const dir of ancestors(cwd)) {
    for (const name of names) {
      const path = join(dir, name)
      add(path, dir === resolve(cwd) ? name : relativeLabel(cwd, path))
    }
    // `.claude/CLAUDE.md` is the documented alternative location.
    add(join(dir, '.claude', 'CLAUDE.md'), dir === resolve(cwd) ? '.claude/CLAUDE.md' : undefined)
  }

  for (const entry of config.instructionFiles) {
    if (!/[\\/]/.test(entry)) continue
    add(isAbsolute(entry) ? entry : join(cwd, entry))
  }

  return out
}

/** Directories from the filesystem root (or home) down to `cwd`, inclusive. */
function ancestors(cwd: string): string[] {
  const chain: string[] = []
  let dir = resolve(cwd)
  const home = resolve(homedir())
  for (;;) {
    chain.unshift(dir)
    // Stop at the home directory: its own instruction files are loaded as the
    // user's, and anything above it belongs to nobody in particular.
    if (dir === home) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return chain
}

/** Replaces `@path` lines with the named file's content, up to five levels deep. */
function expandImports(text: string, base: string, seen: Set<string>, depth: number): string {
  if (depth >= 5) return text
  let inFence = false
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
      if (inFence) return line
      const match = /^\s*@((?:~\/|\.{0,2}\/)?[^\s@`]+\.[A-Za-z0-9]+)\s*$/.exec(line)
      if (!match) return line
      const target = match[1]!.startsWith('~/') ? join(homedir(), match[1]!.slice(2)) : resolve(base, match[1]!)
      const key = normalizeKey(target)
      if (seen.has(key) || !isFile(target)) return line
      seen.add(key)
      try {
        const content = readFileSync(target, 'utf8')
        return `<!-- imported from ${match[1]} -->\n${expandImports(content, dirname(target), seen, depth + 1)}`
      } catch {
        return line
      }
    })
    .join('\n')
}

function relativeLabel(cwd: string, path: string): string {
  const rel = path.startsWith(resolve(cwd)) ? path.slice(resolve(cwd).length + 1) : path
  return rel.replace(/\\/g, '/')
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function normalizeKey(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

/**
 * Prompt for a sub-agent: the identity and tool guidance, but none of the
 * conversation's history or the parent's mode rules.
 */
export function buildSubagentPrompt(brief: string, parts: PromptParts): string {
  return [
    IDENTITY,
    environmentSection(parts),
    `# Your task\n\n${brief}\n\nYou are one part of a larger job, running unattended: nobody can answer questions, so make reasonable assumptions and finish. Report back with what you found or did — specific, with file paths and line numbers — and nothing else. Do not expand beyond this task.`,
  ].join('\n\n')
}
