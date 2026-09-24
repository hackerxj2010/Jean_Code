import type { JeanConfig, ModelRole } from '@jean/config'
import { buildSubagentPrompt, EventStore, runLoop, type LoopEvent } from '@jean/core'
import { ModelClient } from '@jean/model'
import { Registry, createSessionState, type Tool, type ToolContext } from '@jean/tools'
import { createWorktree, type Worktree } from '@jean/subagents'
import { AGENTS, type AgentDefinition } from './agents/definitions.ts'

/**
 * Sub-agent fan-out (architecture §6.4, §12).
 *
 * A sub-agent runs its own loop with its own context window and its own tool
 * surface, and returns only its final report. The parent never sees the
 * sub-agent's tool traffic — that is the entire point. A file search that costs
 * 40 tool calls contributes one paragraph to the parent's context.
 */

export interface SpawnOptions {
  client: ModelClient
  registry: Registry
  config: JeanConfig
  cwd: string
  signal?: AbortSignal
  /** Nesting depth. Sub-agents may spawn, but not without bound. */
  depth?: number
  /** Forwarded so the TUI can show sub-agent progress. */
  onEvent?: (agent: string, event: LoopEvent) => void
  /** Who can be spawned: the built-ins plus any custom agents. Default: built-ins. */
  agents?: AgentDefinition[]
  /** The parent's permission rules, which bind its sub-agents too. */
  policy?: ToolContext['policy']
}

/**
 * The roster a spawn can draw from. A custom agent replaces a built-in of the
 * same name — a project's own `explorer` is more specific than the default.
 */
export function rosterOf(custom: AgentDefinition[] = []): AgentDefinition[] {
  const byName = new Map(AGENTS.map((a) => [a.name, a]))
  for (const agent of custom) byName.set(agent.name, agent)
  return [...byName.values()]
}

/** A client whose `role` answers with `model`, for agents that name one. */
function clientFor(options: SpawnOptions, role: ModelRole, model: string | undefined): ModelClient {
  if (!model) return options.client
  const config = options.config
  return new ModelClient({
    config: {
      ...config,
      agents: { ...config.agents, [role]: { ...(config.agents[role] ?? config.agents.default), model } },
    },
  })
}

export interface SubagentResult {
  agent: string
  task: string
  report: string
  turns: number
  toolCalls: number
  files: string[]
  ok: boolean
  error?: string
  durationMs: number
}

/** Deepest nesting allowed. Beyond this, spawning is refused, not silently ignored. */
export const MAX_DEPTH = 3

/**
 * Runs one sub-agent to completion.
 *
 * The sub-agent gets a fresh `EventStore`: no inherited history, no shared
 * mutable state with the parent. What it may touch is fixed by the definition's
 * tool list, filtered out of the parent's registry rather than trusted to the
 * prompt.
 */
