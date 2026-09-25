import { spawn, type ChildProcess } from 'node:child_process'
import { coreutilsShimDir, Native, nativeReady } from '@jean/native'
import { nativeCommandLines, nativeKillTree } from './accelerate.ts'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import type { Tool, ToolContext, ToolResult } from './types.ts'
import { ToolError } from './types.ts'

/**
 * Shell execution (architecture §8.2).
 *
 * The TypeScript path to `crates/pi-shell`. Two properties matter to the agent
 * and are implemented here:
 *
 * * **Sessions survive.** `cd` and `export` in one call are visible in the
 *   next, because the working directory and exported environment are kept in
 *   session state and replayed.
 * * **Destructive commands stop.** The deny list is refused outright and the
 *   confirm list is gated, before anything runs, in every permission mode.
 */

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_CHARS = 30_000

/**
 * Puts Jean's coreutils at the end of the session shell's PATH, so a command
 * the system shell lacks — `jq` and `bc` in Git Bash, `jq` on macOS — runs
 * the Rust implementation instead of failing. Last on PATH: a real one
 * always wins. See `coreutilsShimDir`.
 */
function withCoreutils(context: ToolContext): void {
  const dir = coreutilsShimDir()
  if (!dir) return
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  const current = context.session.shellEnv[key] ?? process.env[key] ?? ''
  if (current.split(delimiter).includes(dir)) return
  context.session.shellEnv[key] = current ? `${current}${delimiter}${dir}` : dir
}

export function defaultShell(): { path: string; args: string[] } {
  if (platform() === 'win32') {
    // Git Bash ships with Git for Windows and is what most Windows dev
    // workflows already assume. When none is found, spawning fails and the
    // embedded shell takes over (see `missingShells`).
    windowsBash ??= findWindowsBash(process.env, existsSync)
    return { path: windowsBash, args: ['-c'] }
  }
  return { path: process.env.SHELL ?? '/bin/bash', args: ['-c'] }
}

let windowsBash: string | undefined

/**
 * Git Bash on Windows, wherever Git for Windows put it.
 *
 * `bash` alone is not enough: Git's installer puts only its `cmd` folder on
 * PATH by default, so `bash` is not found and every command failed with
 * ENOENT — `cd` never stuck, because nothing ran. And a `bash.exe` in
 * System32 is WSL's, which runs a Linux filesystem and cannot use this
 * process's paths, so it is skipped.
 */
export function findWindowsBash(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string {
  if (env.SHELL) return env.SHELL

  const pathDirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)
  const candidates: string[] = []

  // Beside the `git` on PATH: `<Git>\cmd\git.exe` → `<Git>\bin\bash.exe`.
  for (const dir of pathDirs) {
    if (!exists(win32.join(dir, 'git.exe'))) continue
    let root = dir
    for (const sub of ['cmd', 'bin', win32.join('mingw64', 'bin')]) {
      if (dir.toLowerCase().endsWith(`\\${sub.toLowerCase()}`)) root = dir.slice(0, -sub.length - 1)
    }
    candidates.push(win32.join(root, 'bin', 'bash.exe'))
  }

  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]) {
    if (base) candidates.push(win32.join(base, 'Git', 'bin', 'bash.exe'))
  }
  if (env.LOCALAPPDATA) candidates.push(win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'))

  for (const dir of pathDirs) {
    if (/\\system32$/i.test(dir.replace(/\\+$/, ''))) continue
    candidates.push(win32.join(dir, 'bash.exe'))
  }

  return candidates.find((candidate) => exists(candidate)) ?? 'bash'
}

/**
 * Converts a shell-reported path into one this process can use as a cwd.
 *
 * Git Bash and MSYS report `$PWD` in POSIX form — `/c/Users/...` or
 * `/cygdrive/c/Users/...` — which Windows `spawn` cannot resolve. Without this,
 * a single `cd` would poison every later shell call in the session.
 */
