import { loadConfig, type JeanConfig, type PartialConfig } from '@jean/config'
import { Orchestrator, spawnSubagent, type SubagentResult } from '@jean/agent'
import {
  EventStore,
  newSessionId,
  type JeanEvent,
  type LoopEvent,
  type LoopResult,
} from '@jean/core'
import { chooseModel, defaultStreamRules, ModelClient } from '@jean/model'
import { openMemory, type MemoryBackend } from '@jean/memory'
import type { Tool } from '@jean/tools'

/**
 * `@jean/sdk` — Jean Code as a library (architecture §6.23).
 *
 * The same orchestrator the CLI drives, with a smaller surface: create an
 * agent, send it prompts, register your own tools, read the event stream.
 *
 * ```ts
 * const agent = await createAgent({ cwd: process.cwd() })
 * const result = await agent.send('add a health check endpoint')
 * console.log(result.text, result.files)
 * ```
 */

export interface AgentOptions {
  /** Project root. Defaults to `process.cwd()`. */
  cwd?: string
  /** Config overrides, applied above files and the environment. */
  config?: PartialConfig
  /** Tools to add to the built-in set. */
  tools?: Tool[]
  /** Called for every loop event: streaming text, tool calls, notices. */
  onEvent?: (event: LoopEvent) => void
  /** Approve gated tool calls. Without it, gated calls are refused. */
  confirm?: (request: {
    tool: string
    summary: string
    detail?: string
  }) => Promise<boolean>
  /** Resume this session's events. */
  resume?: JeanEvent[]
  /** Skip reading other agents' config files. */
  skipImport?: boolean
}

export interface Agent {
  /** Sends a prompt and runs to completion. */
  send(prompt: string): Promise<LoopResult>
  /** Delegates one task to a specialized sub-agent. */
  spawn(agent: string, task: string): Promise<SubagentResult>
  /** Interrupts the run in progress. */
  interrupt(): void
  /** Registers an additional tool mid-session. */
  addTool(tool: Tool): void
  /** The event log — the full record of the session. */
  events(): readonly JeanEvent[]
  /** Cumulative token usage. */
  usage(): { inputTokens: number; outputTokens: number; turns: number }
  /** Files changed so far. */
  files(): string[]
  /** Ends the session and releases resources. */
  close(): void
  readonly sessionId: string
  readonly config: JeanConfig
}

/** Creates an embedded agent. */
export async function createAgent(options: AgentOptions = {}): Promise<Agent> {
  const cwd = options.cwd ?? process.cwd()
  const sessionId = newSessionId()

  const loaded = loadConfig({
    cwd,
    flags: options.config,
    skipImport: options.skipImport,
  })
  const { config } = chooseModel(loaded.config, loaded.modelChosen ?? true)

  const client = new ModelClient({ config, streamRules: defaultStreamRules() })
  const { backend: memory } = openMemory(config)

  const store = options.resume ? EventStore.fromJSON(options.resume) : undefined

  const orchestrator = new Orchestrator({
    config,
    client,
    cwd,
    sessionId,
    memory,
    store,
    onEvent: options.onEvent,
    confirm: options.confirm
      ? (request) => options.confirm!({ tool: request.tool, summary: request.summary, detail: request.detail })
      : undefined,
  })

  for (const tool of options.tools ?? []) orchestrator.registry.register(tool)

  return {
    sessionId,
    config,

    send: (prompt) => orchestrator.send(prompt),

    spawn: (agent, task) =>
      spawnSubagent(agent, task, {
        client,
        registry: orchestrator.registry,
        config: orchestrator.config,
        cwd,
      }),

    interrupt: () => orchestrator.interrupt(),
    addTool: (tool) => orchestrator.registry.register(tool),
    events: () => orchestrator.store.all(),
    usage: () => orchestrator.store.usage(),
    files: () => orchestrator.store.touchedFiles(),

    close: () => {
      orchestrator.end('sdk close')
      memory.close()
    },
  }
}

/**
 * One-shot convenience: run a prompt and return the text.
 *
 * For scripts that want an answer rather than a session.
 */
export async function ask(prompt: string, options: AgentOptions = {}): Promise<string> {
  const agent = await createAgent(options)
  try {
    const result = await agent.send(prompt)
    if (result.stopReason === 'error') throw new Error(result.error ?? 'the run failed')
    return result.text
  } finally {
    agent.close()
  }
}

/**
 * Defines a tool with the right shape, inferring nothing.
 *
 * A plain helper rather than a builder: the point is that a tool is just an
 * object, and this only exists so callers get type checking on it.
 */
export function defineTool<Args = Record<string, unknown>>(tool: Tool<Args>): Tool<Args> {
  return tool
}

export type { JeanConfig, JeanEvent, LoopEvent, LoopResult, MemoryBackend, SubagentResult, Tool }
export { EventStore, ModelClient, Orchestrator }
