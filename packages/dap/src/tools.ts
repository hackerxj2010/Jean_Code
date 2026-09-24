import { displayPath, resolveInWorkspace, ToolError, type Tool, type ToolContext, type ToolResult } from '@jean/tools'
import { adapterFor, availableAdapters } from './adapters.ts'
import { NativeDebuggers, type BreakpointLine, type Snapshot, type Value } from './native.ts'
import { DebugSession, type StackFrame, type Variable } from './session.ts'

/**
 * Debugger tools (architecture §8.3).
 *
 * Deliberately a small surface over the protocol. An agent does not want a
 * tool per DAP request; it wants to answer "why is this wrong", and the
 * shortest path there is: break, run, look at the stack with live values.
 * So every tool that moves the program answers with where it stopped, the
 * stack with each frame's source line, and the frame's variables — the
 * alternative is three round trips to learn one thing.
 *
 * The Rust engine (`crates/pi-dap`) serves them when it is built; the
 * TypeScript session serves the basic five without it.
 */

export interface RegistryOptions {
  projectRoot?: string
  /** The `debuggers` config section: overrides of bundled adapters, and new ones. */
  config?: Record<string, unknown>
  /** Whether a missing adapter may be installed into `~/.jean/tools`. */
  autoInstall?: boolean
  toolsDir?: string
}

/** Sessions live for the length of an agent session, keyed by their id. */
export class DebugRegistry {
  private readonly sessions = new Map<string, DebugSession>()
  private readonly outputs = new Map<string, string[]>()
  private counter = 0
  private engine?: Promise<NativeDebuggers | undefined>
  /** Breakpoints asked for before any session existed, set by the next start. */
  readonly pending = new Map<string, BreakpointLine[]>()

  constructor(private readonly options: RegistryOptions = {}) {}

  /**
   * The Rust engine, opened once — `undefined` when the core is not built,
   * and the TypeScript sessions below serve instead.
   */
  native(cwd?: string): Promise<NativeDebuggers | undefined> {
    this.engine ??= NativeDebuggers.open({
      projectRoot: this.options.projectRoot ?? cwd ?? process.cwd(),
      adapters: this.options.config,
      autoInstall: this.options.autoInstall,
      toolsDir: this.options.toolsDir,
    })
    return this.engine
  }

  add(session: DebugSession, output: string[] = []): string {
    const id = `dbg${++this.counter}`
    this.sessions.set(id, session)
    this.outputs.set(id, output)
    return id
  }

  get(id: string): DebugSession | undefined {
    return this.sessions.get(id)
  }

  outputOf(id: string): string[] {
    return this.outputs.get(id) ?? []
  }

  /** The most recent session, so the agent need not track ids for one debuggee. */
  latest(): { id: string; session: DebugSession } | undefined {
    const entries = [...this.sessions.entries()]
    for (let i = entries.length - 1; i >= 0; i--) {
      const [id, session] = entries[i]!
      if (session.isRunning) return { id, session }
    }
    return undefined
  }

  list(): { id: string; running: boolean }[] {
    return [...this.sessions.entries()].map(([id, session]) => ({ id, running: session.isRunning }))
  }

  /** Ends every session in both engines — debuggees are child processes. */
  stopAll(): void {
    for (const session of this.sessions.values()) session.stop()
    this.sessions.clear()
    this.outputs.clear()
    void this.engine?.then((engine) => engine?.stop()).catch(() => undefined)
  }
}

// ---- rendering ----------------------------------------------------------------

const shownPath = (path: string, cwd: string) => displayPath(path, { cwd } as never)

function renderValues(values: Value[], indent: string, limit: number): string[] {
  const out: string[] = []
  for (const value of values.slice(0, limit)) {
    const type = value.type ? ` (${value.type})` : ''
    // A reference without children is expandable on request.
    const more = value.reference > 0 && !value.children ? `  [ref ${value.reference}]` : ''
    out.push(`${indent}${value.name}${type} = ${value.value.replace(/\s+/g, ' ').slice(0, 200)}${more}`)
    if (value.children && value.children.length > 0) out.push(...renderValues(value.children, `${indent}    `, 15))
  }
  if (values.length > limit) out.push(`${indent}... ${values.length - limit} more`)
  return out
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : `...${text.slice(text.length - max)}`
}