export function toNativePath(reported: string): string | undefined {
  const path = reported.trim()
  if (!path) return undefined
  if (platform() !== 'win32') return path

  const cygwin = /^\/cygdrive\/([a-zA-Z])(\/.*)?$/.exec(path)
  if (cygwin) return `${cygwin[1]!.toUpperCase()}:${(cygwin[2] ?? '/').replace(/\//g, '\\')}`

  const msys = /^\/([a-zA-Z])(\/.*)?$/.exec(path)
  if (msys) return `${msys[1]!.toUpperCase()}:${(msys[2] ?? '/').replace(/\//g, '\\')}`

  return path
}

/**
 * Checks a command against the config's deny and confirm lists.
 *
 * Matching is on the normalized command text. This is a safety net, not a
 * sandbox: the real isolation boundary is `@jean/execution`'s Docker backend.
 * It exists because the overwhelmingly common failure is an agent running one
 * catastrophic line it did not think through, not an adversary evading a check.
 */
export function classifyCommand(
  command: string,
  context: ToolContext,
  parsed?: string[],
): { verdict: 'allow' } | { verdict: 'deny' | 'confirm'; pattern: string } {
  const normalized = command.replace(/\s+/g, ' ').trim()
  // The raw text, plus each command as the `pi-shell` parser sees it when the
  // bridge is up: `'r''m' -rf /` is `rm -rf /` once the shell strips the
  // quotes, and `echo $(rm -rf /)` runs `rm -rf /` — neither is visible to a
  // match on the text alone.
  const candidates = [normalized, ...(parsed ?? []).map((line) => line.replace(/\s+/g, ' ').trim())]

  for (const pattern of context.config.denyPatterns) {
    if (candidates.some((candidate) => candidate.includes(pattern))) return { verdict: 'deny', pattern }
  }
  for (const pattern of context.config.confirmPatterns) {
    const wanted = pattern.toLowerCase()
    if (candidates.some((candidate) => candidate.toLowerCase().includes(wanted))) {
      return { verdict: 'confirm', pattern }
    }
  }

  for (const candidate of candidates) {
    const secretRead = readsCredentials(candidate)
    if (secretRead) return { verdict: 'confirm', pattern: secretRead }
  }

  return { verdict: 'allow' }
}

