/**
 * `@jean/native` — reaches the Rust core from TypeScript (architecture §8).
 *
 * `crates/` holds the parts of Jean Code where Rust earns its place: a parallel
 * ignore-aware walker and content search, 58 coreutils, structural search,
 * hashline patching, an embedded shell and its parser, copy-on-write isolation,
 * reversible compaction, process-tree control, token counting, audio, and the
 * memory log. This is how the rest of the codebase calls them.
 *
 * ## How
 *
 * `crates/pi-natives` builds a binary that reads one JSON request per line and
 * writes one response per line. This spawns it once and keeps it alive, so the
 * process cost is paid per session rather than per call — the same shape as
 * `@jean/lsp`, `@jean/mcp`, and `@jean/dap`, which all speak to a long-running
 * child over a pipe. Synchronous callers (the memory backend, whose interface
 * is synchronous) use {@link callSync}, a one-shot run of the same binary.
 *
 * N-API would be the conventional choice and is the wrong one here: it needs a
 * build toolchain, a prebuilt binary per platform and Node ABI, and it brings a
 * dependency tree into a workspace whose premise is not having one. A crash in
 * an addon also takes the host process down, which a crash in a child does not.
 *
 * ## Finding the binary
 *
 * The binary ships with Jean Code, not with the project Jean is working on, so
 * it is looked up next to this package — never in the working directory by
 * default. Executing whatever `target/release/pi-natives` an untrusted
 * repository contains would be arbitrary code execution on `cd`.
 *
 * ## Proof of use
 *
 * Every call is counted per method ({@link nativeStats}). `jean native` and
 * `jean doctor` print the counts, and the tests assert on them: a feature that
 * claims to run in Rust has to show the call.
 *
 * ## Optional, always
 *
 * The binary may not be built. Every caller resolves {@link nativeReady} first
 * and falls back to its TypeScript path — the Rust side is the primary path,
 * never a requirement. `JEAN_NATIVE=0` forces the fallback, which is how the
 * parity tests run both sides.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface NativeOptions {
  /** Overrides binary discovery. */
  binaryPath?: string
  /**
   * Looks for a build under this directory only, instead of the default
   * locations. For tests and for running a checkout's own build.
   */
  cwd?: string
  /** How long one call may take before it is abandoned. */
  timeoutMs?: number
}

interface Pending {
  method: string
  started: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** 30s: long enough to walk a large tree, short enough not to look hung. */
const DEFAULT_TIMEOUT_MS = 30_000

const BINARY_NAME = process.platform === 'win32' ? 'pi-natives.exe' : 'pi-natives'

/**
 * Every method the TypeScript side calls. `jean doctor` compares it with what
 * the binary advertises, so a stale build shows up as missing methods rather
 * than as a feature quietly falling back.
 */
export const NATIVE_METHODS = [
  'ping',
  'version',
  'hashline.annotate',
  'hashline.anchors',
  'hashline.patch',
  'walk.list',
  'walk.glob',
  'walk.search',
  'ast.search',
  'ast.search_tree',
  'ast.outline',
  'builtins.run',
  'builtins.list',
  'builtins.pipeline',
  'memory.remember',
  'memory.recall',
  'memory.list',
  'memory.get',
  'memory.forget',
  'memory.count',
  'memory.update',
  'shell.inspect',
  'shell.open',
  'shell.run',
  'shell.close',
  'iso.create',
  'iso.changes',
  'iso.merge',
  'iso.discard',
  'snap.frame',
  'snap.get',
  'snap.entities',
  'sys.processes',
  'sys.kill_tree',
  'sys.copy',
  'sys.paste',
  'sys.awake',
  'sys.release',
  'tokens.count',
  'voice.probe',
  'voice.prepare',
  // pi-lsp
  'lsp.configure',
  'lsp.diagnostics',
  'lsp.touch',
  'lsp.definition',
  'lsp.references',
  'lsp.hover',
  'lsp.highlights',
  'lsp.symbols',
  'lsp.workspace_symbols',
  'lsp.completion',
  'lsp.signature',
  'lsp.rename',
  'lsp.code_actions',
  'lsp.format',
  'lsp.calls',
  'lsp.types',
  'lsp.inlay_hints',
  'lsp.code_lens',
  'lsp.folding',
  'lsp.semantic_tokens',
  'lsp.rename_file',
  'lsp.execute_command',
  'lsp.servers',
  'lsp.status',
  'lsp.install',
  'lsp.stop',
  // pi-dap
  'dap.configure',
  'dap.adapters',
  'dap.install',
  'dap.start',
  'dap.breakpoints',
  'dap.function_breakpoints',
  'dap.exceptions',
  'dap.control',
  'dap.wait',
  'dap.inspect',
  'dap.evaluate',
  'dap.variables',
  'dap.set_variable',
  'dap.threads',
  'dap.stack',
  'dap.output',
  'dap.sessions',
  'dap.stop',
] as const

export type NativeMethod = (typeof NATIVE_METHODS)[number]

// ---- discovery --------------------------------------------------------------

/** The repository root this package lives in: `packages/native/src` → `../../..`. */
export function packageRoot(): string | undefined {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  } catch {
    return undefined
  }
}