export function renderSnapshot(snapshot: Snapshot, cwd: string): string {
  const out: string[] = []
  switch (snapshot.status) {
    case 'exited':
      out.push(`[${snapshot.session}] The program exited${snapshot.exitCode === undefined ? '' : ` with code ${snapshot.exitCode}`}.`)
      break
    case 'terminated':
      out.push(`[${snapshot.session}] The session has ended.`)
      break
    case 'starting':
    case 'running':
      out.push(
        `[${snapshot.session}] The program is running and has not stopped yet. \`debug_control\` with \`wait\` waits longer; \`pause\` stops it where it is.`,
      )
      break
    case 'stopped': {
      const why = [snapshot.reason, snapshot.description !== snapshot.reason ? snapshot.description : null, snapshot.text]
        .filter(Boolean)
        .join(' — ')
      out.push(`[${snapshot.session}] Stopped: ${why || 'paused'}${snapshot.thread === undefined ? '' : ` (thread ${snapshot.thread})`}`)
      const frames = snapshot.frames ?? []
      if (frames.length > 0) {
        out.push('', 'Stack:')
        for (const [index, frame] of frames.slice(0, 15).entries()) {
          const where = frame.path ? `${shownPath(frame.path, cwd)}:${frame.line}` : `line ${frame.line}`
          out.push(`  #${index} ${frame.name}  ${where}${frame.text ? `    ${frame.text.slice(0, 120)}` : ''}`)
        }
        if (frames.length > 15) out.push(`  ... ${frames.length - 15} more frames`)
      }
      for (const scope of snapshot.scopes ?? []) {
        if (scope.variables === null) {
          out.push('', `${scope.name}: not fetched (large) — \`debug_inspect\` with reference ${scope.reference}`)
        } else if (scope.variables.length > 0) {
          out.push('', `${scope.name}:`, ...renderValues(scope.variables, '  ', 40))
        }
      }
      break
    }
  }
  if (snapshot.output.trim()) out.push('', 'Output:', tail(snapshot.output.trimEnd(), 3000))
  return out.join('\n')
}

function formatFrames(frames: StackFrame[], cwd: string, limit = 12): string {
  return frames
    .slice(0, limit)
    .map((frame, index) => `  #${index} ${frame.name}  ${frame.path ? `${shownPath(frame.path, cwd)}:${frame.line}` : `line ${frame.line}`}`)
    .join('\n')
}

function formatVariables(variables: Variable[], limit = 40): string {
  return variables
    .slice(0, limit)
    .map((v) => `  ${v.name}${v.type ? ` (${v.type})` : ''} = ${v.value.slice(0, 200)}${v.variablesReference > 0 ? ' …' : ''}`)
    .join('\n')
}

function engineError(error: unknown): never {
  throw new ToolError(error instanceof Error ? error.message : String(error))
}

function needsNative(what: string): never {
  throw new ToolError(`${what} needs the Rust debugger engine, which is not built.`, 'Run `jean native build`.')
}

// ---- breakpoint arguments -----------------------------------------------------

type LineArg = number | BreakpointLine
type BreakpointArg =
  | string
  | { path: string; line?: number; lines?: LineArg[]; condition?: string; logMessage?: string; hitCondition?: string }

const lineSchema = {
  anyOf: [
    { type: 'integer' },
    {
      type: 'object',
      properties: {
        line: { type: 'integer' },
        condition: { type: 'string', description: 'Stop only when this is true, e.g. `i > 10`.' },
        hitCondition: { type: 'string', description: 'Stop on the Nth hit, e.g. `5`.' },
        logMessage: { type: 'string', description: 'Print this instead of stopping; `{expr}` interpolates.' },
      },
      required: ['line'],
    },
  ],
}

