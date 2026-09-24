import { spawn, type ChildProcess } from 'node:child_process'
import { Connection, DapError } from './protocol.ts'
import type { AdapterSpec } from './adapters.ts'

/**
 * A debug session — the 28 operations of architecture §8.3.
 *
 * The value of a debugger to an agent is not stepping for its own sake; it is
 * that a stack trace with live variable values answers "why is this wrong" in
 * one shot, where reading code and adding print statements takes many turns and
 * often reaches the wrong conclusion.
 */

export interface Breakpoint {
  id?: number
  verified: boolean
  line: number
  path: string
  message?: string
}

export interface StackFrame {
  id: number
  name: string
  path?: string
  line: number
  column: number
}

export interface Scope {
  name: string
  variablesReference: number
  expensive: boolean
}

export interface Variable {
  name: string
  value: string
  type?: string
  /** Non-zero when the value can be expanded into children. */
  variablesReference: number
}

export interface Thread {
  id: number
  name: string
}

export interface StoppedState {
  reason: string
  threadId?: number
  description?: string
  text?: string
}

export interface SessionOptions {
  spec: AdapterSpec
  cwd: string
  /** Program to launch, or connection details when attaching. */
  launchArgs?: Record<string, unknown>
  onOutput?: (category: string, text: string) => void
  onStopped?: (state: StoppedState) => void
  onTerminated?: () => void
  onError?: (message: string) => void
}

export class DebugSession {
  readonly id: string

  private readonly options: SessionOptions
  private process?: ChildProcess
  private connection?: Connection
  private capabilities: Record<string, unknown> = {}

  private initialized = false
  private configured = false
  private terminated = false

  /** Breakpoints by path, so they can be re-sent as a set — DAP replaces per file. */
  private readonly breakpoints = new Map<string, number[]>()
  private readonly functionBreakpoints = new Set<string>()
  private lastStopped?: StoppedState
  /** Resolves when the adapter reports it is ready for configuration. */
  private initializedSignal?: () => void