/** Whether native calls are switched off for this process. */
export function nativeDisabled(): boolean {
  const value = process.env.JEAN_NATIVE?.trim().toLowerCase()
  return value === '0' || value === 'false' || value === 'off'
}

/**
 * The newest of a release and a debug build under `root`.
 *
 * Newest rather than release-first: a stale release build shadowing a fresh
 * debug one would hide every method added since, which reads as features
 * silently falling back.
 */
function builtUnder(root: string): string | undefined {
  const builds = [join(root, 'target', 'release', BINARY_NAME), join(root, 'target', 'debug', BINARY_NAME)]
    .filter((path) => existsSync(path))
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (builds[0]) return builds[0].path

  const packaged = join(root, 'bin', BINARY_NAME)
  return existsSync(packaged) ? packaged : undefined
}

/**
 * Where a built binary lives.
 *
 * With `cwd`, only under that directory. Without it: `JEAN_NATIVE_BIN`, then
 * the checkout this package belongs to, then next to the running executable
 * (a compiled single-file build), then `~/.jean/bin`.
 */
export function findBinary(cwd?: string): string | undefined {
  if (cwd !== undefined) return builtUnder(cwd)

  const explicit = process.env.JEAN_NATIVE_BIN
  if (explicit && existsSync(explicit)) return explicit

  const root = packageRoot()
  const fromPackage = root ? builtUnder(root) : undefined
  if (fromPackage) return fromPackage

  for (const path of [join(dirname(process.execPath), BINARY_NAME), join(homedir(), '.jean', 'bin', BINARY_NAME)]) {
    if (existsSync(path)) return path
  }
  return undefined
}

// ---- statistics -------------------------------------------------------------

export interface MethodStats {
  calls: number
  failures: number
  totalMs: number
}

const STATS = new Map<string, MethodStats>()

function record(method: string, started: number, ok: boolean): void {
  const entry = STATS.get(method) ?? { calls: 0, failures: 0, totalMs: 0 }
  entry.calls++
  if (!ok) entry.failures++
  entry.totalMs += performance.now() - started
  STATS.set(method, entry)
}