export const bashTool: Tool<{
  command: string
  cwd?: string
  timeout?: number
  background?: boolean
}> = {
  name: 'bash',
  risk: 'execute',
  description: [
    'Run a shell command in the project.',
    '',
    'The session persists: `cd` and `export` carry over to later calls. Output is',
    'combined stdout and stderr, truncated if very long.',
    '',
    'Use `background: true` for long-running processes (servers, watchers); the call',
    'returns immediately with a job id and `bash_output` collects what it printed.',
    '',
    'Prefer `read`, `glob`, and `grep` over `cat`, `find`, and `grep(1)` — they are',
    'faster, respect .gitignore, and return anchors you can edit against.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      cwd: { type: 'string', description: 'Working directory for this call only.' },
      timeout: { type: 'integer', description: 'Milliseconds before the command is killed.' },
      background: { type: 'boolean', description: 'Run detached and return a job id.' },
    },
    required: ['command'],
  },
  summarize: (args) => args.command.split('\n')[0]!.slice(0, 120),

  async execute(args, context): Promise<ToolResult> {
    const command = args.command.trim()
    if (!command) throw new ToolError('The command is empty.')

    const classified = classifyCommand(command, context, await nativeCommandLines(command))
    if (classified.verdict === 'deny') {
      throw new ToolError(
        `Refused: this command matches the deny list (\`${classified.pattern}\`).`,
        'This pattern is never run by Jean Code. If it is genuinely needed, the user should run it themselves.',
      )
    }

    // Destructive commands are confirmed even in `auto` mode, which is the
    // whole point of `auto`: act freely, stop at the irreversible.
    if (classified.verdict === 'confirm' && context.config.permissionMode !== 'full') {
      if (!context.confirm) {
        throw new ToolError(
          `\`${classified.pattern}\` needs confirmation and this session is non-interactive.`,
          'Re-run interactively, or with --permission-mode full if you are certain.',
        )
      }
      const approved = await context.confirm({
        tool: 'bash',
        risk: 'execute',
        summary: `Run a destructive command (matches \`${classified.pattern}\`)`,
        detail: command,
      })
      if (!approved) {
        throw new ToolError('The user declined this command. Do not retry it.')
      }
    }

    const cwd = args.cwd
      ? isAbsolute(args.cwd)
        ? args.cwd
        : resolve(context.session.shellCwd, args.cwd)
      : context.session.shellCwd

    const shell = { path: context.config.shell.path ?? defaultShell().path, args: defaultShell().args }
    const timeout = args.timeout ?? context.config.shell.timeoutMs ?? DEFAULT_TIMEOUT_MS
    withCoreutils(context)

    if (args.background) {
      return startBackground(command, cwd, shell, context)
    }

    // The embedded `pi-shell` runs the command when the config asks for it,
    // or when no system shell could be started — a Windows machine without
    // Git Bash still gets pipes, `cd`, `export`, and 58 coreutils.
    if (context.config.shell.backend === 'native' || missingShells.has(shell.path)) {
      const embedded = await runEmbedded(command, cwd, context, timeout)
      if (embedded) return embedded
    }

    // The working directory is echoed after the command so the next call can
    // resume where this one left off.
    //
    // `pwd -W` is the important part on Windows: Git Bash reports `$PWD` as an
    // MSYS path (`/tmp/x`, `/c/Users/x`) that this process cannot use as a cwd,
    // and `/tmp` is a mount point no string transformation can undo. `-W` asks
    // for the native path instead, and falls back to plain `pwd` everywhere
    // else, where the two are the same thing.
    const wrapped = [
      command,
      '__jean_status=$?',
      `printf '\\n__JEAN_CWD__%s\\n' "$(pwd -W 2>/dev/null || pwd)"`,
      'exit $__jean_status',
    ].join('\n')

    const result = await run(shell, wrapped, cwd, context, timeout)

    if (result.spawnFailed) {
      missingShells.add(shell.path)
      const embedded = await runEmbedded(command, cwd, context, timeout)
      if (embedded) return embedded
    }

    const cwdMatch = /\n__JEAN_CWD__(.*)\n?$/.exec(result.output)
    if (cwdMatch?.[1]) {
      const reported = toNativePath(cwdMatch[1].trim())
      // Only adopt a directory that actually exists: a shell can report a path
      // this process cannot use (an MSYS mount, a container path), and an
      // unusable cwd would break every later call rather than just this one.
      if (reported && existsSync(reported)) context.session.shellCwd = reported
    }
    const output = result.output.replace(/\n__JEAN_CWD__.*\n?$/, '')
    const shown = clipOutput(output)

    if (result.timedOut) {
      return {
        output: `Command timed out after ${timeout}ms and was killed.\n${shown}`,
        isError: true,
        display: { kind: 'bash', command, exitCode: null, timedOut: true },
      }
    }

    const status = result.code === 0 ? '' : `\n[exit code ${result.code}]`
    return {
      output: shown.trim() ? `${shown}${status}` : `(no output)${status}`,
      isError: result.code !== 0,
      display: { kind: 'bash', command, exitCode: result.code, cwd: context.session.shellCwd },
    }
  },
}

interface RunResult {
  output: string
  code: number | null
  timedOut: boolean
  /** The shell binary itself could not be started. */
  spawnFailed?: boolean
}

/**
 * Shells that failed to start in this process. A command for one of them goes
 * straight to the embedded shell rather than failing first. Keyed by path, so
 * one missing shell does not reroute a session configured with another.
 */
const missingShells = new Set<string>()

