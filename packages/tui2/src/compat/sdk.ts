/**
 * What the interface used to import from `@codebuff/sdk`.
 *
 * Re-exports the types from `./types`, and supplies the handful of loose
 * functions the UI called. Each is either backed by Jean's own packages or
 * reduced to the honest answer for a tool that has no hosted service behind it.
 */

export type {
  AgentDefinition,
  FileFilter,
  MessageContent,
  RunConfig,
  RunState,
  StreamChunk,
  ToolName,
  ToolResultOutput,
  Logger,
} from './types'

export { JeanClient } from './client'

import { defaultShell } from '@jean/tools'

import type { SkillsMap } from './common'

/** How long a reconnection notice stays up. */
export const RECONNECTION_MESSAGE_DURATION_MS = 3000

/**
 * HTTP status from a thrown error, when there is one.
 *
 * Providers report rate limits and auth failures as status codes, and the
 * interface branches on them to say something useful rather than dumping a
 * stack trace.
 */
export function getErrorStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined

  const candidate = error as { status?: unknown; statusCode?: unknown; response?: unknown }
  for (const value of [candidate.status, candidate.statusCode]) {
    if (typeof value === 'number') return value
  }

  const response = candidate.response as { status?: unknown } | undefined
  if (typeof response?.status === 'number') return response.status

  // Providers that only put the code in the message: "returned 429: ...".
  const message = error instanceof Error ? error.message : String(error)
  const match = /\b(4\d{2}|5\d{2})\b/.exec(message)
  return match ? Number(match[1]) : undefined
}

/**
 * Whether retrying could plausibly succeed.
 *
 * 429 and 5xx are transient. 401/403 are not — retrying a bad key just burns
 * time and makes the real problem harder to see. 402 is not either: no amount
 * of retrying adds credit.
 */
export function isRetryableStatusCode(status: number | undefined): boolean {
  if (status === undefined) return false
  if (status === 429) return true
  return status >= 500 && status < 600
}

/**
 * Strips anything secret-shaped from an error before it is displayed.
 *
 * Error messages from providers routinely echo the request, key included, and
 * the interface puts them on screen and into a log file.
 */
export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}/gi, 'Bearer ***')
    .replace(/\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, '***.***.***')
    .replace(/("?(?:api[_-]?key|token|secret|password)"?\s*[:=]\s*"?)([^"\s,}]{8,})/gi, '$1***')
}

/**
 * Path to a bundled ripgrep, if one shipped with this build.
 *
 * Jean does not bundle one — it uses the `grep` builtin, or whatever `rg` is on
 * PATH. Returning undefined is the truthful answer and callers already handle it.
 */
export async function getBundledRgPath(): Promise<string | undefined> {
  return undefined
}

/** Runs a command and returns its output, for the terminal tool card. */
export async function runTerminalCommand(
  command: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // The shell the agent's `bash` tool uses, not a login shell: a profile that
  // prints a banner would land in every command's output.
  const shell = defaultShell()
  const proc = Bun.spawn([shell.path, ...shell.args, command], {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { stdout, stderr, exitCode }
}

/** Sub-agents available to spawn. Supplied by `@jean/agent`'s catalog. */
export async function loadLocalAgents(): Promise<Record<string, unknown>> {
  const { AGENTS } = await import('@jean/agent')
  return Object.fromEntries(
    AGENTS.map((agent) => [
      agent.name,
      { id: agent.name, displayName: agent.name, ...agent },
    ]),
  )
}

/**
 * Validates agent definitions.
 *
 * Jean's agents are code in `@jean/agent`, checked by the compiler, so there is
 * nothing to validate at runtime and this always passes.
 *
 * The field names are load-bearing. The caller branches on `success` and reads
 * `validationErrors` — returning `{ valid, errors }` instead made `success`
 * undefined, which is falsy, so every message was silently dropped before it
 * reached the agent. The error list was empty, so nothing was shown either: the
 * interface just did nothing when you pressed Enter.
 */
export async function validateAgents(
  _definitions?: unknown,
  _options?: unknown,
): Promise<{ success: true; validationErrors: [] }> {
  return { success: true, validationErrors: [] }
}

/** Skills on disk, from `@jean/skills`. */
/** Skills from `@jean/skills` — bundled, the user's, the project's — by name. */
export async function loadSkills(options: string | { cwd: string; verbose?: boolean }): Promise<SkillsMap> {
  const cwd = typeof options === 'string' ? options : options.cwd
  const { discoverSkills } = await import('@jean/skills')
  return Object.fromEntries(
    discoverSkills(cwd).map((skill) => [
      skill.name,
      { name: skill.name, description: skill.description, content: skill.body, path: skill.path, source: skill.source },
    ]),
  )
}

/** MCP servers from config. Read synchronously because startup wants it. */
export function loadMCPConfigSync(): { mcpServers: Record<string, unknown> } {
  return { mcpServers: {} }
}

// ---- removed: hosted-account features -------------------------------------
//
// Jean authenticates to a provider with an API key from the environment. There
// is no account, so there is nothing to OAuth into. These stay as no-ops so the
// call sites keep compiling until they are removed.

export function getChatGptOAuthCredentials(): null {
  return null
}

export async function getValidChatGptOAuthCredentials(): Promise<null> {
  return null
}
