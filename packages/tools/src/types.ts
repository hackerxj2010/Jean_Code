import type { JeanConfig, PermissionMode } from '@jean/config'
import type { ToolSchema } from '@jean/model'

/**
 * Tool harness types.
 *
 * A tool is a named, schema-described function the agent can call. Everything
 * the agent can do to the world goes through one — which is what makes
 * permission gating and audit a single choke point rather than a policy
 * scattered across the codebase.
 */

/** How dangerous a call is. Drives permission gating, not display. */
export type Risk =
  /** Reads only. Never gated. */
  | 'read'
  /** Modifies the workspace. Gated in `ask` mode, blocked in `plan` mode. */
  | 'write'
  /** Runs arbitrary code. Gated in `ask` mode, blocked in `plan` mode. */
  | 'execute'
  /** Leaves the machine. Gated in `ask` mode. */
  | 'network'

export interface ToolContext {
  /** Project root. All relative paths resolve against this. */
  cwd: string
  config: JeanConfig
  /** Cancels in-flight work when the user interrupts. */
  signal?: AbortSignal
  /**
   * Asks the user to approve a gated call. Returns false to deny.
   * Absent in non-interactive runs, where gating falls back to the mode's
   * default answer.
   */
  confirm?: (request: ConfirmRequest) => Promise<boolean>
  /** Progress for long-running tools, surfaced in the TUI. */
  onProgress?: (message: string) => void
  /**
   * The id of the call being run — what a tool that reports work of its own
   * (`spawn`) files that work under, so the interface can show it inside the
   * right call.
   */
  callId?: string
  /** Per-session scratch shared across tool calls (shell cwd, env, job table). */
  session: SessionState
  /**
   * Rule-based permissions — `Bash(npm test:*)`, `Read(./.env)`. Consulted by
   * the registry before the permission mode, so a deny rule holds in every
   * mode. Absent means the mode alone decides.
   */
  policy?: ToolPolicy
}

/** A permission rule's verdict on one call. */
export interface PolicyVerdict {
  decision: 'allow' | 'deny' | 'ask'
  /** The rule that decided, as written — shown to the model and the user. */
  rule: string
}

/** What the registry learned about a call before the rules see it. */
export interface CallFacts {
  /**
   * For `bash`: each simple command the line would run, as the shell parser
   * sees it — quotes removed, command substitutions listed separately.
   */
  commands?: string[]
}

export interface ToolPolicy {
  evaluate(tool: string, args: unknown, context: ToolContext, facts?: CallFacts): PolicyVerdict | undefined
}

/** Per-call overrides from hooks, which run before the registry. */
export interface CallOptions {
  /** A hook approved this call: skip the confirmation the mode would ask for. */
  approve?: boolean
  /** A hook wants the user asked, with this reason, whatever the mode says. */
  ask?: string
}

export interface ConfirmRequest {
  tool: string
  risk: Risk
  /** One-line summary shown to the user. */
  summary: string
  /** The exact command or diff, shown in full. */
  detail?: string
}

/** Mutable state that survives across tool calls within one session. */
export interface SessionState {
  /** Shell working directory. `cd` in one call persists to the next. */
  shellCwd: string
  /** Environment exported by previous shell calls. */
  shellEnv: Record<string, string>
  /** Files the agent has read, so `edit` can require a prior read. */
  readFiles: Set<string>
  /** Background jobs started by `bash`, keyed by id. */
  jobs: Map<string, BackgroundJob>
  /** The task list, owned by the `todo` tool. */
  todos: Todo[]
  /**
   * The embedded `pi-shell` session, when commands run there because no
   * system shell is available (or the config asks for it).
   */
  nativeShell?: string
}

export interface BackgroundJob {
  id: string
  command: string
  startedAt: number
  output: string[]
  exitCode?: number
  done: boolean
  kill: () => void
  /**
   * Writes to the process's stdin.
   *
   * Without this, a command that stops to ask something — a migration
   * confirming a destructive change, `npm login`, a REPL — is unanswerable. The
   * agent sees the prompt in the output, has the answer, and has no way to
   * deliver it, so the only move left is killing the job.
   *
   * Returns false when the process has exited or closed its input.
   */
  write: (input: string) => boolean
  /** How much of `output` the agent has already been shown. */
  readOffset: number
}

export interface Todo {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** What a tool returns. */
export interface ToolResult {
  /** Text shown to the model. Keep it dense: this is context budget. */
  output: string
  /** True when the call failed. The agent sees the output either way. */
  isError?: boolean
  /** Structured payload for the TUI (diffs, file lists, match counts). */
  display?: unknown
  /** Files this call created, modified, or deleted. Drives the diff view. */
  touched?: string[]
}

export interface Tool<Args = any> {
  name: string
  /** Shown to the model. This is prompt text — write it for a reader. */
  description: string
  parameters: ToolSchema['parameters']
  risk: Risk
  /**
   * One-line summary of a pending call, used in the confirmation prompt and
   * the TUI card. Receives the parsed arguments.
   */
  summarize?: (args: Args, context: ToolContext) => string
  execute: (args: Args, context: ToolContext) => Promise<ToolResult>
  /** Hide from the model in these permission modes. */
  hiddenIn?: PermissionMode[]
  /**
   * Whether calls may run alongside other calls from the same model turn.
   *
   * Defaults from `risk`: reads are parallel, everything else serial. A read
   * tool that drives shared state — one browser page, one debug session, the
   * user's attention — sets `serial` explicitly; a mutating tool whose effects
   * are isolated (a sub-agent in its own worktree) may set `parallel`.
   */
  concurrency?: 'parallel' | 'serial'
}

/** True when a tool's calls may run concurrently with other calls. */
export function runsInParallel(tool: Pick<Tool, 'risk' | 'concurrency'>): boolean {
  return (tool.concurrency ?? (tool.risk === 'read' ? 'parallel' : 'serial')) === 'parallel'
}

/** Raised by a tool when its arguments are unusable. */
export class ToolError extends Error {
  constructor(
    message: string,
    /** A concrete next step, appended to the message the model sees. */
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'ToolError'
  }
}

/** Creates the mutable per-session state a `ToolContext` needs. */
export function createSessionState(cwd: string): SessionState {
  return {
    shellCwd: cwd,
    shellEnv: {},
    readFiles: new Set(),
    jobs: new Map(),
    todos: [],
  }
}