/** Calls made to the Rust side in this process, per method. */
export function nativeStats(): Record<string, MethodStats> {
  const out: Record<string, MethodStats> = {}
  for (const [method, entry] of [...STATS.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out[method] = { ...entry }
  }
  return out
}

/** How many successful calls one method has had. */
export function nativeCalls(method: string): number {
  const entry = STATS.get(method)
  return entry ? entry.calls - entry.failures : 0
}

export function resetNativeStats(): void {
  STATS.clear()
}

// ---- the bridge -------------------------------------------------------------

export class NativeBridge {
  private child?: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, Pending>()
  private buffer = ''
  private nextId = 0
  private failed = false

  constructor(private readonly options: NativeOptions = {}) {}

  /** The running child's pid, if one is up. */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /** Whether the binary exists and answered a ping. */
  async available(): Promise<boolean> {
    if (this.failed || nativeDisabled()) return false
    try {
      const reply = await this.call('ping', {})
      return reply === 'pong'
    } catch {
      return false
    }
  }

  /** The methods this build exposes, for `jean doctor`. */
  async methods(): Promise<string[]> {
    const version = (await this.call('version', {})) as { methods?: string[] }
    return version.methods ?? []
  }

  /**
   * Sends one request and waits for its reply.
   *
   * Requests are paired by id rather than by order. The bridge answers in
   * order today, but relying on that would make a future concurrent handler a
   * silent data mix-up rather than a compile error.
   */
  async call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const child = this.ensure()
    const id = String(this.nextId++)
    const limit = timeoutMs ?? this.timeout()
    const started = performance.now()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        record(method, started, false)
        reject(new Error(`${method} timed out after ${limit}ms`))
      }, limit)

      this.pending.set(id, { method, started, resolve, reject, timer })

      try {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        record(method, started, false)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Stops the child. Safe to call more than once. */
  close(): void {
    this.abandon('the native bridge closed')
    this.child?.kill()
    this.child = undefined
  }

  /**
   * Fails every outstanding request.
   *
   * Called from all three paths that end a child — exit, spawn failure, and
   * close. A pending request whose child is gone will never be answered, and
   * leaving it to time out turns an immediate, explainable failure into a
   * thirty-second stall.
   */
  private abandon(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      record(pending.method, pending.started, false)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
  }

  private timeout(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child

    if (nativeDisabled()) {
      this.failed = true
      throw new Error('native calls are disabled (JEAN_NATIVE=0)')
    }

    const binary = this.options.binaryPath ?? findBinary(this.options.cwd)
    if (binary === undefined) {
      this.failed = true
      throw new Error('the native bridge is not built — run `jean native build`')
    }

    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.receive(chunk))

    // Read and discarded rather than left unread: an unread pipe fills its
    // buffer and blocks the child mid-write, which looks like a hang.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => {})

    child.on('exit', () => {
      if (this.child === child) this.child = undefined
      this.abandon('the native bridge exited')
    })

    // A missing binary or a bad exec surfaces here, asynchronously — `spawn`
    // itself does not throw. Anything already sent has to be rejected here or
    // it waits out the full timeout.
    child.on('error', (error) => {
      this.failed = true
      if (this.child === child) this.child = undefined
      this.abandon(`the native bridge could not start: ${error.message}`)
    })

    // An idle bridge must not keep the process alive: a one-shot run would
    // otherwise hang at exit waiting on a child it no longer needs. A call in
    // flight still holds the loop open through its timeout timer.
    child.unref()
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      ;(stream as unknown as { unref?: () => void }).unref?.()
    }

    this.child = child
    return child
  }

  /** Splits the stream on newlines and settles each reply. */
  private receive(chunk: string): void {
    this.buffer += chunk

    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')

      if (line === '') continue

      let message: { id?: string; ok?: boolean; result?: unknown; error?: string }
      try {
        message = JSON.parse(line) as typeof message
      } catch {
        // A line that is not JSON is the child having written something it
        // should not have. Dropping it is better than rejecting a request that
        // may still get a real answer.
        continue
      }

      const pending = this.pending.get(message.id ?? '')
      if (!pending) continue

      this.pending.delete(message.id ?? '')
      clearTimeout(pending.timer)
      record(pending.method, pending.started, message.ok === true)

      if (message.ok === true) pending.resolve(message.result)
      else pending.reject(new Error(message.error ?? 'the native call failed'))
    }
  }
}

const LIBRARY_NAME =
  process.platform === 'win32'
    ? 'jean_native.dll'
    : process.platform === 'darwin'
      ? 'libjean_native.dylib'
      : 'libjean_native.so'

/**
 * Where the in-process library (`crates/pi-ffi`) lives: `JEAN_NATIVE_LIB`,
 * then this checkout's `ffi`, release, and debug builds, then beside the
 * executable, then `~/.jean/bin`.
 */