/**
 * Kills a child and everything it started.
 *
 * `child.kill()` alone ends the shell and orphans what it launched: the dev
 * server, the watcher, the test runner, which then hold their ports. The
 * `pi-sys` tree kill reaches them; the plain kill stays as the fallback and
 * as a no-op once the tree is already gone.
 */
async function killProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined && child.exitCode === null) await nativeKillTree(child.pid)
  child.kill('SIGKILL')
}

/** The bridge the embedded shell runs on — its own, since a command can block. */
let embeddedBridge: Native | undefined

/**
 * Runs a command in the embedded `pi-shell`, one session per agent session.
 *
 * `undefined` when the bridge is not built, so the caller reports the system
 * shell's own failure instead. A loop or a function definition is refused by
 * `pi-shell` rather than half-run, and that refusal is what the agent sees.
 */
async function runEmbedded(
  command: string,
  cwd: string,
  context: ToolContext,
  timeoutMs: number,
): Promise<ToolResult | undefined> {
  if (!(await nativeReady())) return undefined
  embeddedBridge ??= Native.open({ timeoutMs })

  try {
    if (!context.session.nativeShell) {
      context.session.nativeShell = await embeddedBridge.shellOpen(cwd)
    }
    const ran = await embeddedBridge.shellRun(context.session.nativeShell, command, { timeoutMs })
    if (existsSync(ran.cwd)) context.session.shellCwd = ran.cwd

    const combined = [ran.stdout, ran.stderr].filter((part) => part !== '').join('\n')
    const refused = ran.refused.length > 0 ? `\n[refused: ${ran.refused.join('; ')}]` : ''
    const shown = clipOutput(combined)
    const status = ran.code === 0 ? '' : `\n[exit code ${ran.code}]`
    return {
      output: `${shown.trim() ? shown : '(no output)'}${refused}${status}`,
      isError: ran.code !== 0,
      display: { kind: 'bash', command, exitCode: ran.code, cwd: context.session.shellCwd },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/timed out/.test(message)) {
      // The command is still running inside the bridge: take the bridge and
      // everything it spawned down, and start a fresh session next time.
      const pid = embeddedBridge.pid
      if (pid !== undefined) await nativeKillTree(pid)
      embeddedBridge.close()
      embeddedBridge = undefined
      context.session.nativeShell = undefined
      return {
        output: `Command timed out after ${timeoutMs}ms and was killed.`,
        isError: true,
        display: { kind: 'bash', command, exitCode: null, timedOut: true },
      }
    }
    return { output: message, isError: true, display: { kind: 'bash', command, exitCode: 2 } }
  }
}

function run(
  shell: { path: string; args: string[] },
  command: string,
  cwd: string,
  context: ToolContext,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(shell.path, [...shell.args, command], {
      cwd,
      env: { ...process.env, ...context.session.shellEnv },
      shell: false,
    })

    const output = new OutputBuffer()
    let settled = false
    const finish = (result: RunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      context.signal?.removeEventListener('abort', onAbort)
      resolvePromise(result)
    }

    // Set once the command is being stopped. The kill makes the child exit, and
    // its `close` must not report that as an ordinary finish; the stop path
    // reports, after the whole tree is gone — returning earlier would hand the
    // agent the turn while the processes it was told were killed still run.
    let stopping = false
    const stop = (timedOut: boolean) => {
      if (stopping) return
      stopping = true
      const gone = killProcessTree(child).catch(() => undefined)
      const ceiling = new Promise((resolveCeiling) => setTimeout(resolveCeiling, 3_000))
      void Promise.race([gone, ceiling]).then(() => finish({ output: output.text(), code: null, timedOut }))
    }

    const timer = setTimeout(() => stop(true), timeoutMs)

    const onAbort = () => stop(false)
    context.signal?.addEventListener('abort', onAbort, { once: true })

    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      output.push(text)
      context.onProgress?.(text)
    }

    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (err) => {
      finish({
        output: `${output.text()}\nfailed to start shell: ${err.message}`,
        code: 127,
        timedOut: false,
        spawnFailed: (err as NodeJS.ErrnoException).code === 'ENOENT',
      })
    })
    child.on('close', (code) => {
      if (!stopping) finish({ output: output.text(), code, timedOut: false })
    })
  })
}