/** `src/a.py:12`, or `{ path, lines }`, into files and their lines. */
function parseBreakpoints(list: BreakpointArg[], context: ToolContext): Map<string, BreakpointLine[]> {
  const files = new Map<string, BreakpointLine[]>()
  for (const item of list) {
    let path: string
    let lines: BreakpointLine[]
    if (typeof item === 'string') {
      const at = item.lastIndexOf(':')
      const line = Number(item.slice(at + 1))
      if (at <= 0 || !Number.isInteger(line) || line < 1) throw new ToolError(`\`${item}\` is not \`path:line\`.`)
      path = item.slice(0, at)
      lines = [{ line }]
    } else {
      path = item.path
      const given = item.lines ?? (item.line === undefined ? [] : [item.line])
      if (given.length === 0) throw new ToolError(`No line given for ${item.path}.`)
      const extra = {
        ...(item.condition ? { condition: item.condition } : {}),
        ...(item.hitCondition ? { hitCondition: item.hitCondition } : {}),
        ...(item.logMessage ? { logMessage: item.logMessage } : {}),
      }
      lines = given.map((line) => (typeof line === 'number' ? { line, ...extra } : { ...extra, ...line }))
    }
    const absolute = resolveInWorkspace(path, context)
    files.set(absolute, [...(files.get(absolute) ?? []), ...lines])
  }
  return files
}

// ---- the tools ----------------------------------------------------------------