export async function spawnSubagent(
  agentName: string,
  task: string,
  options: SpawnOptions,
): Promise<SubagentResult> {
  const started = Date.now()
  const roster = options.agents ?? AGENTS
  const definition = roster.find((agent) => agent.name === agentName)

  if (!definition) {
    return {
      agent: agentName,
      task,
      report: `No agent named "${agentName}". Available: ${roster.map((a) => a.name).join(', ')}.`,
      turns: 0,
      toolCalls: 0,
      files: [],
      ok: false,
      error: 'unknown-agent',
      durationMs: 0,
    }
  }

  const depth = options.depth ?? 0
  if (depth >= MAX_DEPTH) {
    return {
      agent: agentName,
      task,
      report: `Nesting limit reached (depth ${MAX_DEPTH}). Do the work directly instead of spawning another agent.`,
      turns: 0,
      toolCalls: 0,
      files: [],
      ok: false,
      error: 'max-depth',
      durationMs: 0,
    }
  }

  // Build a registry holding only this agent's tools.
  const scoped = new Registry()
  const allowed: Tool[] =
    definition.tools === '*'
      ? options.registry.names().map((n) => options.registry.get(n)!).filter(Boolean)
      : definition.tools
          .map((name) => options.registry.get(name))
          .filter((tool): tool is Tool => tool !== undefined)
  scoped.registerAll(allowed)

  // A sub-agent that can write gets its own git worktree, so two running in
  // parallel cannot land in each other's edits. Read-only agents — the ones
  // `spawn` is mostly used for — run in place: a worktree costs a git
  // operation and a directory copy to isolate work that touches nothing.
  const worktree = (await needsIsolation(definition, options))
    ? await createWorktree(options.cwd, agentName)
    : undefined

  // `createWorktree` answers `undefined` outside a git repository, which means
  // "run in place" rather than "fail" — a project without git is normal, and
  // refusing to spawn there would be worse than the collision risk.
  const workingDir = worktree?.path ?? options.cwd
  const client = clientFor(options, definition.role, definition.model)

  const store = new EventStore()
  store.append({
    type: 'session_start',
    at: started,
    cwd: workingDir,
    mode: `subagent:${agentName}`,
    model: client.resolve(definition.role).modelId,
  })
  store.append({ type: 'user_message', at: started, text: task })

  const toolContext: ToolContext = {
    cwd: workingDir,
    config: options.config,
    signal: options.signal,
    session: createSessionState(workingDir),
    // No `confirm`: a sub-agent must never be able to raise a prompt the user
    // did not ask for. Gated calls fail instead, and the parent decides.
    // The parent's rules come along: a deny rule that a sub-agent could
    // sidestep would not be a rule.
    policy: options.policy,
  }

  const systemPrompt = buildSubagentPrompt(
    `${definition.instructions}\n\n### The task\n\n${task}`,
    { mode: 'autonomous', cwd: workingDir, config: options.config, toolNames: scoped.names() },
  )

  let result
  let mergeNote = ''

  try {
    result = await runLoop({
      store,
      client,
      registry: scoped,
      config: options.config,
      toolContext,
      systemPrompt,
      role: definition.role,
      signal: options.signal,
      maxTurns: definition.maxTurns,
      onEvent: options.onEvent ? (event) => options.onEvent!(agentName, event) : undefined,
    })
  } catch (error) {
    // The worktree is removed even when the run threw, or a failed spawn
    // leaves a branch and a temp directory behind on every attempt.
    await worktree?.discard()
    throw error
  }

  if (worktree) {
    const finished = result
    mergeNote = await serializeMerge(() => finishWorktree(worktree, finished.stopReason))
  }

  return {
    agent: agentName,
    task,
    // The merge note rides on the report, because that is the only field the
    // parent agent reads. A worktree that failed to merge is something it has
    // to know about — silently returning a clean-looking report while the work
    // sits on an abandoned branch is the worst outcome here.
    report: (result.text || '(the agent returned no text)') + mergeNote,
    turns: result.turns,
    toolCalls: result.toolCalls,
    files: result.files,
    ok: result.stopReason === 'complete',
    error: result.error,
    durationMs: Date.now() - started,
  }
}

/**
 * Runs several sub-agents in parallel.
 *
 * Safe to parallelize where the main loop's tool calls are not: each sub-agent
 * has its own store and its own context, and read-only agents cannot collide.
 * Spawning several *writing* agents on overlapping files is the caller's
 * responsibility to avoid — which is what worktree isolation in
 * `@jean/subagents` exists to solve.
 */
export async function fanOut(
  tasks: { agent: string; task: string }[],
  options: SpawnOptions,
): Promise<SubagentResult[]> {
  return Promise.all(tasks.map((t) => spawnSubagent(t.agent, t.task, options)))
}