/**
 * Collects a command's output with a memory ceiling.
 *
 * Everything is kept up to the cap, which is far past anything worth showing,
 * so the spill file holds the real output. Past the cap — a runaway process —
 * the head and the tail are kept and the middle dropped: the head says what
 * ran, the tail says how it ended, and the tail also carries the working
 * directory marker the session depends on.
 */
export class OutputBuffer {
  private body = ''
  private head = ''
  private tail = ''
  private overflowed = false
  total = 0

  constructor(
    private readonly cap = 16 * 1024 * 1024,
    private readonly keep = 1024 * 1024,
  ) {}

  push(text: string): void {
    this.total += text.length
    if (!this.overflowed) {
      this.body += text
      if (this.body.length > this.cap) {
        this.overflowed = true
        this.head = this.body.slice(0, this.keep)
        this.tail = this.body.slice(-this.keep)
        this.body = ''
      }
      return
    }
    this.tail = (this.tail + text).slice(-this.keep)
  }

  text(): string {
    if (!this.overflowed) return this.body
    const dropped = this.total - this.head.length - this.tail.length
    return `${this.head}\n[… ${dropped} characters dropped while the command ran …]\n${this.tail}`
  }
}

/** Characters of the head and tail shown when output is clipped. */
const CLIP_HEAD = 8_000
const CLIP_TAIL = 20_000

/** Where oversized command output is saved for the agent to search. */
export function outputSpillDir(): string {
  return join(tmpdir(), 'jean-output')
}

