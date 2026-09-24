import { isAbsolute, resolve } from 'node:path'

/**
 * Tool names across harnesses.
 *
 * Hook scripts and permission rules already exist in the wild, written for
 * Claude Code: `matcher: "Edit|Write"`, `Bash(npm test:*)`, a formatter that
 * reads `tool_input.file_path`. Jean's tools have their own names and argument
 * shapes, so without a bridge every one of those files would silently match
 * nothing — the worst kind of incompatibility, because nothing reports it.
 */

/** Jean's tool name to the name Claude Code uses for the equivalent tool. */
const CLAUDE_NAME: Record<string, string> = {
  bash: 'Bash',
  bash_output: 'BashOutput',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  todo: 'TodoWrite',
  spawn: 'Task',
  ask: 'AskUserQuestion',
}

/** Further Claude Code names that land on a Jean tool. */
const EXTRA_ALIASES: Record<string, string> = {
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Agent: 'spawn',
  LS: 'read',
  KillShell: 'bash_output',
  KillBash: 'bash_output',
}

const TO_JEAN: Record<string, string> = {
  ...Object.fromEntries(Object.entries(CLAUDE_NAME).map(([jean, claude]) => [claude, jean])),
  ...EXTRA_ALIASES,
}

/** The name Claude Code would use for a Jean tool, or the name unchanged. */
export function claudeName(jeanName: string): string {
  return CLAUDE_NAME[jeanName] ?? jeanName
}

/** Every name a tool answers to, for hook matchers. */
export function namesOf(jeanName: string): string[] {
  const names = new Set([jeanName, claudeName(jeanName)])
  for (const [alias, target] of Object.entries(EXTRA_ALIASES)) {
    if (target === jeanName) names.add(alias)
  }
  return [...names]
}

/** A rule's tool name in Jean's vocabulary: `Bash` → `bash`, `mcp__x` unchanged. */
export function jeanName(name: string): string {
  return TO_JEAN[name] ?? name
}

/** The path a call operates on, if it has one, as an absolute path. */
export function pathOf(input: unknown, cwd: string): string | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  const raw = record.path ?? record.file_path ?? record.notebook_path
  if (typeof raw !== 'string' || raw === '') return undefined
  return isAbsolute(raw) ? raw : resolve(cwd, raw)
}

/**
 * A tool call's arguments in the shape Claude Code hook scripts read.
 *
 * Jean's own field names are kept alongside, so a hook written for Jean sees
 * what it expects too. Nothing is removed — only aliases are added.
 */
export function claudeInput(tool: string, input: unknown, cwd: string): Record<string, unknown> {
  const record =
    input !== null && typeof input === 'object' ? { ...(input as Record<string, unknown>) } : {}

  const path = pathOf(input, cwd)
  if (path && record.file_path === undefined) record.file_path = path

  if (tool === 'spawn') {
    if (record.subagent_type === undefined && typeof record.agent === 'string') {
      record.subagent_type = record.agent
    }
    if (record.prompt === undefined && typeof record.task === 'string') record.prompt = record.task
  }
  if (tool === 'grep' || tool === 'glob') {
    if (record.path === undefined) record.path = cwd
  }
  return record
}
