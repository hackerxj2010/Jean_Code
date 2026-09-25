import type { PermissionMode } from '@jean/config'
import type { ToolSchema } from '@jean/model'
import type { CallOptions, Risk, Tool, ToolContext, ToolResult } from './types.ts'
import { ToolError } from './types.ts'
import { nativeCommandLines } from './accelerate.ts'

/**
 * The central tool registry (architecture §6.6).
 *
 * Every capability — built-in tools, MCP servers, plugins — registers here, and
 * every call routes through [`Registry.call`]. That single choke point is what
 * makes permission gating, argument validation, and audit one implementation
 * instead of a convention each tool is trusted to follow.
 */

export interface CallRecord {
  tool: string
  args: unknown
  result: ToolResult
  durationMs: number
  at: number
}

export interface RegistryOptions {
  /** Called after every call, for the session log and the TUI. */
  onCall?: (record: CallRecord) => void
}

export class Registry {
  private readonly tools = new Map<string, Tool>()
  private readonly options: RegistryOptions

  constructor(options: RegistryOptions = {}) {
    this.options = options
  }

  /**
   * Registers a tool. Names are unique; re-registering replaces, which is how
   * a plugin deliberately overrides a built-in.
   */
  register(tool: Tool): void {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new Error(
        `tool name "${tool.name}" must be lower_snake_case — many providers reject other shapes`,
      )
    }
    this.tools.set(tool.name, tool)
  }

  registerAll(tools: Tool[]): void {
    for (const tool of tools) this.register(tool)
  }

  /** Registers MCP or plugin tools under a namespace, e.g. `mcp__github__*`. */
  registerNamespaced(namespace: string, tools: Tool[]): void {
    for (const tool of tools) {
      this.register({ ...tool, name: `${namespace}__${tool.name}` })
    }
  }

  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  names(): string[] {
    return [...this.tools.keys()].sort()
  }

  /**
   * The tool schemas offered to the model for a given permission mode.
   *
   * In `plan` mode, mutating tools are not merely blocked — they are not
   * advertised at all. A model that cannot see a tool does not spend a turn
   * trying to use it and being refused.
   */
  schemas(mode: PermissionMode): ToolSchema[] {
    return [...this.tools.values()]
      .filter((tool) => this.isVisible(tool, mode))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }))
  }

  private isVisible(tool: Tool, mode: PermissionMode): boolean {
    if (tool.hiddenIn?.includes(mode)) return false
    if (mode === 'plan' && tool.risk !== 'read') return false
    return true
  }

  /**
   * Runs a tool call.
   *
   * Failures become error *results* rather than thrown exceptions: the agent
   * needs to see what went wrong so it can correct, and an exception here would
   * end the turn instead.
   */
  async call(
    name: string,
    args: unknown,
    context: ToolContext,
    options: CallOptions = {},
  ): Promise<ToolResult> {
    const started = Date.now()
    const tool = this.tools.get(name)

    if (!tool) {
      return this.record(name, args, started, {
        output: `No tool named "${name}". Available tools: ${this.names().join(', ')}`,
        isError: true,
      })
    }

    const mode = context.config.permissionMode
    if (!this.isVisible(tool, mode)) {
      return this.record(name, args, started, {
        output: `\`${name}\` is not available in ${mode} mode. ${
          mode === 'plan'
            ? 'Plan mode is read-only — describe the change instead of making it.'
            : 'Ask the user to change the permission mode.'
        }`,
        isError: true,
      })
    }

    const validation = validateArgs(tool, args)
    if (validation) {
      return this.record(name, args, started, { output: validation, isError: true })
    }

    const gate = await this.gate(tool, args, context, options)
    if (!gate.allowed) {
      return this.record(name, args, started, { output: gate.reason, isError: true })
    }

    try {
      const result = await tool.execute(args, context)
      return this.record(name, args, started, result)
    } catch (err) {
      if (context.signal?.aborted) {
        return this.record(name, args, started, {
          output: `\`${name}\` was interrupted.`,
          isError: true,
        })
      }
      const message =
        err instanceof ToolError
          ? err.hint
            ? `${err.message}\n${err.hint}`
            : err.message
          : err instanceof Error
            ? err.message
            : String(err)
      return this.record(name, args, started, { output: message, isError: true })
    }
  }

  /**
   * Permission gating (architecture §23).
   *
   * `full` never asks. `plan` blocks everything mutating. `ask` confirms every
   * mutating call. `auto` — the default — acts freely and confirms only what the
   * config marks destructive; that list is checked by the shell tool itself,
   * which is the only place a command string exists to check.
   */
  private async gate(
    tool: Tool,
    args: unknown,
    context: ToolContext,
    options: CallOptions,
  ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    const mode = context.config.permissionMode

    // Rules first. A deny rule is the user saying "never", so it holds in
    // every mode and for read-only tools too — `Read(./.env)` exists precisely
    // to stop a read. An ask rule is the user saying "check with me", so it
    // prompts even in `full`.
    let verdict: ReturnType<NonNullable<ToolContext['policy']>['evaluate']>
    let rulesFailed: string | undefined
    try {
      // A bash rule is checked against every command the line would run, as
      // the `pi-shell` parser sees them — so quoting that the shell strips
      // (`'r''m' -rf x`) or a `$(...)` does not slip past a deny rule.
      const command = (args as { command?: unknown } | null)?.command
      const facts =
        context.policy && tool.name === 'bash' && typeof command === 'string'
          ? { commands: await nativeCommandLines(command) }
          : undefined
      verdict = context.policy?.evaluate(tool.name, args, context, facts)
    } catch (error) {
      // Rules that cannot be checked might have denied this call, so it is
      // not allowed silently: the user is asked, and a non-interactive run
      // refuses. Only the rule set can throw here — the native command
      // parser returns undefined when it is unavailable.
      verdict = undefined
      rulesFailed = `permission rules could not be checked: ${error instanceof Error ? error.message : String(error)}`
    }
    if (rulesFailed) {
      if (mode === 'plan' && tool.risk !== 'read') {
        return { allowed: false, reason: `Plan mode is read-only, so \`${tool.name}\` did not run.` }
      }
      return this.confirm(tool, args, context, rulesFailed)
    }
    if (verdict?.decision === 'deny') {
      return {
        allowed: false,
        reason: `\`${tool.name}\` is blocked by the permission rule \`${verdict.rule}\`. Do not try to reach the same result another way; ask the user if it is needed.`,
      }
    }
    if (verdict?.decision === 'ask' || options.ask) {
      if (mode === 'plan' && tool.risk !== 'read') {
        return { allowed: false, reason: `Plan mode is read-only, so \`${tool.name}\` did not run.` }
      }
      const why = options.ask ?? `matches \`${verdict!.rule}\``
      return this.confirm(tool, args, context, why)
    }

    if (mode === 'full' || tool.risk === 'read') return { allowed: true }
    if (mode === 'plan') {
      return {
        allowed: false,
        reason: `Plan mode is read-only, so \`${tool.name}\` did not run.`,
      }
    }
    if (mode === 'auto') return { allowed: true }

    // `ask` mode: an allow rule or a hook's approval stands in for the prompt.
    if (verdict?.decision === 'allow' || options.approve) return { allowed: true }
    return this.confirm(tool, args, context)
  }

  private async confirm(
    tool: Tool,
    args: unknown,
    context: ToolContext,
    why?: string,
  ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    const summary = tool.summarize?.(args, context) ?? `${tool.name}(${preview(args)})`
    if (!context.confirm) {
      // Non-interactive: no one can answer, so refuse rather than assume yes.
      return {
        allowed: false,
        reason: `\`${tool.name}\` needs confirmation${why ? ` (${why})` : ''} but this session is non-interactive.`,
      }
    }

    const approved = await context.confirm({
      tool: tool.name,
      risk: tool.risk,
      summary: why ? `${summary} — ${why}` : summary,
      detail: typeof args === 'object' ? JSON.stringify(args, null, 2) : String(args),
    })
    return approved
      ? { allowed: true }
      : { allowed: false, reason: `The user declined \`${tool.name}\`. Do not retry it.` }
  }

  private record(tool: string, args: unknown, started: number, result: ToolResult): ToolResult {
    this.options.onCall?.({
      tool,
      args,
      result,
      durationMs: Date.now() - started,
      at: started,
    })
    return result
  }
}