/** True when `absolute` is a saved output file, which `read` may open. */
export function isSpilledOutput(absolute: string): boolean {
  const rel = relative(outputSpillDir(), absolute)
  return rel !== '' && !rel.startsWith('..') && !rel.includes(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Fits command output into the context budget.
 *
 * Keeps the start *and* the end. Build and test output puts the command
 * banner first and the verdict — the failing assertion, the error summary, the
 * exit status — last, so keeping only the head shows the agent everything
 * except what it needed. The full text is saved to a file whose path is in
 * the message, so nothing is lost: the agent can `grep` it for the one line
 * that matters instead of re-running a slow command to see it again.
 */
export function clipOutput(output: string, spill = true): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output

  const head = cutAtLine(output.slice(0, CLIP_HEAD), 'end')
  const tail = cutAtLine(output.slice(-CLIP_TAIL), 'start')
  const omitted = output.length - head.length - tail.length
  const lines = output.split('\n').length

  let where = ''
  if (spill) {
    try {
      const dir = outputSpillDir()
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`)
      writeFileSync(path, output, 'utf8')
      where = ` Full output (${lines} lines) saved to ${path} — page through it with \`read\` (offset/limit) or search it with \`grep -n\` in \`bash\`, rather than re-running the command.`
    } catch {
      // Nowhere to spill: the clipped view is still the right thing to show.
    }
  }

  return `${head}\n\n[… ${omitted} characters omitted.${where}]\n\n${tail}`
}

/** Trims a partial line so a clip boundary does not split one. */
function cutAtLine(text: string, side: 'start' | 'end'): string {
  if (side === 'end') {
    const last = text.lastIndexOf('\n')
    return last > text.length * 0.5 ? text.slice(0, last) : text
  }
  const first = text.indexOf('\n')
  return first !== -1 && first < text.length * 0.5 ? text.slice(first + 1) : text
}

function startBackground(
  command: string,
  cwd: string,
  shell: { path: string; args: string[] },
  context: ToolContext,
): ToolResult {
  const id = `job_${context.session.jobs.size + 1}`
  const child = spawn(shell.path, [...shell.args, command], {
    cwd,
    env: { ...process.env, ...context.session.shellEnv },
    detached: false,
    // stdin is a pipe rather than inherited, so `bash_input` can answer a
    // prompt. Inheriting would connect the child to the agent's own stdin,
    // where it would silently steal the user's keystrokes.
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const job = {
    id,
    command,
    startedAt: Date.now(),
    output: [] as string[],
    done: false,
    exitCode: undefined as number | undefined,
    readOffset: 0,
    kill: () => void killProcessTree(child),
    write: (input: string): boolean => {
      const stdin = child.stdin
      if (!stdin || stdin.destroyed || !stdin.writable) return false
      try {
        stdin.write(input)
        return true
      } catch {
        return false
      }
    },
  }

  // A process that closes its own stdin is normal, and an unhandled EPIPE on
  // that stream would take the whole agent down.
  child.stdin?.on('error', () => undefined)

  const collect = (chunk: Buffer) => {
    job.output.push(chunk.toString('utf8'))
    // Keep the tail: a watcher can print for hours.
    if (job.output.length > 500) job.output.splice(0, job.output.length - 500)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  child.on('close', (code) => {
    job.done = true
    job.exitCode = code ?? undefined
  })

  context.session.jobs.set(id, job)
  return {
    output: `Started \`${command}\` in the background as ${id}. Use \`bash_output\` with job: "${id}" to read its output.`,
    display: { kind: 'bash-background', id, command },
  }
}

export const bashOutputTool: Tool<{ job: string; kill?: boolean }> = {
  name: 'bash_output',
  risk: 'read',
  description:
    'Read output from a background job started by `bash`, and optionally kill it. Output already read is not repeated.',
  parameters: {
    type: 'object',
    properties: {
      job: { type: 'string', description: 'Job id returned by `bash`.' },
      kill: { type: 'boolean', description: 'Kill the job after reading.' },
    },
    required: ['job'],
  },
  summarize: (args) => `read output of ${args.job}`,

  async execute(args, context): Promise<ToolResult> {
    const job = context.session.jobs.get(args.job)
    if (!job) {
      const known = [...context.session.jobs.keys()]
      throw new ToolError(
        `No background job "${args.job}".`,
        known.length > 0 ? `Running jobs: ${known.join(', ')}.` : 'No jobs have been started.',
      )
    }

    // Draining is what makes repeated polling useful rather than repetitive.
    const output = job.output.join('')
    job.output.length = 0

    if (args.kill && !job.done) {
      job.kill()
      job.done = true
    }

    const status = job.done
      ? `[job ${job.id} finished${job.exitCode !== undefined ? ` with exit code ${job.exitCode}` : ''}]`
      : `[job ${job.id} still running]`

    return {
      output: output.trim() ? `${output}\n${status}` : `(no new output)\n${status}`,
      display: { kind: 'bash-output', id: job.id, done: job.done },
    }
  },
}


/**
 * Detects a shell command that would print a credentials file.
 *
 * The `read` and `grep` tools refuse these files outright, but the shell can
 * reach them anyway — so the common accident (`cat .env` while orienting in an
 * unfamiliar project) is worth catching too.
 *
 * This is a guard against carelessness, not a security boundary: anything with
 * a shell can obfuscate its way past a text match, and the real isolation is
 * `@jean/execution`'s Docker backend. It stops the mistake that actually
 * happens, and asks rather than refuses, so a deliberate `cat .env` is still
 * one confirmation away.
 */
export function readsCredentials(command: string): string | undefined {
  const READERS =
    /\b(cat|bat|head|tail|less|more|nl|od|xxd|strings|type|grep|rg|ack|ag|sed|awk|cut|sort|uniq|tee|cp|mv|scp|curl|base64)\b/i
  if (!READERS.test(command)) return undefined

  const SECRETS =
    /(^|[\s"'=/\\])(\.env(\.[\w-]+)?|\.netrc|\.npmrc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)|[\w-]+\.(pem|key|p12|pfx))\b/i
  const hit = SECRETS.exec(command)
  if (!hit) return undefined

  // A template holds variable names, not values.
  const name = hit[2]!
  if (/^\.env\.(example|sample|template)$/i.test(name)) return undefined
  return name
}

/**
 * Sends input to a running background job.
 *
 * The gap this fills: a command stops to ask something — a migration confirming
 * a destructive change, `npm login`, a language REPL — and the agent can see the
 * prompt in the output but has no way to answer it. Without this the only
 * remaining move is to kill the job and try to avoid the prompt, which for an
 * interactive tool usually means not using it at all.
 */
export const bashInputTool: Tool<{ job: string; input: string; enter?: boolean }> = {
  name: 'bash_input',
  risk: 'execute',
  description: [
    'Send input to a background job that is waiting for it.',
    '',
    'Use this when `bash_output` shows a prompt — a confirmation, a password',
    'field, a REPL waiting for the next expression. A newline is appended unless',
    'you set `enter: false`.',
    '',
    'Never send a password or an API key: ask the user to run that command',
    'themselves. Anything sent here is recorded in the transcript.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      job: { type: 'string', description: 'The job id from `bash` with background: true.' },
      input: { type: 'string', description: 'What to send.' },
      enter: { type: 'boolean', description: 'Append a newline. Default true.' },
    },
    required: ['job', 'input'],
  },
  summarize: (args) => `input to ${args.job}: ${args.input.slice(0, 40)}`,

  async execute(args, context): Promise<ToolResult> {
    const job = context.session.jobs.get(args.job)
    if (!job) {
      const known = [...context.session.jobs.keys()]
      throw new ToolError(
        `No job "${args.job}".`,
        known.length > 0 ? `Running jobs: ${known.join(', ')}.` : 'No jobs have been started.',
      )
    }

    if (job.done) {
      throw new ToolError(
        `${args.job} has already exited${job.exitCode !== undefined ? ` with code ${job.exitCode}` : ''}.`,
        'Start it again if you need to interact with it.',
      )
    }

    // A credential typed into a subprocess ends up in the transcript, and from
    // there in the session file and every later request to the model.
    if (looksLikeCredential(args.input)) {
      throw new ToolError(
        'That looks like a credential, and anything sent here is recorded in the transcript.',
        'Ask the user to run this command themselves and enter the value directly.',
      )
    }

    const payload = args.enter === false ? args.input : `${args.input}\n`
    if (!job.write(payload)) {
      throw new ToolError(`${args.job} is no longer accepting input.`)
    }

    // A beat for the process to react, so the output below reflects the input
    // rather than the state before it.
    await new Promise((resolve) => setTimeout(resolve, 300))

    const since = job.output.join('').slice(job.readOffset)
    job.readOffset += since.length

    return {
      output: since.trim()
        ? `Sent. Output since:\n${since.trimEnd().slice(-4000)}`
        : 'Sent. The job has not printed anything since.',
      display: { kind: 'bash-input', job: args.job },
    }
  },
}

/** Whether input looks like a secret rather than an answer to a prompt. */
function looksLikeCredential(input: string): boolean {
  const trimmed = input.trim()
  // Short answers are what prompts actually want: y, yes, a name, a number.
  if (trimmed.length < 16) return false
  return (
    /\bsk-[A-Za-z0-9_-]{16,}/.test(trimmed) ||
    /\bgh[pousr]_[A-Za-z0-9]{20,}/.test(trimmed) ||
    /\bAKIA[0-9A-Z]{16}\b/.test(trimmed) ||
    /-----BEGIN[A-Z ]*PRIVATE KEY-----/.test(trimmed) ||
    // A long unbroken high-variety string is a token far more often than an
    // answer to a question.
    (/^[A-Za-z0-9+/=_-]{32,}$/.test(trimmed) && /[A-Z]/.test(trimmed) && /[0-9]/.test(trimmed))
  )
}

export const shellTools: Tool[] = [bashTool, bashOutputTool, bashInputTool]
