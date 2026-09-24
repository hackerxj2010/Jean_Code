import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/**
 * Persistent language kernels (architecture §8.4).
 *
 * The agent sends code, gets results, and state persists across calls — a
 * variable defined in one call is available in the next. That is the whole
 * value: exploring data means dozens of small steps, and re-running the setup
 * for each one is both slow and, when the setup has side effects, wrong.
 *
 * Communication is newline-delimited JSON over stdio, with a sentinel marking
 * the end of each result. A sentinel is necessary because user code writes to
 * stdout too, and there is otherwise no way to tell where its output stops.
 */

export type KernelLanguage = 'python' | 'javascript'

export interface ExecuteResult {
  /** Everything the code printed. */
  stdout: string
  stderr: string
  /** The last expression's value, when there is one. */
  value?: string
  error?: string
  /** Wall-clock time for this execution. */
  durationMs: number
  timedOut: boolean
}

export interface KernelOptions {
  language: KernelLanguage
  cwd: string
  /** Per-execution timeout. */
  timeoutMs?: number
  /** Handles a loopback call from inside the kernel. */
  onToolCall?: (tool: string, args: unknown) => Promise<unknown>
  onError?: (message: string) => void
}

/** Marks the end of one execution's output, so user prints are unambiguous. */
const SENTINEL = '__JEAN_KERNEL_DONE__'

export class Kernel {
  readonly language: KernelLanguage

  private readonly options: KernelOptions
  private process?: ChildProcess
  private starting?: Promise<boolean>
  private ready = false
  private disposed = false

  /** Only one execution at a time: the kernel has a single interpreter. */
  private queue: Promise<unknown> = Promise.resolve()
  private buffer = ''
  private pending?: {
    resolve: (result: ExecuteResult) => void
    stdout: string[]
    stderr: string[]
    startedAt: number
    timer: ReturnType<typeof setTimeout>
  }

  constructor(options: KernelOptions) {
    this.options = options
    this.language = options.language
  }

  async start(): Promise<boolean> {
    if (this.ready) return true
    this.starting ??= this.doStart()
    return this.starting
  }

