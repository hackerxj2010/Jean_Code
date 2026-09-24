import type { JeanConfig } from '@jean/config'
import { buildSubagentPrompt, EventStore, runLoop, type LoopEvent, type LoopResult } from '@jean/core'
import { ModelClient } from '@jean/model'
import { createWorktree, type Worktree } from '@jean/subagents'
import { createSessionState, Registry, type Tool, type ToolContext } from '@jean/tools'

/**
 * The arena: several independent attempts at one task, and the best one kept.
 *
 * An agent that solves a task three times in five tries is, with a way to tell
 * which tries worked, an agent that solves it every time. The attempts run in
 * parallel, each in its own worktree seeded from the current files, so they
 * cannot see or disturb each other. A verify command — the project's tests,
 * usually — decides which ones worked; among those, the smallest change wins,
 * because the attempt that touched the least is least likely to have done
 * something nobody asked for.
 *
 * Attempts differ on purpose. Identical settings on a deterministic model
 * would produce the same attempt N times, so the first runs as configured and
 * the rest at a higher temperature — or on different models, when given.
 */

export interface ArenaOptions {
  task: string
  /** How many attempts. Clamped to 2–8. */
  attempts: number
  /** Decides which attempts succeeded. Without it, only "finished cleanly" counts. */
  verify?: string
  client: ModelClient
  config: JeanConfig
  cwd: string
  /** The parent's tools; each attempt gets all of them except delegation and questions. */
  registry: Registry
  policy?: ToolContext['policy']
  signal?: AbortSignal
  /** Models to rotate through, one per attempt, for more diverse attempts. */
  models?: string[]
  onEvent?: (attempt: number, event: LoopEvent) => void
  onProgress?: (text: string) => void
  /** Builds the client for one attempt. Defaults to the diversity rule below. */
  clientFor?: (attempt: number, model: string | undefined) => ModelClient
}

export interface ArenaEntry {
  attempt: number
  model: string
  /** The attempt's own loop finished without error. */
  finished: boolean
  /** The verify command passed in the attempt's worktree; undefined without one. */
  passed?: boolean
  files: string[]
  lines: number
  turns: number
  toolCalls: number
  durationMs: number
  summary: string
  error?: string
}

export interface ArenaResult {
  /** Index into `entries` of the attempt that was merged. */
  winner?: number
  entries: ArenaEntry[]
  merged: boolean
  message: string
}

const INSTRUCTIONS = `You are one of several independent attempts at the same task, each in its own copy of the repository. Only the best attempt is kept, so do the task completely and verify it; an attempt that stops early or leaves the project broken is discarded. Nobody can answer questions.`

export async function runArena(options: ArenaOptions): Promise<ArenaResult> {
  const count = Math.min(8, Math.max(2, Math.floor(options.attempts)))
  const trees: (Worktree | undefined)[] = []
  for (let i = 0; i < count; i++) trees.push(await createWorktree(options.cwd, `arena-${i + 1}`))
  if (trees.some((t) => t === undefined)) {
    await Promise.all(trees.map((t) => t?.discard()))
    // Inside git each attempt gets a worktree; outside it, a `pi-iso` copy.
    // Neither is available only without the Rust core, or for a project too
    // large to copy — and attempts sharing one tree would overwrite each other.
    throw new Error(
      'The arena could not isolate its attempts: outside a git repository they run in pi-iso copies, which need the Rust core (`jean native build`) and a project under 20,000 files.',
    )
  }
  const worktrees = trees as Worktree[]
  options.onProgress?.(`Running ${count} attempts in parallel…`)

  const entries = await Promise.all(worktrees.map((tree, i) => attempt(options, tree, i)))

  // Rank: verified first, then finished cleanly, then the smallest change,
  // then the fewest turns. An attempt that changed nothing cannot have done
  // the task.
  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.lines > 0)
    .filter(({ entry }) => (options.verify ? entry.passed === true : entry.finished))
    .sort(
      (a, b) =>
        Number(b.entry.finished) - Number(a.entry.finished) ||
        a.entry.lines - b.entry.lines ||
        a.entry.turns - b.entry.turns,
    )

  const winner = ranked[0]?.index
  let merged = false
  let message: string

  if (winner === undefined) {
    await Promise.all(worktrees.map((tree) => tree.discard()))
    message = options.verify
      ? `No attempt made \`${options.verify}\` pass. Nothing was changed.`
      : 'No attempt finished cleanly with a change. Nothing was changed.'
  } else {
    await Promise.all(worktrees.map((tree, i) => (i === winner ? undefined : tree.discard())))
    const result = await worktrees[winner]!.finish({ merge: true })
    merged = result.merged
    message = result.merged
      ? `Attempt ${winner + 1} won and was merged into the working tree (uncommitted): ${result.files.join(', ')}.`
      : `Attempt ${winner + 1} won but could not be merged: ${result.message}`
  }

  return { winner, entries, merged, message }
}

