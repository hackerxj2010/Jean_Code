import { spawn } from 'node:child_process'
import { defaultShell } from '@jean/tools'
import { claudeInput, claudeName, namesOf } from './names.ts'

/**
 * Hooks — shell commands the harness runs at fixed points in a session.
 *
 * The protocol is Claude Code's, deliberately: a hook written for it runs here
 * unchanged. The hook receives a JSON object on stdin and answers through its
 * exit code and, optionally, JSON on stdout:
 *
 * * exit 0 — fine. For `UserPromptSubmit` and `SessionStart`, plain stdout is
 *   added to the model's context.
 * * exit 2 — block. stderr is the reason, and it goes to the model (or, for a
 *   blocked prompt, to the user).
 * * anything else — a hook error. Reported, never fatal: a broken formatter
 *   hook must not stop the agent that triggered it.
 *
 * JSON stdout refines that: `decision: "block"`, `permissionDecision`,
 * `updatedInput`, `additionalContext`, `continue: false`.
 */

export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
  'Notification',
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

export interface HookCommand {
  type: 'command'
  command: string
  /** Seconds. Default 60. */
  timeout?: number
}

export interface HookMatcher {
  /** Regex over the tool name (tool events) or the event's subtype. Empty matches all. */
  matcher?: string
  hooks: HookCommand[]
}

export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>

/** A hook with the file it came from, for `jean doctor` and error messages. */
export interface SourcedHook extends HookCommand {
  matcher?: string
  source: string
}

export interface HookOutcome {
  /** Exit 2, or JSON `decision: "block"` / `permissionDecision: "deny"`. */
  blocked: boolean
  /** Why, for the model or the user. */
  reason?: string
  /** PreToolUse's verdict on permissions, when a hook gave one. */
  permission?: 'allow' | 'deny' | 'ask'
  /** Replacement tool arguments from a PreToolUse hook. */
  updatedInput?: Record<string, unknown>
  /** Text to add to the model's context. */
  context: string[]
  /** `continue: false` — end the run entirely. */
  halt?: { reason?: string }
  /** Messages for the user rather than the model. */
  messages: string[]
  /** Hooks that failed, for display. Never fatal. */
  errors: string[]
}

export interface RunnerOptions {
  hooks: Partial<Record<HookEvent, SourcedHook[]>>
  cwd: string
  sessionId: string
  /** Path of the session transcript, which hooks may read. */
  transcriptPath?: () => string | undefined
  permissionMode?: () => string
  shell?: { path: string; args: string[] }
}

const DEFAULT_TIMEOUT_S = 60

export class HookRunner {
  constructor(private readonly options: RunnerOptions) {}

  /** True when anything is registered for the event, so callers can skip work. */
  has(event: HookEvent): boolean {
    return (this.options.hooks[event]?.length ?? 0) > 0
  }

  /** Every configured hook, for `jean doctor`. */
  list(): { event: HookEvent; hook: SourcedHook }[] {
    return HOOK_EVENTS.flatMap((event) =>
      (this.options.hooks[event] ?? []).map((hook) => ({ event, hook })),
    )
  }

  /**
   * Runs every hook registered for `event` whose matcher accepts `subject`.
   *
   * Matching hooks run in parallel and their outcomes merge: any block blocks,
   * the strictest permission verdict wins, and context accumulates.
   */
  async run(
    event: HookEvent,
    payload: Record<string, unknown>,
    subject?: string,
  ): Promise<HookOutcome> {
    const outcome: HookOutcome = { blocked: false, context: [], messages: [], errors: [] }
    const candidates = (this.options.hooks[event] ?? []).filter((hook) =>
      matches(hook.matcher, subject),
    )
    // The same command registered twice (a project and a user file both
    // naming a formatter) runs once.
    const unique = [...new Map(candidates.map((h) => [h.command, h])).values()]
    if (unique.length === 0) return outcome

    const input = JSON.stringify({
      session_id: this.options.sessionId,
      transcript_path: this.options.transcriptPath?.() ?? '',
      cwd: this.options.cwd,
      hook_event_name: event,
      permission_mode: this.options.permissionMode?.() ?? 'auto',
      ...payload,
    })

    const results = await Promise.all(unique.map((hook) => this.exec(hook, input)))
    for (const [i, result] of results.entries()) {
      merge(outcome, interpret(event, result, unique[i]!))
    }
    return outcome
  }

  /** PreToolUse, with Jean's tool described the way Claude Code hooks expect. */
  preToolUse(tool: string, input: unknown): Promise<HookOutcome> {
    return this.run(
      'PreToolUse',
      { tool_name: claudeName(tool), jean_tool_name: tool, tool_input: claudeInput(tool, input, this.options.cwd) },
      tool,
    )
  }

  postToolUse(tool: string, input: unknown, output: string, isError: boolean): Promise<HookOutcome> {
    return this.run(
      'PostToolUse',
      {
        tool_name: claudeName(tool),
        jean_tool_name: tool,
        tool_input: claudeInput(tool, input, this.options.cwd),
        tool_response: { output, is_error: isError, success: !isError },
      },
      tool,
    )
  }