/**
 * Validates arguments against the tool's JSON Schema.
 *
 * Only the parts that actually bite: missing required fields, wrong primitive
 * types, and unknown enum values. Returns an error message, or `undefined` when
 * the arguments are usable.
 */
export function validateArgs(tool: Tool, args: unknown): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return `\`${tool.name}\` expects an object of arguments, received ${describeType(args)}.`
  }
  const value = args as Record<string, unknown>

  if (value._parseError) {
    return `The arguments for \`${tool.name}\` were not valid JSON. Re-issue the call with well-formed arguments.`
  }

  const problems: string[] = []
  for (const required of tool.parameters.required ?? []) {
    if (value[required] === undefined || value[required] === null) {
      problems.push(`missing required argument \`${required}\``)
    }
  }

  for (const [key, raw] of Object.entries(tool.parameters.properties)) {
    const provided = value[key]
    if (provided === undefined) continue
    const schema = raw as { type?: string; enum?: unknown[] }

    if (schema.enum && !schema.enum.includes(provided)) {
      problems.push(
        `\`${key}\` must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}, received ${JSON.stringify(provided)}`,
      )
      continue
    }
    if (schema.type && !typeMatches(schema.type, provided)) {
      problems.push(`\`${key}\` must be a ${schema.type}, received ${describeType(provided)}`)
    }
  }

  if (problems.length === 0) return undefined
  return `Invalid arguments for \`${tool.name}\`: ${problems.join('; ')}.`
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    default:
      return true
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

function preview(args: unknown): string {
  const text = typeof args === 'string' ? args : JSON.stringify(args)
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}

/** Risk ordering, for sorting and display. */
export const RISK_ORDER: Risk[] = ['read', 'network', 'write', 'execute']