export function findLibrary(): string | undefined {
  const explicit = process.env.JEAN_NATIVE_LIB
  if (explicit && existsSync(explicit)) return explicit
  const root = packageRoot()
  const candidates = [
    ...(root ? ['ffi', 'release', 'debug'].map((profile) => join(root, 'target', profile, LIBRARY_NAME)) : []),
    join(dirname(process.execPath), LIBRARY_NAME),
    join(homedir(), '.jean', 'bin', LIBRARY_NAME),
  ]
  return candidates.find((path) => existsSync(path))
}

interface InProcess {
  call(line: string): string
}

/** Loaded once; `null` once loading has failed, so it is not retried per call. */
let inProcess: InProcess | null | undefined

/**
 * The library, opened through `bun:ffi`. `null` outside Bun, when the library
 * is not built, or when it fails to load — `callSync` then runs the binary.
 */
function openInProcess(): InProcess | null {
  if (inProcess !== undefined) return inProcess
  inProcess = null
  const library = findLibrary()
  if (!library || typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') return inProcess

  try {
    const ffi = require('bun:ffi') as typeof import('bun:ffi')
    const { symbols } = ffi.dlopen(library, {
      jean_native_call: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.ptr },
      jean_native_free: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.void },
    })
    inProcess = {
      call(line: string): string {
        const request = Buffer.from(`${line}\0`, 'utf8')
        const response = symbols.jean_native_call(ffi.ptr(request))
        if (!response) throw new Error('the native library returned nothing')
        try {
          return new ffi.CString(response).toString()
        } finally {
          symbols.jean_native_free(response)
        }
      },
    }
  } catch {
    inProcess = null
  }
  return inProcess
}

/** Whether synchronous calls run in-process (true) or start the binary (false). */
export function inProcessAvailable(): boolean {
  return !nativeDisabled() && openInProcess() !== null
}

/**
 * One call, synchronously.
 *
 * For callers whose interface is synchronous — the memory backend is the one
 * that matters. In-process through `crates/pi-ffi` when it is built (tens of
 * microseconds); otherwise the binary runs for this one request, which costs
 * a process start — fine once per prompt, wrong in a loop.
 */
export function callSync(
  method: string,
  params: Record<string, unknown>,
  options: { binaryPath?: string; timeoutMs?: number } = {},
): unknown {
  if (nativeDisabled()) throw new Error('native calls are disabled (JEAN_NATIVE=0)')

  const library = options.binaryPath === undefined ? openInProcess() : null
  if (library) {
    const started = performance.now()
    let message: { ok?: boolean; result?: unknown; error?: string }
    try {
      message = JSON.parse(library.call(JSON.stringify({ id: 'sync', method, params }))) as typeof message
    } catch (error) {
      record(method, started, false)
      throw error instanceof Error ? error : new Error(String(error))
    }
    record(method, started, message.ok === true)
    if (message.ok !== true) throw new Error(message.error ?? `${method} failed`)
    return message.result
  }

  const binary = options.binaryPath ?? findBinary()
  if (binary === undefined) throw new Error('the native bridge is not built — run `jean native build`')

  const started = performance.now()
  const ran = spawnSync(binary, [], {
    input: `${JSON.stringify({ id: 'sync', method, params })}\n`,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 15_000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })

  if (ran.error) {
    record(method, started, false)
    throw ran.error
  }

  const line = (ran.stdout ?? '').split('\n').find((l) => l.trim() !== '')
  let message: { ok?: boolean; result?: unknown; error?: string }
  try {
    message = JSON.parse(line ?? '') as typeof message
  } catch {
    record(method, started, false)
    throw new Error(`${method}: the native bridge gave no answer`)
  }

  record(method, started, message.ok === true)
  if (message.ok !== true) throw new Error(message.error ?? `${method} failed`)
  return message.result
}

// ---- typed operations -------------------------------------------------------

export interface AstMatch {
  path?: string
  line: number
  text: string
  captures: Record<string, string>
}

export interface WalkResult {
  count: number
  paths: string[]
  /** Present when the walk was asked for `details`. */
  entries?: { path: string; dir: boolean; size: number }[]
}