  private exec(hook: SourcedHook, input: string): Promise<ExecResult> {
    const shell = this.options.shell ?? defaultShell()
    const timeoutMs = (hook.timeout ?? DEFAULT_TIMEOUT_S) * 1000

    return new Promise((resolvePromise) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const done = (result: ExecResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise(result)
      }

      let child: ReturnType<typeof spawn>
      try {
        child = spawn(shell.path, [...shell.args, hook.command], {
          cwd: this.options.cwd,
          env: {
            ...process.env,
            JEAN_PROJECT_DIR: this.options.cwd,
            // Hooks written for Claude Code locate the project through this.
            CLAUDE_PROJECT_DIR: this.options.cwd,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (err) {
        done({ code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) })
        return
      }

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        done({ code: 1, stdout, stderr: `${stderr}\n[hook timed out after ${timeoutMs / 1000}s]` })
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', (err) => done({ code: 1, stdout, stderr: `${stderr}${err.message}` }))
      child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }))

      // A hook that ignores stdin closes it early; the EPIPE is not an error.
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(input)
    })
  }
}

interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

function matches(matcher: string | undefined, subject: string | undefined): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true
  if (subject === undefined) return true
  const names = namesOf(subject)
  try {
    const pattern = new RegExp(`^(?:${matcher})$`)
    return names.some((name) => pattern.test(name))
  } catch {
    // An invalid regex is most likely a plain name with a stray character.
    return names.includes(matcher)
  }
}

/** Turns one hook's exit code and output into an outcome. */
function interpret(event: HookEvent, result: ExecResult, hook: SourcedHook): HookOutcome {
  const outcome: HookOutcome = { blocked: false, context: [], messages: [], errors: [] }
  const stdout = result.stdout.trim()
  const stderr = result.stderr.trim()

  if (result.code === 2) {
    outcome.blocked = true
    outcome.reason = stderr || `Blocked by a ${event} hook (${hook.source}).`
    return outcome
  }
  if (result.code !== 0) {
    outcome.errors.push(
      `${event} hook \`${clip(hook.command)}\` (${hook.source}) exited ${result.code}${stderr ? `: ${clip(stderr)}` : ''}`,
    )
    return outcome
  }

  const json = parseJson(stdout)
  if (!json) {
    // Plain stdout is context for the two events that inject it.
    if (stdout && (event === 'UserPromptSubmit' || event === 'SessionStart')) {
      outcome.context.push(stdout)
    }
    return outcome
  }

  if (json.continue === false) {
    outcome.halt = { reason: typeof json.stopReason === 'string' ? json.stopReason : undefined }
  }
  if (typeof json.systemMessage === 'string') outcome.messages.push(json.systemMessage)

  const reason = typeof json.reason === 'string' ? json.reason : undefined
  if (json.decision === 'block') {
    outcome.blocked = true
    outcome.reason = reason ?? `Blocked by a ${event} hook (${hook.source}).`
  } else if (json.decision === 'approve') {
    outcome.permission = 'allow'
  }

  const specific = json.hookSpecificOutput
  if (specific && typeof specific === 'object') {
    const s = specific as Record<string, unknown>
    const decision = s.permissionDecision
    if (decision === 'allow' || decision === 'deny' || decision === 'ask') {
      outcome.permission = decision
      const why = s.permissionDecisionReason
      if (typeof why === 'string') outcome.reason = why
      if (decision === 'deny') {
        outcome.blocked = true
        outcome.reason ??= `Denied by a PreToolUse hook (${hook.source}).`
      }
    }
    if (s.updatedInput && typeof s.updatedInput === 'object' && !Array.isArray(s.updatedInput)) {
      outcome.updatedInput = s.updatedInput as Record<string, unknown>
    }
    if (typeof s.additionalContext === 'string' && s.additionalContext.trim()) {
      outcome.context.push(s.additionalContext.trim())
    }
  }
  return outcome
}

/** Folds one hook's outcome into the running total. */
function merge(into: HookOutcome, from: HookOutcome): void {
  if (from.blocked && !into.blocked) {
    into.blocked = true
    into.reason = from.reason
  } else if (from.blocked && from.reason) {
    into.reason = `${into.reason ?? ''}\n${from.reason}`.trim()
  }
  // Strictest verdict wins: deny over ask over allow.
  const rank = { deny: 3, ask: 2, allow: 1 } as const
  if (from.permission && (!into.permission || rank[from.permission] > rank[into.permission])) {
    into.permission = from.permission
    if (!into.blocked && from.reason) into.reason = from.reason
  }
  if (from.updatedInput) into.updatedInput = { ...into.updatedInput, ...from.updatedInput }
  if (from.halt) into.halt = from.halt
  into.context.push(...from.context)
  into.messages.push(...from.messages)
  into.errors.push(...from.errors)
}

function parseJson(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith('{')) return undefined
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

function clip(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 117)}...` : line
}