  private async doStart(): Promise<boolean> {
    const runner = this.language === 'python' ? PYTHON_RUNNER : JS_RUNNER
    const command = this.language === 'python' ? pythonCommand() : 'bun'
    const args = this.language === 'python' ? ['-u', '-c', runner] : ['-e', runner]

    try {
      this.process = spawn(command, args, {
        cwd: this.options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      })
    } catch (err) {
      this.options.onError?.(`could not start the ${this.language} kernel: ${message(err)}`)
      return false
    }

    this.process.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk.toString()))
    this.process.stderr?.on('data', (chunk: Buffer) => {
      if (this.pending) this.pending.stderr.push(chunk.toString())
      else this.options.onError?.(`[${this.language}] ${chunk.toString().slice(0, 300)}`)
    })
    this.process.on('exit', (code) => {
      this.ready = false
      this.settle({ error: `the ${this.language} kernel exited with code ${code}` })
    })
    this.process.on('error', (err) => {
      this.ready = false
      this.settle({ error: err.message })
    })

    // A kernel that fails to start does so immediately; a short probe is more
    // useful than discovering it on the first real execution.
    const probe = await this.executeInternal(this.language === 'python' ? 'pass' : 'null', 10_000)
    if (probe.error) {
      this.options.onError?.(`the ${this.language} kernel failed to start: ${probe.error}`)
      this.stop()
      return false
    }

    this.ready = true
    return true
  }

  /** Runs code, queued behind anything already running. */
  async execute(code: string): Promise<ExecuteResult> {
    if (!(await this.start())) {
      return {
        stdout: '',
        stderr: '',
        error: `the ${this.language} kernel is unavailable`,
        durationMs: 0,
        timedOut: false,
      }
    }

    // Serialized through a promise chain: one interpreter, one execution.
    const run = this.queue.then(() => this.executeInternal(code, this.options.timeoutMs ?? 30_000))
    this.queue = run.catch(() => undefined)
    return run
  }

  private executeInternal(code: string, timeoutMs: number): Promise<ExecuteResult> {
    return new Promise<ExecuteResult>((resolve) => {
      const startedAt = Date.now()

      const timer = setTimeout(() => {
        // A wedged kernel cannot be interrupted from outside, so the process is
        // replaced. Losing session state is bad; hanging the agent is worse.
        this.settle({ error: `execution timed out after ${timeoutMs}ms`, timedOut: true })
        this.stop()
      }, timeoutMs)

      this.pending = { resolve, stdout: [], stderr: [], startedAt, timer }

      const stdin = this.process?.stdin
      if (!stdin || !stdin.writable) {
        this.settle({ error: 'the kernel is not accepting input' })
        return
      }

      try {
        stdin.write(`${JSON.stringify({ id: randomUUID(), code })}\n`)
      } catch (err) {
        this.settle({ error: message(err) })
      }
    })
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk

    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      // The trailing `\r` is stripped: a kernel on Windows emits CRLF, and
      // leaving it turns every captured line into one ending in a control
      // character the model then sees.
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      this.onLine(line)
    }
  }

  private onLine(line: string): void {
    if (!line.startsWith(SENTINEL)) {
      // Anything else is the user's own output.
      this.pending?.stdout.push(line)
      return
    }

    let payload: { value?: string; error?: string; call?: { tool: string; args: unknown } }
    try {
      payload = JSON.parse(line.slice(SENTINEL.length)) as typeof payload
    } catch {
      payload = {}
    }

    // A loopback call: the kernel is asking the agent to run a tool, and the
    // execution is not finished until the answer goes back.
    if (payload.call) {
      void this.handleLoopback(payload.call)
      return
    }

    this.settle({ value: payload.value, error: payload.error })
  }

  private async handleLoopback(call: { tool: string; args: unknown }): Promise<void> {
    let response: unknown
    let error: string | undefined

    if (!this.options.onToolCall) {
      error = 'tool calls from inside the kernel are not enabled for this session'
    } else {
      try {
        response = await this.options.onToolCall(call.tool, call.args)
      } catch (err) {
        error = message(err)
      }
    }

    try {
      this.process?.stdin?.write(`${JSON.stringify({ reply: response ?? null, error })}\n`)
    } catch {
      this.settle({ error: 'the kernel closed while a tool call was in flight' })
    }
  }

  private settle(outcome: { value?: string; error?: string; timedOut?: boolean }): void {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    clearTimeout(pending.timer)

    pending.resolve({
      stdout: pending.stdout.join('\n'),
      stderr: pending.stderr.join(''),
      value: outcome.value,
      error: outcome.error,
      durationMs: Date.now() - pending.startedAt,
      timedOut: outcome.timedOut ?? false,
    })
  }

  /** Discards all state by restarting the interpreter. */
  async reset(): Promise<boolean> {
    this.stop()
    this.disposed = false
    this.starting = undefined
    return this.start()
  }

  get isRunning(): boolean {
    return this.ready && !this.disposed
  }

  stop(): void {
    this.ready = false
    this.disposed = true
    this.starting = undefined

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

function pythonCommand(): string {
  // `python3` on most systems, `python` on Windows where the launcher aliases it.
  return process.platform === 'win32' ? 'python' : 'python3'
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The Python side of the kernel.
 *
 * Reads a JSON line, executes it, prints a sentinel line with the result. The
 * last expression's value is captured the way a REPL does — by compiling the
 * final statement in `eval` mode when it is an expression — because an agent
 * exploring data expects the value of what it typed.
 */
const PYTHON_RUNNER = `
import sys, json, io, ast, traceback, contextlib

SENTINEL = "${SENTINEL}"
namespace = {"__name__": "__jean__"}

class _Bridge:
    """Lets kernel code call back into the agent's tools."""
    def call(self, tool, **args):
        print(SENTINEL + json.dumps({"call": {"tool": tool, "args": args}}), flush=True)
        reply = json.loads(sys.stdin.readline())
        if reply.get("error"):
            raise RuntimeError(reply["error"])
        return reply.get("reply")

    def read(self, path):
        return self.call("read", path=path)

    def grep(self, pattern, **kwargs):
        return self.call("grep", pattern=pattern, **kwargs)

    def task(self, prompt, context=None):
        return self.call("task", prompt=prompt, context=context)

namespace["jean"] = _Bridge()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        request = json.loads(line)
    except Exception:
        continue

    code = request.get("code", "")
    value = None
    error = None
    out = io.StringIO()

    try:
        tree = ast.parse(code, mode="exec")
        # Split the trailing expression off so its value can be reported, which
        # is what makes this feel like a REPL rather than a script runner.
        body, tail = tree.body[:-1], tree.body[-1:] if tree.body else []
        with contextlib.redirect_stdout(out):
            if body:
                exec(compile(ast.Module(body=body, type_ignores=[]), "<jean>", "exec"), namespace)
            if tail:
                node = tail[0]
                if isinstance(node, ast.Expr):
                    result = eval(compile(ast.Expression(node.value), "<jean>", "eval"), namespace)
                    if result is not None:
                        value = repr(result)
                else:
                    exec(compile(ast.Module(body=tail, type_ignores=[]), "<jean>", "exec"), namespace)
    except Exception:
        error = traceback.format_exc(limit=5)

    printed = out.getvalue()
    if printed:
        for printed_line in printed.rstrip("\\n").split("\\n"):
            print(printed_line, flush=True)

    print(SENTINEL + json.dumps({"value": value, "error": error}), flush=True)
`

/**
 * The JavaScript side of the kernel.
 *
 * Same contract as the Python runner. Uses an async function wrapper so
 * top-level `await` works, which is what anyone exploring an API expects.
 */
const JS_RUNNER = `
const SENTINEL = "${SENTINEL}"
const context = {}

globalThis.jean = {
  async call(tool, args) {
    process.stdout.write(SENTINEL + JSON.stringify({ call: { tool, args } }) + "\\n")
    const reply = await new Promise((resolve) => {
      const onLine = (chunk) => {
        process.stdin.off("data", onLine)
        resolve(JSON.parse(chunk.toString().trim()))
      }
      process.stdin.on("data", onLine)
    })
    if (reply.error) throw new Error(reply.error)
    return reply.reply
  },
  read(path) { return this.call("read", { path }) },
  grep(pattern, options) { return this.call("grep", { pattern, ...options }) },
  task(prompt, ctx) { return this.call("task", { prompt, context: ctx }) },
}

let buffer = ""
process.stdin.on("data", async (chunk) => {
  buffer += chunk.toString()
  let newline = buffer.indexOf("\\n")

  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf("\\n")
    if (!line) continue

    let request
    try { request = JSON.parse(line) } catch { continue }
    if (request.reply !== undefined || request.error !== undefined) continue

    let value
    let error
    const printed = []
    const originalLog = console.log

    console.log = (...args) => {
      printed.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
    }

    // Which form the code takes is decided by *compiling* the expression
    // version, not by running it and catching the failure. Retrying would run
    // side effects twice, and a SyntaxError from the compile step would
    // otherwise be reported as the user's error.
    let compiled = null
    try {
      compiled = new Function("context", "return (async () => { with (context) { return (" + request.code + ") } })()")
    } catch {
      compiled = null
    }

    try {
      if (!compiled) {
        compiled = new Function("context", "return (async () => { with (context) { " + request.code + " } })()")
      }
      const result = await compiled(context)
      if (result !== undefined) value = typeof result === "string" ? result : JSON.stringify(result)
    } catch (err) {
      error = err && err.stack ? err.stack.split("\\n").slice(0, 5).join("\\n") : String(err)
    } finally {
      console.log = originalLog
    }

    for (const output of printed) process.stdout.write(output + "\\n")
    process.stdout.write(SENTINEL + JSON.stringify({ value, error }) + "\\n")
  }
})
`