export interface BuiltinResult {
  stdout: string
  stderr: string
  code: number
}

export interface PatchApplied {
  content: string
  resolutions: ('exact' | 'disambiguated' | 'recovered-by-text' | 'recovered-by-context')[]
  delta: number
}

export interface SearchHit {
  path: string
  line: number
  column: number
  text: string
}

export interface ShellCommand {
  words: string[]
  line: string
  background: boolean
}

export interface ShellInspection {
  parsed: boolean
  commands: ShellCommand[]
  /** The construct that only a system shell runs, if the line uses one. */
  needsSystemShell: string | null
  error?: string
}

export interface ShellRun {
  stdout: string
  stderr: string
  code: number
  cwd: string
  refused: string[]
  jobs: number[]
}

export interface IsoView {
  id: string
  root: string
  backend: string
  files: number
}

export interface IsoChange {
  path: string
  kind: string
}

export interface IsoMerge {
  applied: number
  changes: IsoChange[]
  conflicts: { path: string; reason: string }[]
  report: string
}

export interface SnapEntity {
  kind: string
  text: string
  count: number
}

export interface SnapFrame {
  hash: string
  summary: string
  entities: SnapEntity[]
  tokensBefore: number
  tokensAfter: number
  rendered: string
}

export interface ProcessInfo {
  pid: number
  parent: number
  name: string
  command: string | null
}

export interface KillReport {
  killed: number[]
  failed: { pid: number; error: string }[]
  alreadyGone: number[]
  summary: string
}

export interface AudioProbe {
  channels: number
  sampleRate: number
  bitsPerSample: number
  durationMs: number
  rms: number
  peak: number
  speech: { startMs: number; endMs: number }[]
}

/**
 * The operations, typed.
 *
 * A thin layer over `call`, but it is where the parameter names live — the
 * bridge takes `respectGitignore` and the crate reads `respect_gitignore`, and
 * having that mapping in one place beats spelling it at every call site.
 */
export class Native {
  constructor(private readonly bridge: NativeBridge) {}

  static open(options: NativeOptions = {}): Native {
    return new Native(new NativeBridge(options))
  }

  available(): Promise<boolean> {
    return this.bridge.available()
  }

  methods(): Promise<string[]> {
    return this.bridge.methods()
  }

  /** The child's pid, for killing it along with whatever it started. */
  get pid(): number | undefined {
    return this.bridge.pid
  }

  close(): void {
    this.bridge.close()
  }

  // -- pi-walker

  /** Every entry under `root`, honouring `.gitignore`. */
  async walk(
    root: string,
    options: {
      respectGitignore?: boolean
      skipHidden?: boolean
      maxDepth?: number
      limit?: number
      extraIgnores?: string[]
      filesOnly?: boolean
      details?: boolean
    } = {},
  ): Promise<WalkResult> {
    return (await this.bridge.call('walk.list', { root, ...options })) as WalkResult
  }

  /** Paths under `root` matching a glob. */
  async glob(root: string, pattern: string, limit?: number, options: { extraIgnores?: string[] } = {}): Promise<WalkResult> {
    return (await this.bridge.call('walk.glob', { root, pattern, limit, ...options })) as WalkResult
  }

  /** Literal (or line-glob) content search over a tree, in one parallel pass. */
  async search(
    root: string,
    pattern: string,
    options: {
      caseSensitive?: boolean
      wholeWord?: boolean
      include?: string
      limit?: number
      glob?: boolean
      extraIgnores?: string[]
    } = {},
  ): Promise<SearchHit[]> {
    return (await this.bridge.call('walk.search', { root, pattern, ...options })) as SearchHit[]
  }

  // -- pi-ast

  /** Structural search over one source string. */
  async searchSource(source: string, pattern: string, path?: string): Promise<AstMatch[]> {
    return (await this.bridge.call('ast.search', { source, pattern, path })) as AstMatch[]
  }

  /** Structural search over a tree. */
  async searchTree(
    root: string,
    pattern: string,
    options: { glob?: string; limit?: number } = {},
  ): Promise<AstMatch[]> {
    return (await this.bridge.call('ast.search_tree', { root, pattern, ...options })) as AstMatch[]
  }