export function createDebugTools(registry: DebugRegistry): Tool[] {
  /** The TypeScript session an argument refers to, or the newest one. */
  function sessionOf(id?: string): { id: string; session: DebugSession } {
    if (id) {
      const session = registry.get(id)
      if (!session) throw new ToolError(`No debug session "${id}".`, 'Start one with `debug_start`.')
      return { id, session }
    }
    const latest = registry.latest()
    if (!latest) throw new ToolError('No debug session is running.', 'Start one with `debug_start`.')
    return latest
  }

  const startTool: Tool<{
    program?: string
    args?: string[]
    adapter?: string
    cwd?: string
    env?: Record<string, string>
    stopOnEntry?: boolean
    breakpoints?: BreakpointArg[]
    exceptions?: 'uncaught' | 'all' | 'none'
    request?: 'launch' | 'attach'
    config?: Record<string, unknown>
    address?: string
    waitMs?: number
  }> = {
    name: 'debug_start',
    risk: 'execute',
    description: [
      'Run a program under a debugger, to the first breakpoint.',
      '',
      'Use it when a failure is hard to reason about from the source — a crash, a',
      'hang, a value wrong for no visible reason. Give the breakpoints here',
      '(`["src/app.py:42"]`, or `{path, lines: [{line, condition}]}`): it answers',
      'with where the program stopped, the stack, and the live variables.',
      '',
      'Python, JavaScript/TypeScript, Go, Rust/C/C++, C#, and more; the adapter',
      'is chosen from the file and installed when missing. Uncaught exceptions',
      'stop the program by default. `config` adds to the launch configuration',
      '(e.g. `{"justMyCode": false}`); `request: "attach"` with `config`',
      '(`{"processId": 1234}` or `{"port": 5678}`) attaches to a running process.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        program: { type: 'string', description: 'The file or binary to debug.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Its arguments.' },
        adapter: {
          type: 'string',
          description: 'Adapter id (debugpy, js-debug, delve, codelldb, lldb-dap, gdb, netcoredbg...). Default: from the file.',
        },
        cwd: { type: 'string', description: 'Working directory. Default: the project.' },
        env: { type: 'object', description: 'Extra environment variables.' },
        stopOnEntry: { type: 'boolean', description: 'Stop on the first line.' },
        breakpoints: {
          type: 'array',
          description: '`path:line` strings, or `{path, lines}` with conditions and log messages.',
          items: {
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  lines: { type: 'array', items: lineSchema },
                  condition: { type: 'string' },
                  logMessage: { type: 'string' },
                },
                required: ['path'],
              },
            ],
          },
        },
        exceptions: { type: 'string', enum: ['uncaught', 'all', 'none'], description: 'Which exceptions stop the program. Default: uncaught.' },
        request: { type: 'string', enum: ['launch', 'attach'] },
        config: { type: 'object', description: 'Added to the launch configuration.' },
        address: { type: 'string', description: 'host:port of an adapter already listening, to connect to instead of starting one.' },
        waitMs: { type: 'integer', description: 'How long to wait for the first stop. Default 15000.' },
      },
    },
    summarize: (args) => `debug ${args.program ?? args.address ?? args.adapter ?? ''}`.trim(),

    async execute(args, context): Promise<ToolResult> {
      const files = parseBreakpoints(args.breakpoints ?? [], context)
      for (const [path, lines] of registry.pending) files.set(path, [...lines, ...(files.get(path) ?? [])])
      const program = args.program ? resolveInWorkspace(args.program, context) : undefined

      const engine = await registry.native(context.cwd)
      if (engine) {
        if (!program && !args.address && !(args.request === 'attach' && args.config)) {
          throw new ToolError('Give `program`, or `request: "attach"` with `config`, or `address`.')
        }
        const snapshot = await engine
          .start({
            ...(program ? { program } : {}),
            ...(args.adapter ? { adapter: args.adapter } : {}),
            ...(args.args ? { args: args.args } : {}),
            ...(args.cwd ? { cwd: resolveInWorkspace(args.cwd, context) } : {}),
            ...(args.env ? { env: args.env } : {}),
            ...(args.request ? { request: args.request } : {}),
            ...(args.config ? { config: args.config } : {}),
            ...(args.stopOnEntry ? { stopOnEntry: true } : {}),
            ...(args.exceptions ? { exceptions: args.exceptions } : {}),
            ...(args.address ? { address: args.address } : {}),
            ...(args.waitMs ? { waitMs: args.waitMs } : {}),
            breakpoints: [...files].map(([path, lines]) => ({ path, lines })),
          })
          .catch(engineError)
        registry.pending.clear()
        return {
          output: renderSnapshot(snapshot, context.cwd),
          display: { kind: 'debug', session: snapshot.session, status: snapshot.status },
        }
      }

      if (!program) throw new ToolError('Give `program`: attaching needs the Rust debugger engine (`jean native build`).')
      const shown = displayPath(program, context)
      const match = await adapterFor(program)
      if (!match) {
        throw new ToolError(
          `No debug adapter is installed for ${shown}.`,
          'Install one (debugpy for Python, dlv for Go, lldb-dap for C/C++/Rust), or build the Rust core (`jean native build`), which installs them.',
        )
      }
      const output: string[] = []
      const session = new DebugSession({
        spec: match.spec,
        cwd: match.root,
        launchArgs: {
          [match.spec.programKey ?? 'program']: program,
          args: args.args ?? [],
          stopOnEntry: args.stopOnEntry ?? false,
          ...(args.config ?? {}),
        },
        onOutput: (_category, text) => output.push(text),
      })
      if (!(await session.start())) throw new ToolError(`The ${match.spec.id} adapter failed to start.`)
      for (const [path, lines] of files) {
        for (const { line } of lines) await session.setBreakpoint(path, line)
      }
      registry.pending.clear()
      const id = registry.add(session, output)
      return {
        output: [
          `Debug session ${id} started with ${match.spec.id} on ${shown}${files.size > 0 ? `, breakpoints set in ${files.size} file${files.size === 1 ? '' : 's'}` : ''}.`,
          '',
          '`debug_control` with `continue` runs it.',
        ].join('\n'),
        display: { kind: 'debug', session: id, adapter: match.spec.id },
      }
    },
  }

  const breakpointTool: Tool<{
    path?: string
    line?: number
    lines?: LineArg[]
    condition?: string
    hitCondition?: string
    logMessage?: string
    clear?: boolean
    replace?: boolean
    functions?: string[]
    exceptions?: 'uncaught' | 'all' | 'none'
    session?: string
  }> = {
    name: 'debug_breakpoint',
    risk: 'execute',
    description: [
      'Add or remove breakpoints in a running session: lines (with a `condition`,',
      'a `hitCondition`, or a `logMessage` that prints instead of stopping), whole',
      '`functions` by name, or which `exceptions` stop the program.',
      '`clear: true` removes the given lines; `replace: true` makes them the',
      "file's only ones. Given before any session, they apply to the next `debug_start`.",
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Source file.' },
        line: { type: 'integer', description: 'Line, 1-based.' },
        lines: { type: 'array', items: lineSchema, description: 'Several lines.' },
        condition: { type: 'string', description: 'Stop only when this is true.' },
        hitCondition: { type: 'string', description: 'Stop on the Nth hit.' },
        logMessage: { type: 'string', description: 'Log instead of stopping; `{expr}` interpolates.' },
        clear: { type: 'boolean', description: 'Remove these lines.' },
        replace: { type: 'boolean', description: "Make these the file's only breakpoints." },
        functions: { type: 'array', items: { type: 'string' }, description: 'Break on entry to these functions.' },
        exceptions: { type: 'string', enum: ['uncaught', 'all', 'none'] },
        session: { type: 'string', description: 'Session id. Default: the live one.' },
      },
    },
    summarize: (args) =>
      args.path
        ? `${args.clear ? 'clear' : 'break'} ${args.path}:${args.line ?? (args.lines ?? []).map((l) => (typeof l === 'number' ? l : l.line)).join(',')}`
        : 'breakpoints',

    async execute(args, context): Promise<ToolResult> {
      if (!args.path && !args.functions && !args.exceptions) {
        throw new ToolError('Give `path` with `line`/`lines`, `functions`, or `exceptions`.')
      }
      const engine = await registry.native(context.cwd)
      const report: string[] = []

      if (args.path) {
        const path = resolveInWorkspace(args.path, context)
        const shown = displayPath(path, context)
        const lines = [...parseBreakpoints([{ ...args, path: args.path }], context).values()][0] ?? []

        if (engine) {
          const mode = args.clear ? 'remove' : args.replace ? 'replace' : 'add'
          try {
            const set = await engine.breakpoints(path, lines, mode, args.session)
            report.push(
              set.length === 0
                ? `No breakpoints left in ${shown}.`
                : `Breakpoints in ${shown}: ${set.map((bp) => `${bp.line ?? '?'}${bp.verified ? '' : ' (unverified)'}`).join(', ')}.`,
            )
            // An unverified breakpoint never fires, silently: the program runs
            // to the end and the agent concludes the code is not reached.
            for (const bp of set.filter((b) => !b.verified)) {
              report.push(
                `Line ${bp.line ?? '?'} is not verified${bp.message ? `: ${bp.message}` : ''} — it may not be hit (no code on that line, or not loaded yet).`,
              )
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (!message.includes('no debug session')) engineError(error)
            // Nothing running yet: kept for the next start.
            const kept = (registry.pending.get(path) ?? []).filter((known) => !lines.some((l) => l.line === known.line))
            if (!args.clear) kept.push(...lines)
            registry.pending.set(path, kept)
            report.push(
              `No session is running; ${shown} will have breakpoints at ${kept.map((l) => l.line).join(', ') || 'no lines'} when \`debug_start\` runs.`,
            )
          }
        } else {
          const { session } = sessionOf(args.session)
          for (const { line } of lines) {
            const set = args.clear ? await session.clearBreakpoint(path, line) : await session.setBreakpoint(path, line)
            const placed = set.find((bp) => bp.line === line)
            if (!args.clear && placed && !placed.verified) {
              report.push(`Line ${line} is not verified${placed.message ? `: ${placed.message}` : ''} — it will not be hit.`)
            }
          }
          report.unshift(`${args.clear ? 'Cleared' : 'Set'} ${lines.map((l) => l.line).join(', ')} in ${shown}.`)
        }
      }

      if (args.functions) {
        if (!engine) needsNative('Function breakpoints')
        const result = await engine.functionBreakpoints(args.functions, args.session).catch(engineError)
        const failed = (result.breakpoints ?? []).filter((bp) => bp.verified === false)
        report.push(`Function breakpoints: ${args.functions.join(', ') || 'none'}.${failed.length > 0 ? ` ${failed.length} not verified.` : ''}`)
      }

      if (args.exceptions) {
        if (!engine) needsNative('Choosing which exceptions stop')
        const result = await engine.exceptions(args.exceptions, args.session).catch(engineError)
        const offered = result.available.map((f) => `${f.filter} (${f.label})`).join(', ')
        report.push(`Exceptions that stop: ${result.filters.join(', ') || 'none'}. Offered by this adapter: ${offered || 'none'}.`)
      }
      return { output: report.join('\n') }
    },
  }

  const controlTool: Tool<{
    action: 'continue' | 'next' | 'step_in' | 'step_out' | 'pause' | 'step_back' | 'reverse_continue' | 'wait'
    session?: string
    thread?: number
    waitMs?: number
  }> = {
    name: 'debug_control',
    risk: 'execute',
    description: [
      'Move the program: `continue` to the next breakpoint, `next` (step over),',
      '`step_in`, `step_out`, `pause`, or `wait` for it to stop. Answers with where',
      'it stopped, the stack, and the variables — or that it exited, and its output.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['continue', 'next', 'step_in', 'step_out', 'pause', 'step_back', 'reverse_continue', 'wait'] },
        session: { type: 'string', description: 'Session id. Default: the live one.' },
        thread: { type: 'integer', description: 'Thread id. Default: the one that stopped.' },
        waitMs: { type: 'integer', description: 'How long to wait for the next stop. Default 10000.' },
      },
      required: ['action'],
    },
    summarize: (args) => `debug ${args.action}`,

    async execute(args, context): Promise<ToolResult> {
      const engine = await registry.native(context.cwd)
      if (engine) {
        const session = args.session ? { session: args.session } : {}
        const protocol: Record<string, string> = {
          step_in: 'stepIn',
          step_out: 'stepOut',
          step_back: 'stepBack',
          reverse_continue: 'reverseContinue',
        }
        const snapshot =
          args.action === 'wait'
            ? await engine.wait({ ...session, ...(args.waitMs ? { timeoutMs: args.waitMs } : {}) }).catch(engineError)
            : await engine
                .control(protocol[args.action] ?? args.action, {
                  ...session,
                  ...(args.thread === undefined ? {} : { thread: args.thread }),
                  ...(args.waitMs ? { waitMs: args.waitMs } : {}),
                })
                .catch(engineError)
        return {
          output: renderSnapshot(snapshot, context.cwd),
          display: { kind: 'debug', session: snapshot.session, status: snapshot.status },
        }
      }

      const { session } = sessionOf(args.session)
      await session.configurationDone()
      switch (args.action) {
        case 'continue':
          await session.continue(args.thread)
          break
        case 'next':
          await session.next(args.thread)
          break
        case 'step_in':
          await session.stepIn(args.thread)
          break
        case 'step_out':
          await session.stepOut(args.thread)
          break
        case 'pause':
          await session.pause(args.thread)
          break
        case 'wait':
          break
        default:
          needsNative(`\`${args.action}\``)
      }
      // The `stopped` event arrives on its own; poll for it briefly.
      const deadline = Date.now() + (args.waitMs ?? 3_000)
      while (!session.stoppedAt() && session.isRunning && Date.now() < deadline) await Bun.sleep(50)
      const stopped = session.stoppedAt()
      if (!stopped) {
        return { output: session.isRunning ? 'Execution is running. It has not hit a breakpoint yet.' : 'The program has finished.' }
      }
      return {
        output: `Stopped: ${stopped.reason}${stopped.description ? ` — ${stopped.description}` : ''}. Use \`debug_inspect\` to see the stack.`,
      }
    },
  }

  const inspectTool: Tool<{
    session?: string
    frame?: number
    expression?: string
    reference?: number
    depth?: number
    variable?: string
    value?: string
  }> = {
    name: 'debug_inspect',
    risk: 'read',
    // A debug session answers one request about one stopped thread at a time.
    concurrency: 'serial',
    description: [
      'Look at the stopped program: the stack and the variables of a `frame`',
      '(0 is where it stopped). `expression` evaluates code in that frame — the',
      'fastest way to test a hypothesis. `reference` expands a `[ref N]` value.',
      '`variable` with `value` changes a variable (`user.age`) before continuing.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session id. Default: the live one.' },
        frame: { type: 'integer', description: 'Stack frame index. Default 0.' },
        expression: { type: 'string', description: 'Evaluate this in the frame.' },
        reference: { type: 'integer', description: 'Expand this variable reference.' },
        depth: { type: 'integer', description: 'How many levels of members to expand (default 1, max 4).' },
        variable: { type: 'string', description: 'A variable to change, e.g. `count` or `user.age`.' },
        value: { type: 'string', description: 'Its new value, as source.' },
      },
    },
    summarize: (args) => (args.expression ? `evaluate ${args.expression}` : args.variable ? `set ${args.variable}` : 'inspect'),

    async execute(args, context): Promise<ToolResult> {
      const engine = await registry.native(context.cwd)
      if (engine) {
        const session = args.session ? { session: args.session } : {}
        const frame = args.frame === undefined ? {} : { frame: args.frame }
        if (args.expression) {
          const result = await engine.evaluate(args.expression, { ...session, ...frame, depth: args.depth ?? 1 }).catch(engineError)
          const expandable = result.reference > 0 && !result.children ? `  [ref ${result.reference}]` : ''
          return {
            output: [
              `${args.expression} = ${result.result}${result.type ? ` (${result.type})` : ''}${expandable}`,
              ...renderValues(result.children ?? [], '  ', 50),
            ].join('\n'),
          }
        }
        if (args.reference !== undefined) {
          const values = await engine.variables(args.reference, { ...session, depth: args.depth ?? 1 }).catch(engineError)
          return { output: values.length === 0 ? 'No members.' : renderValues(values, '', 100).join('\n') }
        }
        if (args.variable !== undefined) {
          if (args.value === undefined) throw new ToolError('Give the new `value` too.')
          const snapshot = await engine.inspect({ ...session, ...frame, depth: 0 }).catch(engineError)
          if (snapshot.status !== 'stopped') throw new ToolError('The program is not stopped, so its variables cannot be changed.')
          // Walk `user.age`: the scope holding `user`, then its members.
          const [first, ...rest] = args.variable.split('.')
          const scope = (snapshot.scopes ?? []).find((s) => s.variables?.some((v) => v.name === first))
          const found = scope?.variables?.find((v) => v.name === first)
          if (!scope || !found) throw new ToolError(`\`${first}\` is not a variable in this frame.`)
          let parent = scope.reference
          let current = found
          for (const name of rest) {
            const members = await engine.variables(current.reference, { ...session, depth: 0 }).catch(engineError)
            const next = members.find((m) => m.name === name)
            if (!next) throw new ToolError(`\`${current.name}\` has no member \`${name}\`.`)
            parent = current.reference
            current = next
          }
          const set = await engine.setVariable(parent, current.name, args.value, args.session).catch(engineError)
          return { output: `${args.variable} = ${set.value ?? args.value}${set.type ? ` (${set.type})` : ''}` }
        }
        const snapshot = await engine.inspect({ ...session, ...frame, depth: Math.min(args.depth ?? 1, 4) }).catch(engineError)
        return { output: renderSnapshot(snapshot, context.cwd), display: { kind: 'debug-stack', frames: snapshot.frames?.length ?? 0 } }
      }

      const { session } = sessionOf(args.session)
      const stopped = session.stoppedAt()
      if (!stopped) {
        return { output: session.isRunning ? 'Execution is not stopped, so there is no stack to inspect.' : 'The session has ended.' }
      }
      const frames = await session.stackTrace()
      if (frames.length === 0) return { output: 'The adapter reported no stack frames.' }
      const target = frames[args.frame ?? 0] ?? frames[0]!
      if (args.expression) {
        const result = await session.evaluate(args.expression, target.id)
        return { output: `${args.expression} = ${result.result}${result.type ? ` (${result.type})` : ''}` }
      }
      if (args.variable !== undefined) needsNative('Changing a variable')
      const sections = [
        `Stopped: ${stopped.reason}${stopped.description ? ` — ${stopped.description}` : ''}`,
        '',
        'Stack:',
        formatFrames(frames, context.cwd),
      ]
      // Scopes the adapter marks expensive are globals; fetching them can take seconds.
      for (const scope of (await session.scopes(target.id)).filter((s) => !s.expensive)) {
        const variables = await session.variables(scope.variablesReference)
        if (variables.length > 0) sections.push('', `${scope.name}:`, formatVariables(variables))
      }
      const exception = await session.exceptionInfo()
      if (exception) sections.push('', `Exception: ${exception.exceptionId}${exception.description ? `\n  ${exception.description}` : ''}`)
      return { output: sections.join('\n'), display: { kind: 'debug-stack', frames: frames.length } }
    },
  }

  const outputTool: Tool<{ session?: string; all?: boolean }> = {
    name: 'debug_output',
    risk: 'read',
    description: 'What the debugged program printed since the last look — or `all` of it.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session id. Default: the live one.' },
        all: { type: 'boolean', description: 'Everything since the start.' },
      },
    },
    summarize: () => 'debug output',

    async execute(args, context): Promise<ToolResult> {
      const engine = await registry.native(context.cwd)
      if (engine) {
        const result = await engine
          .output({ ...(args.session ? { session: args.session } : {}), ...(args.all ? { since: 0 } : {}) })
          .catch(engineError)
        const text = result.lines.map((line) => line.text).join('')
        return { output: text.trim() ? tail(text.trimEnd(), 8000) : 'No new output.' }
      }
      const { id } = sessionOf(args.session)
      const text = registry.outputOf(id).join('')
      return { output: text.trim() ? tail(text.trimEnd(), 8000) : 'No output.' }
    },
  }

  const stopTool: Tool<{ session?: string }> = {
    name: 'debug_stop',
    risk: 'execute',
    description: 'End a debug session and kill its program. Without `session`, ends them all.',
    parameters: { type: 'object', properties: { session: { type: 'string', description: 'Session id.' } } },
    summarize: () => 'debug stop',

    async execute(args, context): Promise<ToolResult> {
      const engine = await registry.native(context.cwd)
      if (engine) {
        const stopped = await engine.stop(args.session).catch(engineError)
        return { output: stopped.length === 0 ? 'No debug session was running.' : `Ended ${stopped.join(', ')}.` }
      }
      const { id, session } = sessionOf(args.session)
      await session.disconnect(true)
      return { output: `Debug session ${id} ended.` }
    },
  }

  const statusTool: Tool<{ path?: string }> = {
    name: 'debug_status',
    risk: 'read',
    description: 'Debug sessions and their state, and which debug adapters are available — for a file, with `path`.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Only the adapters for this file.' } } },
    summarize: () => 'debug status',

    async execute(args, context): Promise<ToolResult> {
      const engine = await registry.native(context.cwd)
      if (engine) {
        const [sessions, adapters] = await Promise.all([
          engine.sessions(),
          engine.adapters(args.path ? resolveInWorkspace(args.path, context) : undefined),
        ]).catch(engineError)
        const running = sessions.map((s) => {
          const program = s.program ? `  ${shownPath(s.program, context.cwd)}` : ''
          const stderr = s.stderr.at(-1)
          return `  ${s.id}  ${s.adapter}  ${s.status}${program}${stderr ? `\n    stderr: ${stderr.slice(0, 200)}` : ''}`
        })
        const listed = adapters.map((a) => {
          const install = a.status === 'installable' && a.install ? `  — installs on first use: ${a.install}` : ''
          return `  ${a.id.padEnd(12)} ${a.status.padEnd(11)} ${a.extensions.join(' ')}${install}`
        })
        return {
          output: [
            sessions.length > 0 ? `Sessions:\n${running.join('\n')}` : 'No debug session.',
            '',
            'Adapters:',
            ...(listed.length > 0 ? listed : ['  (none for this file)']),
          ].join('\n'),
        }
      }
      const sessions = registry.list()
      const adapters = await availableAdapters()
      return {
        output: [
          sessions.length > 0 ? `Sessions:\n${sessions.map((s) => `  ${s.id}  ${s.running ? 'running' : 'ended'}`).join('\n')}` : 'No debug session.',
          '',
          'Adapters:',
          ...adapters.map((a) => `  ${a.spec.id.padEnd(12)} ${a.installed ? 'installed' : 'missing'}`),
        ].join('\n'),
      }
    },
  }

  return [startTool, breakpointTool, controlTool, inspectTool, outputTool, stopTool, statusTool] as Tool[]
}
