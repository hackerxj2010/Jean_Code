/**
 * `@jean/evals` — the evaluation harness (architecture §6.25).
 *
 * The problem this solves: every change to a prompt, a tool description, or a
 * model is a guess until it is measured, and an agent's behaviour is too varied
 * to judge from a handful of manual runs. A prompt tweak that feels better and
 * makes the agent worse is the normal outcome, not the unusual one.
 *
 * What makes an agent eval different from a unit test is that the *output* is
 * not fixed. Two correct solutions to "add a health check endpoint" share no
 * text. So a case asserts on the world after the run — files, exit codes, tests
 * passing — rather than on what the agent said.
 */

export interface EvalCase {
  id: string
  /** What the agent is asked to do. */
  prompt: string
  /** Files laid down before the run. */
  setup?: Record<string, string>
  /**
   * Shell commands run before the agent starts.
   *
   * For anything that cannot be expressed as file content — `git init`,
   * installing a fixture dependency.
   */
  before?: string[]
  /** Every check must pass for the case to pass. */
  checks: Check[]
  /** Cases sharing a tag can be run as a group. */
  tags?: string[]
  /** Turn cap for this case. */
  maxTurns?: number
  timeoutMs?: number
}

/**
 * A check on the world after a run.
 *
 * Deliberately not "does the output contain X": that measures phrasing rather
 * than whether the work was done, and it rewards an agent that narrates over
 * one that acts.
 */
export type Check =
  | { kind: 'file-exists'; path: string }
  | { kind: 'file-absent'; path: string }
  | { kind: 'file-matches'; path: string; pattern: string; flags?: string }
  | { kind: 'file-not-matches'; path: string; pattern: string; flags?: string }
  | { kind: 'command-succeeds'; command: string; timeoutMs?: number }
  | { kind: 'command-fails'; command: string; timeoutMs?: number }
  | { kind: 'command-outputs'; command: string; pattern: string; timeoutMs?: number }
  /** The agent's final text, for cases that genuinely are about the answer. */
  | { kind: 'reply-matches'; pattern: string; flags?: string }
  /** A ceiling on tool calls, to catch a change that makes the agent flail. */
  | { kind: 'at-most-tools'; count: number }

export interface CheckResult {
  check: Check
  passed: boolean
  detail?: string
}

export interface CaseResult {
  id: string
  passed: boolean
  checks: CheckResult[]
  /** Why the run itself failed, as distinct from a check failing. */
  error?: string
  turns: number
  toolCalls: number
  durationMs: number
  costUsd: number
  /** What the agent finally said. */
  reply: string
  /** Kept only for a failure, and only when asked, so it can be inspected. */
  workspace?: string
}

export interface SuiteResult {
  cases: CaseResult[]
  passed: number
  failed: number
  durationMs: number
  totalCostUsd: number
  /** Model the suite ran against, for comparing runs. */
  model?: string
  startedAt: number
}

/** Describes a check in one line, for a report. */
export function describeCheck(check: Check): string {
  switch (check.kind) {
    case 'file-exists':
      return `${check.path} exists`
    case 'file-absent':
      return `${check.path} does not exist`
    case 'file-matches':
      return `${check.path} matches /${check.pattern}/`
    case 'file-not-matches':
      return `${check.path} does not match /${check.pattern}/`
    case 'command-succeeds':
      return `\`${check.command}\` succeeds`
    case 'command-fails':
      return `\`${check.command}\` fails`
    case 'command-outputs':
      return `\`${check.command}\` outputs /${check.pattern}/`
    case 'reply-matches':
      return `the reply matches /${check.pattern}/`
    case 'at-most-tools':
      return `at most ${check.count} tool calls`
  }
}