  constructor(options: SessionOptions) {
    this.options = options
    this.id = `${options.spec.id}:${Date.now()}`
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Spawns the adapter and completes the initialize handshake. */
  async start(): Promise<boolean> {
    const [command, ...args] = this.options.spec.command
    try {
      this.process = spawn(command!, args, {
        cwd: this.options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      })
    } catch (err) {
      this.fail(`could not start ${this.options.spec.id}: ${message(err)}`)
      return false
    }

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) this.options.onError?.(`[${this.options.spec.id}] ${text.slice(0, 500)}`)
    })

    this.connection = new Connection(this.process)
    this.connection.onEvent((event, body) => this.onEvent(event, body))

    // Adapters ask the client to start the debuggee in a terminal. Declining
    // is correct here: the agent's shell tool is where processes belong, and
    // an adapter-spawned terminal would be invisible to it.
    this.connection.onReverseRequest('runInTerminal', () => ({ processId: process.pid }))

    try {
      const result = (await this.connection.request('initialize', {
        clientID: 'jean-code',
        clientName: 'Jean Code',
        adapterID: this.options.spec.id,
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
        supportsVariablePaging: false,
        supportsRunInTerminalRequest: true,
        supportsProgressReporting: false,
      })) as Record<string, unknown>

      this.capabilities = result ?? {}
      this.initialized = true
      return true
    } catch (err) {
      this.fail(`${this.options.spec.id} failed to initialize: ${message(err)}`)
      return false
    }
  }

  /** 14 — `launch`: starts the debuggee under the adapter. */
  async launch(args: Record<string, unknown> = {}): Promise<boolean> {
    if (!this.initialized && !(await this.start())) return false

    // The adapter signals readiness with an `initialized` event, and breakpoints
    // set before that arrives are silently dropped by most adapters.
    const ready = this.waitForInitialized()

    try {
      await this.connection!.request('launch', {
        ...this.options.spec.defaults,
        ...this.options.launchArgs,
        ...args,
        cwd: this.options.cwd,
      }, 30_000)
    } catch (err) {
      this.fail(`launch failed: ${message(err)}`)
      return false
    }

    await ready
    return true
  }

  /** 15 — `attach`: connects to an already-running process. */
  async attach(args: Record<string, unknown> = {}): Promise<boolean> {
    if (!this.initialized && !(await this.start())) return false

    const ready = this.waitForInitialized()
    try {
      await this.connection!.request('attach', { ...this.options.launchArgs, ...args }, 30_000)
    } catch (err) {
      this.fail(`attach failed: ${message(err)}`)
      return false
    }

    await ready
    return true
  }

  private waitForInitialized(): Promise<void> {
    return new Promise((resolve) => {
      // Resolve anyway after a beat: some adapters never send the event, and
      // waiting forever for it would wedge the session.
      const timer = setTimeout(resolve, 3000)
      this.initializedSignal = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  /** 13 — `configurationDone`: tells the adapter breakpoints are set. */
  async configurationDone(): Promise<void> {
    if (this.configured) return
    this.configured = true
    if (this.capabilities.supportsConfigurationDoneRequest === false) return
    await this.request('configurationDone', {})
  }

  /** 16 — `disconnect`: ends the session, optionally killing the debuggee. */
  async disconnect(terminateDebuggee = true): Promise<void> {
    if (this.terminated) return
    this.terminated = true
    try {
      await this.connection?.request('disconnect', { terminateDebuggee }, 5000)
    } catch {
      // A disconnect that fails still means the session is over.
    }
    this.stop()
  }

  /** 17 — `restart`. */
  async restart(): Promise<void> {
    if (this.capabilities.supportsRestartRequest) {
      await this.request('restart', {})
      return
    }
    // Fall back to a disconnect/launch cycle when the adapter cannot restart.
    await this.disconnect(true)
    this.terminated = false
    await this.start()
    await this.launch()
  }

  /** 18 — `terminate`: asks the debuggee to exit gracefully. */
  async terminate(): Promise<void> {
    if (this.capabilities.supportsTerminateRequest) {
      await this.request('terminate', {})
      return
    }
    await this.disconnect(true)
  }

  // ---- breakpoints ---------------------------------------------------------

  /**
   * 1 — `setBreakpoint`.
   *
   * DAP replaces the whole set for a file on every call, so the session tracks
   * what is set and re-sends the full list. Sending only the new one would
   * silently clear every other breakpoint in that file.
   */
  async setBreakpoint(path: string, line: number): Promise<Breakpoint[]> {
    const lines = this.breakpoints.get(path) ?? []
    if (!lines.includes(line)) lines.push(line)
    this.breakpoints.set(path, lines)
    return this.sendBreakpoints(path)
  }

  /** 2 — `clearBreakpoint`. */
  async clearBreakpoint(path: string, line: number): Promise<Breakpoint[]> {
    const lines = (this.breakpoints.get(path) ?? []).filter((l) => l !== line)
    this.breakpoints.set(path, lines)
    return this.sendBreakpoints(path)
  }

  /** Clears every breakpoint in a file. */
  async clearFile(path: string): Promise<void> {
    this.breakpoints.set(path, [])
    await this.sendBreakpoints(path)
  }

  private async sendBreakpoints(path: string): Promise<Breakpoint[]> {
    const lines = this.breakpoints.get(path) ?? []
    const body = (await this.request('setBreakpoints', {
      source: { path },
      breakpoints: lines.map((line) => ({ line })),
      lines,
    })) as { breakpoints?: { id?: number; verified: boolean; line?: number; message?: string }[] }

    return (body?.breakpoints ?? []).map((bp, index) => ({
      id: bp.id,
      verified: bp.verified,
      line: bp.line ?? lines[index] ?? 0,
      path,
      message: bp.message,
    }))
  }

  /** 19 — `breakpoints`: everything currently set. */
  allBreakpoints(): { path: string; lines: number[] }[] {
    return [...this.breakpoints.entries()]
      .filter(([, lines]) => lines.length > 0)
      .map(([path, lines]) => ({ path, lines: [...lines] }))
  }

  /** 25 — `setExceptionBreakpoints`. */
  async setExceptionBreakpoints(filters: string[]): Promise<void> {
    await this.request('setExceptionBreakpoints', { filters })
  }

  /** 26 — `setFunctionBreakpoints`: break on a name rather than a line. */
  async setFunctionBreakpoints(names: string[]): Promise<Breakpoint[]> {
    this.functionBreakpoints.clear()
    for (const name of names) this.functionBreakpoints.add(name)

    const body = (await this.request('setFunctionBreakpoints', {
      breakpoints: names.map((name) => ({ name })),
    })) as { breakpoints?: { id?: number; verified: boolean; line?: number }[] }

    return (body?.breakpoints ?? []).map((bp, index) => ({
      id: bp.id,
      verified: bp.verified,
      line: bp.line ?? 0,
      path: names[index] ?? '',
    }))
  }

  // ---- execution control ---------------------------------------------------

  /** 3 — `continue`. */
  async continue(threadId?: number): Promise<void> {
    await this.request('continue', { threadId: threadId ?? this.lastStopped?.threadId ?? 1 })
  }

  /** 4 — `next`: step over. */
  async next(threadId?: number): Promise<void> {
    await this.request('next', { threadId: threadId ?? this.lastStopped?.threadId ?? 1 })
  }

  /** 5 — `stepIn`. */
  async stepIn(threadId?: number): Promise<void> {
    await this.request('stepIn', { threadId: threadId ?? this.lastStopped?.threadId ?? 1 })
  }

  /** 6 — `stepOut`. */
  async stepOut(threadId?: number): Promise<void> {
    await this.request('stepOut', { threadId: threadId ?? this.lastStopped?.threadId ?? 1 })
  }

  /** 7 — `pause`. */
  async pause(threadId?: number): Promise<void> {
    await this.request('pause', { threadId: threadId ?? 1 })
  }

  // ---- inspection ----------------------------------------------------------

  /** 8 — `stackTrace`. */
  async stackTrace(threadId?: number, levels = 20): Promise<StackFrame[]> {
    const body = (await this.request('stackTrace', {
      threadId: threadId ?? this.lastStopped?.threadId ?? 1,
      startFrame: 0,
      levels,
    })) as {
      stackFrames?: {
        id: number
        name: string
        line: number
        column: number
        source?: { path?: string }
      }[]
    }

    return (body?.stackFrames ?? []).map((frame) => ({
      id: frame.id,
      name: frame.name,
      path: frame.source?.path,
      line: frame.line,
      column: frame.column,
    }))
  }

  /** 9 — `scopes`: variable scopes for a frame. */
  async scopes(frameId: number): Promise<Scope[]> {
    const body = (await this.request('scopes', { frameId })) as {
      scopes?: { name: string; variablesReference: number; expensive?: boolean }[]
    }

    return (body?.scopes ?? []).map((scope) => ({
      name: scope.name,
      variablesReference: scope.variablesReference,
      expensive: scope.expensive ?? false,
    }))
  }

  /** 10 — `variables`: the contents of a scope or an expandable value. */
  async variables(variablesReference: number): Promise<Variable[]> {
    const body = (await this.request('variables', { variablesReference })) as {
      variables?: { name: string; value: string; type?: string; variablesReference?: number }[]
    }

    return (body?.variables ?? []).map((variable) => ({
      name: variable.name,
      value: variable.value,
      type: variable.type,
      variablesReference: variable.variablesReference ?? 0,
    }))
  }

  /** 11 — `evaluate`: run an expression in a frame's context. */
  async evaluate(
    expression: string,
    frameId?: number,
    context: 'watch' | 'repl' | 'hover' = 'repl',
  ): Promise<{ result: string; type?: string; variablesReference: number }> {
    const body = (await this.request('evaluate', { expression, frameId, context })) as {
      result: string
      type?: string
      variablesReference?: number
    }

    return {
      result: body?.result ?? '',
      type: body?.type,
      variablesReference: body?.variablesReference ?? 0,
    }
  }

  /** 12 — `threads`. */
  async threads(): Promise<Thread[]> {
    const body = (await this.request('threads', {})) as {
      threads?: { id: number; name: string }[]
    }
    return body?.threads ?? []
  }

  /** 20 — `modules`: loaded modules and their symbol status. */
  async modules(): Promise<{ id: string | number; name: string; path?: string }[]> {
    if (!this.capabilities.supportsModulesRequest) return []
    const body = (await this.request('modules', {})) as {
      modules?: { id: string | number; name: string; path?: string }[]
    }
    return body?.modules ?? []
  }

  /** 21 — `loadedSources`. */
  async loadedSources(): Promise<{ name: string; path?: string }[]> {
    if (!this.capabilities.supportsLoadedSourcesRequest) return []
    const body = (await this.request('loadedSources', {})) as {
      sources?: { name: string; path?: string }[]
    }
    return body?.sources ?? []
  }

  /** 22 — `completions`: REPL completions inside a frame. */
  async completions(text: string, column: number, frameId?: number): Promise<string[]> {
    if (!this.capabilities.supportsCompletionsRequest) return []
    const body = (await this.request('completions', { text, column, frameId })) as {
      targets?: { label: string }[]
    }
    return (body?.targets ?? []).map((target) => target.label)
  }

  /** 23 — `exceptionInfo`: details of the exception that stopped execution. */
  async exceptionInfo(threadId?: number): Promise<
    { exceptionId: string; description?: string; details?: string } | undefined
  > {
    if (!this.capabilities.supportsExceptionInfoRequest) return undefined
    const body = (await this.request('exceptionInfo', {
      threadId: threadId ?? this.lastStopped?.threadId ?? 1,
    })) as {
      exceptionId?: string
      description?: string
      details?: { stackTrace?: string }
    }

    if (!body?.exceptionId) return undefined
    return {
      exceptionId: body.exceptionId,
      description: body.description,
      details: body.details?.stackTrace,
    }
  }

  /** 24 — `cancel`: abandons an in-flight request. */
  async cancel(requestId?: number): Promise<void> {
    if (!this.capabilities.supportsCancelRequest) return
    await this.request('cancel', { requestId })
  }

  /** 27 — `setData`: writes a variable's value. */
  async setData(variablesReference: number, name: string, value: string): Promise<string> {
    const body = (await this.request('setVariable', {
      variablesReference,
      name,
      value,
    })) as { value?: string }
    return body?.value ?? value
  }

  /** 28 — `readData`: reads raw memory, where the adapter supports it. */
  async readData(memoryReference: string, count: number, offset = 0): Promise<string | undefined> {
    if (!this.capabilities.supportsReadMemoryRequest) return undefined
    const body = (await this.request('readMemory', {
      memoryReference,
      offset,
      count,
    })) as { data?: string }
    return body?.data
  }

  /** Sends an arbitrary DAP request, for adapter-specific commands. */
  async rawRequest(command: string, args?: unknown): Promise<unknown> {
    return this.request(command, args)
  }

  // ---- state ---------------------------------------------------------------

  /** Where execution currently sits, if it is stopped. */
  stoppedAt(): StoppedState | undefined {
    return this.lastStopped
  }

  supports(capability: string): boolean {
    return Boolean(this.capabilities[capability])
  }

  get isRunning(): boolean {
    return this.initialized && !this.terminated
  }

  private async request(command: string, args: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.connection || this.terminated) {
      throw new DapError('the debug session is not running', command)
    }
    return this.connection.request(command, args, timeoutMs)
  }

  private onEvent(event: string, body: unknown): void {
    switch (event) {
      case 'initialized':
        this.initializedSignal?.()
        this.initializedSignal = undefined
        break

      case 'stopped': {
        const payload = body as StoppedState
        this.lastStopped = payload
        this.options.onStopped?.(payload)
        break
      }

      case 'continued':
        this.lastStopped = undefined
        break

      case 'output': {
        const payload = body as { category?: string; output?: string }
        if (payload?.output) {
          this.options.onOutput?.(payload.category ?? 'console', payload.output)
        }
        break
      }

      case 'terminated':
      case 'exited':
        this.terminated = true
        this.options.onTerminated?.()
        break

      default:
        break
    }
  }

  private fail(text: string): void {
    this.options.onError?.(text)
    this.stop()
  }

  /** Kills the adapter. */
  stop(): void {
    this.terminated = true
    this.connection?.shutdown('session stopped')
    this.connection = undefined

    const child = this.process
    this.process = undefined
    if (!child || child.killed) return
    child.kill()
    const timer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL')
    }, 2000)
    timer.unref?.()
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