/** The `spawn` tool, which is how the model reaches all of this. */
export function createSpawnTool(options: SpawnOptions): Tool<{
  agent: string
  task: string
}> {
  const roster = options.agents ?? AGENTS
  return {
    name: 'spawn',
    risk: 'execute',
    // Each sub-agent has its own context, and a writing one its own worktree,
    // so several spawned in one turn cannot collide. The one shared step —
    // merging back — is serialized in `serializeMerge`.
    concurrency: 'parallel',
    description: [
      'Delegate a piece of work to a specialized agent.',
      '',
      'The agent runs in its own context and returns only its final report, so this is',
      'how you investigate something expensive without filling your own context with',
      'the search. Give it a task it can finish on its own — it cannot ask you questions.',
      '',
      'Several `spawn` calls in the same response run in parallel. For independent',
      'questions — "how does auth work", "where are the migrations" — issue them together.',
      '',
      'Available agents:',
      roster.map((agent) => `- \`${agent.name}\` — ${agent.purpose}`).join('\n'),
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          enum: roster.map((a) => a.name),
          description: 'Which agent to run.',
        },
        task: {
          type: 'string',
          description:
            'The complete task. Include every detail the agent needs — it cannot see this conversation.',
        },
      },
      required: ['agent', 'task'],
    },
    summarize: (args) => `spawn ${args.agent}: ${args.task.slice(0, 80)}`,

    async execute(args, context) {
      const result = await spawnSubagent(args.agent, args.task, {
        ...options,
        cwd: context.cwd,
        signal: context.signal,
        depth: (options.depth ?? 0) + 1,
      })

      const stats = `[${result.agent}: ${result.turns} turns, ${result.toolCalls} tool calls, ${(result.durationMs / 1000).toFixed(1)}s]`
      return {
        output: `${result.report}\n\n${stats}`,
        isError: !result.ok,
        touched: result.files,
        display: { kind: 'subagent', ...result },
      }
    },
  }
}

/**
 * Whether this sub-agent could write, and so needs its own worktree.
 *
 * Decided from the tool surface rather than from a flag on the definition: the
 * surface is what actually constrains it, and a flag would be a second source
 * of truth to keep in sync.
 *
 * `plan` permission mode hides every mutating tool from the model, so an agent
 * running under it cannot write whatever its definition lists.
 */
async function needsIsolation(
  definition: AgentDefinition,
  options: SpawnOptions,
): Promise<boolean> {
  if (options.config.permissionMode === 'plan') return false

  const MUTATING = new Set(['write', 'edit', 'bash', 'bash_input', 'patch', 'checkpoint'])

  if (definition.tools === '*') return true
  return definition.tools.some((name) => MUTATING.has(name))
}

/**
 * Runs merge-backs one at a time.
 *
 * Sub-agents run in parallel but merge into one working tree, and git holds an
 * index lock for the duration of a merge — two at once fail on the lock, or
 * worse, each computes its merge against a tree the other is changing.
 */
let mergeQueue: Promise<unknown> = Promise.resolve()

function serializeMerge<T>(run: () => Promise<T>): Promise<T> {
  const next = mergeQueue.then(run, run)
  // The queue must survive a failed merge, or one conflict blocks every later one.
  mergeQueue = next.catch(() => undefined)
  return next
}

/**
 * Merges a worktree back and reports what happened, in one line for the parent.
 *
 * A conflict is *not* resolved here. Two agents editing the same lines is a
 * decision about intent, and guessing at it silently is how a merge quietly
 * discards someone's work. The parent is told which files conflicted and the
 * branch is left in place so the work can be recovered.
 */
async function finishWorktree(
  worktree: Worktree,
  stopReason: string,
): Promise<string> {
  // A run that failed or was interrupted has not produced work worth merging,
  // and merging a half-finished edit is worse than dropping it.
  if (stopReason !== 'complete') {
    await worktree.discard()
    return `\n\n(work discarded: the sub-agent stopped with \`${stopReason}\`)`
  }

  const merged = await worktree.finish({ merge: true })

  if (merged.merged) {
    return merged.files.length > 0
      ? `\n\n(merged ${merged.files.length} file${merged.files.length === 1 ? '' : 's'} from an isolated worktree)`
      : ''
  }

  return [
    '',
    '',
    `(the sub-agent's work could NOT be merged: ${merged.message})`,
    merged.conflicts.length > 0
      ? `Conflicting files: ${merged.conflicts.join(', ')}`
      : '',
    `The work is preserved on branch \`${worktree.branch}\`.`,
  ]
    .filter(Boolean)
    .join('\n')
}