  /** A file's symbol outline, without reading the whole file into context. */
  async outline(path: string): Promise<string> {
    return (await this.bridge.call('ast.outline', { path })) as string
  }

  // -- pi-builtins

  /** Runs one coreutil in-process on the Rust side. */
  async builtin(name: string, args: string[] = [], stdin = ''): Promise<BuiltinResult> {
    return (await this.bridge.call('builtins.run', { name, args, stdin })) as BuiltinResult
  }

  /**
   * Runs coreutils in sequence on `stdin`, each stage feeding the next, in one
   * round trip. `failedStage` says which stage stopped the pipeline.
   */
  async builtinPipeline(
    stages: { name: string; args: string[] }[],
    stdin = '',
  ): Promise<BuiltinResult & { failedStage?: number }> {
    return (await this.bridge.call('builtins.pipeline', { stages, stdin })) as BuiltinResult & {
      failedStage?: number
    }
  }

  /** The coreutils this build provides. */
  async builtins(): Promise<string[]> {
    return (await this.bridge.call('builtins.list', {})) as string[]
  }

  // -- hashline

  /** A file rendered with its anchor gutter, for an agent to cite in an edit. */
  async annotate(content: string): Promise<string> {
    return (await this.bridge.call('hashline.annotate', { content })) as string
  }

  /** The anchor of each line. */
  async anchors(lines: string[]): Promise<string[]> {
    return (await this.bridge.call('hashline.anchors', { lines })) as string[]
  }

  /** Applies a hashline patch. */
  async patch(content: string, patch: string): Promise<string> {
    return (await this.applyPatch(content, patch)).content
  }

  /**
   * Applies a hashline patch and reports how each hunk was placed. A failure
   * rejects with `[code] message`, the code naming what went wrong.
   */
  async applyPatch(content: string, patch: string): Promise<PatchApplied> {
    return (await this.bridge.call('hashline.patch', { content, patch })) as PatchApplied
  }

  // -- pi-shell + brush-core

  /** The simple commands a line would run, parsed but not run. */
  async shellInspect(command: string): Promise<ShellInspection> {
    return (await this.bridge.call('shell.inspect', { command })) as ShellInspection
  }

  /** Opens an embedded shell session rooted at `cwd`. */
  async shellOpen(cwd: string, confined = false): Promise<string> {
    const opened = (await this.bridge.call('shell.open', { cwd, confined })) as { id: string }
    return opened.id
  }

  async shellRun(session: string, command: string, options: { stdin?: string; timeoutMs?: number } = {}): Promise<ShellRun> {
    return (await this.bridge.call(
      'shell.run',
      { session, command, stdin: options.stdin ?? '' },
      options.timeoutMs,
    )) as ShellRun
  }

  async shellClose(session: string): Promise<boolean> {
    return (await this.bridge.call('shell.close', { session })) as boolean
  }

  // -- pi-iso

  /** A private copy of `source` at `destination`, leaving `exclude` out. */
  async isoCreate(source: string, destination: string, exclude: string[] = []): Promise<IsoView> {
    return (await this.bridge.call('iso.create', { source, destination, exclude }, 300_000)) as IsoView
  }

  async isoChanges(id: string): Promise<IsoChange[]> {
    return (await this.bridge.call('iso.changes', { id }, 120_000)) as IsoChange[]
  }

  /** Merges the view back when nothing conflicts; applies nothing otherwise. */
  async isoMerge(id: string): Promise<IsoMerge> {
    return (await this.bridge.call('iso.merge', { id }, 300_000)) as IsoMerge
  }

  async isoDiscard(id: string): Promise<boolean> {
    return (await this.bridge.call('iso.discard', { id }, 120_000)) as boolean
  }

  // -- snapcompact

  /** Archives turns and returns the frame that stands in for them. */
  async snapFrame(store: string, turns: { role: string; text: string }[]): Promise<SnapFrame> {
    return (await this.bridge.call('snap.frame', { store, turns })) as SnapFrame
  }

