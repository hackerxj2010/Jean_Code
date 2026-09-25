import { nativeReady, type Native } from '@jean/native'

/**
 * The debugger engine in `crates/pi-dap`, reached through the bridge.
 *
 * What the debug tools use whenever the Rust core is built: adapters for
 * Python, JavaScript/TypeScript, Go, Rust/C/C++, .NET, and more — found in
 * the project, on PATH, or installed into `~/.jean/tools` — over stdio or
 * TCP, with js-debug's child sessions followed. Every call that moves the
 * program answers with a snapshot: where it stopped, the stack with each
 * frame's source line, the variables of the frame, and the output since the
 * last look. Lines are one-based, as editors count them.
 */

export interface BreakpointLine {
  line: number
  condition?: string
  hitCondition?: string
  logMessage?: string
}

export interface Frame {
  id: number
  name: string
  path: string | null
  line: number
  column: number
  /** The source line the frame is on. */
  text: string | null
  /** In the runtime rather than the program — Node's internals, say. */
  internal?: boolean
}

export interface Value {
  name: string
  value: string
  type: string | null
  /** Non-zero when it has members; pass to `variables` to expand further. */
  reference: number
  children?: Value[]
}

export interface Snapshot {
  session: string
  status: 'starting' | 'running' | 'stopped' | 'exited' | 'terminated'
  exitCode?: number
  reason?: string | null
  description?: string | null
  text?: string | null
  thread?: number
  /** How many threads the program has. */
  threads?: number
  frames?: Frame[]
  /** `sameAs` names an earlier scope holding the same variables — Python's globals at module level. */
  scopes?: { name: string; reference: number; expensive: boolean; variables: Value[] | null; sameAs?: string }[]
  /** What the program printed since the previous snapshot. */
  output: string
}

export interface AdapterInfo {
  id: string
  name: string
  extensions: string[]
  transport: 'stdio' | 'tcp'
  status: 'installed' | 'installable' | 'missing'
  path: string | null
  install: string | null
}

export interface SessionInfo {
  id: string
  adapter: string
  program: string | null
  status: Snapshot['status']
  pid: number | null
  uptimeSeconds: number
  events: string[]
  stderr: string[]
}

export interface StartOptions {
  program?: string
  /** Adapter id; chosen from the program's extension when absent. */
  adapter?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  request?: 'launch' | 'attach'
  /** Merged over the adapter's launch configuration. */
  config?: Record<string, unknown>
  stopOnEntry?: boolean
  breakpoints?: { path: string; lines: (number | BreakpointLine)[] }[]
  functionBreakpoints?: string[]
  /** A mode in the adapter's own terms, or its filter names. */
  exceptions?: 'uncaught' | 'all' | 'none' | string[]
  /** Attach to an adapter already listening at `host:port`. */
  address?: string
  /** How long to wait for the program to stop or end. */
  waitMs?: number
  depth?: number
}

export interface EngineOptions {
  projectRoot: string
  /** Overrides and additions, as in the `debuggers` config section. */
  adapters?: Record<string, unknown>
  autoInstall?: boolean
  toolsDir?: string
}

type Look = { frame?: number; depth?: number; levels?: number }

export class NativeDebuggers {
  private constructor(private readonly native: Native) {}

  /** The engine, configured — `undefined` without the Rust core. */
  static async open(options: EngineOptions): Promise<NativeDebuggers | undefined> {
    const native = await nativeReady()
    if (!native) return undefined
    try {
      await native.dap('configure', {
        projectRoot: options.projectRoot,
        adapters: options.adapters ?? {},
        ...(options.autoInstall === undefined ? {} : { autoInstall: options.autoInstall }),
        ...(options.toolsDir ? { toolsDir: options.toolsDir } : {}),
      })
      return new NativeDebuggers(native)
    } catch {
      return undefined
    }
  }

  private call<T>(method: string, params: object, timeoutMs?: number): Promise<T> {
    return this.native.dap<T>(method, params as Record<string, unknown>, timeoutMs)
  }

  adapters(path?: string): Promise<AdapterInfo[]> {
    return this.call('adapters', path ? { path } : {})
  }

  install(id: string): Promise<{ id: string; path: string }> {
    return this.call('install', { id }, 900_000)
  }

  /** Starts a session and runs to the first stop, or to the end. */
  start(options: StartOptions): Promise<Snapshot> {
    // Building a Cargo project before debugging it can take minutes.
    return this.call('start', options, 900_000)
  }

  /** `add` and `remove` edit the file's set; `replace` sets it outright. */
  breakpoints(path: string, lines: (number | BreakpointLine)[], mode: 'add' | 'remove' | 'replace' = 'add', session?: string) {
    return this.call<{ verified: boolean; line: number | null; message: string | null; id: number | null }[]>('breakpoints', {
      path,
      lines,
      mode,
      ...(session ? { session } : {}),
    })
  }

  functionBreakpoints(names: string[], session?: string) {
    return this.call<{ breakpoints?: { verified?: boolean; message?: string }[] }>('function_breakpoints', {
      names,
      ...(session ? { session } : {}),
    })
  }

  exceptions(mode: 'uncaught' | 'all' | 'none' | string[], session?: string) {
    return this.call<{ filters: string[]; available: { filter: string; label: string }[] }>('exceptions', {
      ...(Array.isArray(mode) ? { filters: mode } : { mode }),
      ...(session ? { session } : {}),
    })
  }

  control(action: string, options: Look & { session?: string; thread?: number; waitMs?: number } = {}): Promise<Snapshot> {
    return this.call('control', { action, ...options }, (options.waitMs ?? 10_000) + 60_000)
  }

  wait(options: Look & { session?: string; timeoutMs?: number } = {}): Promise<Snapshot> {
    return this.call('wait', options, (options.timeoutMs ?? 10_000) + 60_000)
  }

  inspect(options: Look & { session?: string } = {}): Promise<Snapshot> {
    return this.call('inspect', options)
  }

  evaluate(expression: string, options: { session?: string; frame?: number; context?: 'repl' | 'watch' | 'hover'; depth?: number } = {}) {
    return this.call<Value & { result: string }>('evaluate', { expression, ...options })
  }

  variables(reference: number, options: { session?: string; depth?: number; limit?: number } = {}): Promise<Value[]> {
    return this.call('variables', { reference, ...options })
  }

  setVariable(reference: number, name: string, value: string, session?: string) {
    return this.call<{ value?: string; type?: string }>('set_variable', { reference, name, value, ...(session ? { session } : {}) })
  }

  threads(session?: string): Promise<{ id: number; name: string }[]> {
    return this.call('threads', session ? { session } : {})
  }

  stack(options: { session?: string; thread?: number; levels?: number } = {}): Promise<Frame[]> {
    return this.call('stack', options)
  }

  /** Output since `since` (a cursor), or since the caller last read it. */
  output(options: { session?: string; since?: number } = {}) {
    return this.call<{ lines: { category: string; text: string }[]; cursor: number }>('output', options)
  }

  sessions(): Promise<SessionInfo[]> {
    return this.call('sessions', {})
  }

  stop(session?: string): Promise<string[]> {
    return this.call('stop', session ? { session } : {})
  }
}