async function attempt(options: ArenaOptions, tree: Worktree, index: number): Promise<ArenaEntry> {
  const started = Date.now()
  const models = options.models?.filter(Boolean) ?? []
  const model = models.length > 0 ? models[index % models.length] : undefined
  const client = options.clientFor?.(index, model) ?? clientFor(options, index, model)
  const resolved = client.resolve('default')

  const registry = new Registry()
  for (const name of options.registry.names()) {
    // No nested fan-out, and nobody to answer a question.
    if (name === 'spawn' || name === 'ask') continue
    registry.register(options.registry.get(name) as Tool)
  }

  const toolContext: ToolContext = {
    cwd: tree.path,
    config: options.config,
    signal: options.signal,
    session: createSessionState(tree.path),
    policy: options.policy,
  }

  const verify = async (): Promise<{ passed: boolean; output: string }> => {
    if (!options.verify) return { passed: true, output: '' }
    const result = await registry.call('bash', { command: options.verify, timeout: 900_000 }, toolContext)
    return { passed: !result.isError, output: result.output }
  }

  const store = new EventStore()
  store.append({ type: 'session_start', at: started, cwd: tree.path, mode: `arena:${index + 1}`, model: resolved.modelId })
  const goal = options.verify
    ? `\n\nThe task is done when \`${options.verify}\` passes. Do not modify that check or the tests it runs to make it pass.`
    : ''
  store.append({ type: 'user_message', at: started, text: `${options.task}${goal}` })

  let result: LoopResult
  try {
    result = await runLoop({
      store,
      client,
      registry,
      config: options.config,
      toolContext,
      systemPrompt: buildSubagentPrompt(`${INSTRUCTIONS}\n\n### The task\n\n${options.task}${goal}`, {
        mode: 'autonomous',
        cwd: tree.path,
        config: options.config,
        toolNames: registry.names(),
        interactive: false,
      }),
      signal: options.signal,
      maxStopContinuations: 12,
      hooks: {
        beforeStop: async () => {
          const check = await verify()
          if (check.passed) return undefined
          return {
            continueWith: `\`${options.verify}\` does not pass yet:\n\n${check.output.slice(-6000)}\n\nKeep working until it passes.`,
          }
        },
      },
      onEvent: options.onEvent ? (event) => options.onEvent!(index, event) : undefined,
    })
  } catch (err) {
    return {
      attempt: index + 1,
      model: resolved.modelId,
      finished: false,
      files: [],
      lines: 0,
      turns: 0,
      toolCalls: 0,
      durationMs: Date.now() - started,
      summary: '',
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const final = options.verify ? await verify() : undefined
  const changes = await tree.changes()
  options.onProgress?.(
    `Attempt ${index + 1} (${resolved.modelId}): ${result.stopReason}${final ? `, check ${final.passed ? 'passes' : 'fails'}` : ''}, ${changes.lines} lines in ${changes.files.length} files`,
  )

  return {
    attempt: index + 1,
    model: resolved.modelId,
    finished: result.stopReason === 'complete',
    passed: final?.passed,
    files: changes.files,
    lines: changes.lines,
    turns: result.turns,
    toolCalls: result.toolCalls,
    durationMs: Date.now() - started,
    summary: result.text.slice(0, 500),
    error: result.error,
  }
}

/** A client for one attempt: the first as configured, the others hotter or on another model. */
function clientFor(options: ArenaOptions, index: number, model: string | undefined): ModelClient {
  if (index === 0 && !model) return options.client
  const base = options.config.agents.default
  return new ModelClient({
    config: {
      ...options.config,
      agents: {
        ...options.config.agents,
        default: {
          ...base,
          ...(model ? { model } : {}),
          temperature: index === 0 ? base.temperature : 0.8,
        },
      },
    },
  })
}