  /** The full text archived under a hash (or a prefix of one). */
  async snapGet(store: string, hash: string): Promise<string> {
    return (await this.bridge.call('snap.get', { store, hash })) as string
  }

  async snapEntities(text: string): Promise<SnapEntity[]> {
    return (await this.bridge.call('snap.entities', { text })) as SnapEntity[]
  }

  // -- pi-sys

  /** Every process, or the descendants of `root`. */
  async processes(root?: number): Promise<ProcessInfo[]> {
    return (await this.bridge.call('sys.processes', root === undefined ? {} : { root })) as ProcessInfo[]
  }

  /** Kills a process and everything it started. */
  async killTree(pid: number, includeRoot = true): Promise<KillReport> {
    return (await this.bridge.call('sys.kill_tree', { pid, includeRoot })) as KillReport
  }

  /** Puts text on the system clipboard; answers with the backend used. */
  async copy(text: string): Promise<string> {
    return (await this.bridge.call('sys.copy', { text })) as string
  }

  async paste(): Promise<string> {
    return (await this.bridge.call('sys.paste', {})) as string
  }

  /** Holds the machine awake until {@link release}. */
  async awake(reason: string, display = false): Promise<{ id: string; active: boolean }> {
    return (await this.bridge.call('sys.awake', { reason, display })) as { id: string; active: boolean }
  }

  async release(id: string): Promise<boolean> {
    return (await this.bridge.call('sys.release', { id })) as boolean
  }

  // -- pi-tokens

  /**
   * Tokens in `text`: exact when `vocabulary` names a `.tiktoken` file, the
   * calibrated `pi-tokens` estimate otherwise.
   */
  async countTokens(text: string, vocabulary?: string): Promise<number> {
    const counted = (await this.bridge.call('tokens.count', { text, vocabulary })) as { tokens: number }
    return counted.tokens
  }

  async countTokensMany(texts: string[], vocabulary?: string): Promise<number[]> {
    return (await this.bridge.call('tokens.count', { texts, vocabulary })) as number[]
  }

  // -- pi-lsp and pi-dap

  /**
   * An `lsp.*` call. Language servers answer in their own time — a first
   * request waits for the server to start, maybe to be installed — so the
   * default timeout is minutes, not seconds; the bridge runs these on their
   * own threads, so nothing else waits behind them.
   */
  async lsp<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 300_000): Promise<T> {
    return (await this.bridge.call(`lsp.${method}`, params, timeoutMs)) as T
  }

  /** A `dap.*` call; see {@link lsp} for why the timeout is long. */
  async dap<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 600_000): Promise<T> {
    return (await this.bridge.call(`dap.${method}`, params, timeoutMs)) as T
  }

  // -- pi-voice

  async voiceProbe(path: string): Promise<AudioProbe> {
    return (await this.bridge.call('voice.probe', { path })) as AudioProbe
  }

  /** Mono, 16 kHz, silence trimmed — what speech-to-text wants. */
  async voicePrepare(path: string, output: string): Promise<{ output: string; durationMs: number; sampleRate: number }> {
    return (await this.bridge.call('voice.prepare', { path, output }, 120_000)) as {
      output: string
      durationMs: number
      sampleRate: number
    }
  }
}

// ---- the shared instance ----------------------------------------------------

let shared: Native | undefined
let readiness: Promise<boolean> | undefined

/**
 * The process-wide bridge, when it is built and answering.
 *
 * One child serves every caller. The answer is cached — whether the binary
 * exists cannot change within a process — and a child that dies later is
 * respawned by the next call rather than taking the feature down.
 */
export async function nativeReady(): Promise<Native | undefined> {
  if (nativeDisabled()) return undefined
  shared ??= Native.open()
  readiness ??= shared.available()
  return (await readiness) ? shared : undefined
}

/**
 * Holds the machine awake until `release` is called — or until this process
 * exits, since the assertion lives in the bridge and dies with it.
 * `undefined` when the bridge is not built.
 */
export async function holdAwake(reason: string): Promise<{ active: boolean; release(): Promise<void> } | undefined> {
  const native = await nativeReady()
  if (!native) return undefined
  try {
    const held = await native.awake(reason)
    return {
      active: held.active,
      release: async () => {
        await native.release(held.id).catch(() => false)
      },
    }
  } catch {
    return undefined
  }
}

/** Releases the shared child. For a process that is shutting down cleanly. */
export function closeNative(): void {
  shared?.close()
  shared = undefined
  readiness = undefined
}

export interface NativeStatus {
  binary?: string
  /** The in-process library, when built: synchronous calls skip a process start. */
  library?: string
  available: boolean
  version?: string
  methods: string[]
  /** Methods the TypeScript side calls that this build does not answer. */
  missing: string[]
  /** A Rust source is newer than the binary. */
  stale: boolean
  disabled: boolean
}

function newestSource(dir: string, depth = 0): number {
  if (depth > 6 || !existsSync(dir)) return 0
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestSource(path, depth + 1))
    else if (entry.name.endsWith('.rs') || entry.name === 'Cargo.toml') newest = Math.max(newest, statSync(path).mtimeMs)
  }
  return newest
}

/** What `jean doctor` and `jean native` report. */
export async function nativeStatus(): Promise<NativeStatus> {
  const binary = findBinary()
  const status: NativeStatus = {
    binary,
    library: findLibrary(),
    available: false,
    methods: [],
    missing: [...NATIVE_METHODS],
    stale: false,
    disabled: nativeDisabled(),
  }
  if (!binary || status.disabled) return status

  const bridge = new NativeBridge({ binaryPath: binary, timeoutMs: 10_000 })
  try {
    const version = (await bridge.call('version', {})) as { version?: string; methods?: string[] }
    status.available = true
    status.version = version.version
    status.methods = version.methods ?? []
    status.missing = NATIVE_METHODS.filter((method) => !status.methods.includes(method))
  } catch {
    status.available = false
  } finally {
    bridge.close()
  }

  // Stale means a crate linked into the artifact changed after it was built.
  // `pi-ffi` is not part of the binary, and `pi-lsp`/`pi-dap` are outside the
  // workspace, so neither can make it out of date.
  const root = packageRoot()
  if (root && binary.startsWith(root)) {
    const crates = join(root, 'crates')
    const linked = (exclude: string[]) =>
      readdirSync(crates, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !exclude.includes(entry.name))
        .reduce((newest, entry) => Math.max(newest, newestSource(join(crates, entry.name))), 0)
    const outside = ['pi-lsp', 'pi-dap']
    status.stale = linked([...outside, 'pi-ffi']) > statSync(binary).mtimeMs
    if (status.library?.startsWith(root)) {
      status.stale ||= linked(outside) > statSync(status.library).mtimeMs
    }
  }
  return status
}

/**
 * Builds the release binary with cargo, from the checkout this package is in.
 * Resolves with cargo's exit code and output.
 */
export function buildNative(
  onOutput?: (text: string) => void,
): Promise<{ code: number | null; output: string; binary?: string }> {
  const root = packageRoot()
  return new Promise((resolvePromise) => {
    if (!root || !existsSync(join(root, 'Cargo.toml'))) {
      resolvePromise({ code: 1, output: 'no Rust workspace next to this install' })
      return
    }
    let output = ''
    // The binary, then the in-process library under its unwinding profile.
    const steps = [
      ['build', '--release', '-p', 'pi-natives'],
      ['build', '--profile', 'ffi', '-p', 'pi-ffi'],
    ]
    const next = (index: number): void => {
      const child = spawn('cargo', steps[index]!, { cwd: root, windowsHide: true })
      const collect = (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        output += text
        onOutput?.(text)
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      child.on('error', (error) => resolvePromise({ code: 127, output: `cargo could not start: ${error.message}` }))
      child.on('close', (code) => {
        if (code === 0 && index + 1 < steps.length) return next(index + 1)
        // A fresh build changes what discovery finds; drop the cached answers.
        closeNative()
        inProcess = undefined
        resolvePromise({ code, output, binary: code === 0 ? findBinary() : undefined })
      })
    }
    next(0)
  })
}
