/**
 * The event and value types the interface renders against.
 *
 * These were `@codebuff/sdk` and `@codebuff/common` types. They are redeclared
 * here rather than imported because Jean Code has no Codebuff dependency — and
 * because the set the UI actually touches turned out to be small. Redeclaring
 * it makes the contract between the agent and the interface explicit and
 * checkable, instead of implicit in someone else's package.
 *
 * `@jean/agent` emits `LoopEvent`; `compat/client.ts` translates. The shapes
 * below are the *interface's* vocabulary, so the translation lives in one place
 * and the 200-odd rendering files stay untouched.
 */

/** A tool the agent can call. Open, because the registry is extensible. */
export type ToolName = string

/** One part of a message: text the model wrote, or an image the user attached. */
export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; mediaType?: string }

/** What a tool handed back. */
export type ToolResultOutput =
  | { type: 'json'; value: unknown }
  | { type: 'text'; value: string }
  | { type: 'error'; message: string }

/**
 * A conversation that can be continued.
 *
 * Opaque to the interface: it is handed back on the next turn and never read.
 * Jean's real continuity lives in the `EventStore`, which is the source of
 * truth; this only has to round-trip.
 */
export interface RunState {
  sessionId: string
  /** Turns completed so far, for the footer. */
  turns?: number
  /** Cumulative cost, when the provider reports it. */
  totalCost?: number
  output?: { type: 'lastMessage'; value: string }
  /** Groups a saved conversation's runs, for the chat history. */
  traceSessionId?: string
}

/** Whether a file may be read, from `create-run-config`'s sensitive-file rules. */
export type FileFilter = (filePath: string) => {
  status: 'allow' | 'blocked' | 'allow-example'
}

/** A sub-agent definition, as the interface lists them. */
export interface AgentDefinition {
  id: string
  displayName?: string
  model?: string
  toolNames?: string[]
  spawnableAgents?: string[]
  instructionsPrompt?: string
  [key: string]: unknown
}

// ---- print-mode events ----------------------------------------------------
//
// The stream the interface renders. One event per thing that happened, in the
// order it happened.

export interface PrintModeToolCall {
  type: 'tool_call'
  toolCallId: string
  toolName: ToolName
  /** Jean's own name for the tool, before `renameTool` mapped it. */
  sourceToolName?: string
  input: Record<string, unknown> | undefined
  /** Set when the call came from a sub-agent. */
  agentId?: string
  parentAgentId?: string
  /** Whether the raw call is shown as well as its rendering. */
  includeToolCall?: boolean
}

export interface PrintModeToolResult {
  type: 'tool_result'
  toolCallId: string
  output: ToolResultOutput[]
  agentId?: string
  parentAgentId?: string
}

export interface PrintModeSubagentStart {
  type: 'subagent_start'
  agentId: string
  agentType: string
  parentAgentId?: string
  prompt?: string
  /** The spawn's extra arguments, shown in the agent's header. */
  params?: Record<string, unknown>
}

export interface PrintModeSubagentFinish {
  type: 'subagent_finish'
  agentId: string
  agentType: string
  parentAgentId?: string
  output?: unknown
}

export interface PrintModeFinish {
  type: 'finish'
  totalCost?: number
  /** Why the run stopped, so the footer can say something useful. */
  stopReason?: 'complete' | 'max_turns' | 'aborted' | 'error' | 'blocked'
  error?: string
}

export type PrintModeEvent =
  | PrintModeToolCall
  | PrintModeToolResult
  | PrintModeSubagentStart
  | PrintModeSubagentFinish
  | PrintModeFinish

/**
 * A chunk of the model's output as it streams.
 *
 * Three shapes, and the plain string is not an oversight: the renderer treats a
 * bare string as ordinary assistant text at the top level, which is the common
 * case by a wide margin. The tagged forms exist for the two kinds of text that
 * need somewhere else to go — reasoning, which renders collapsed, and output
 * from a sub-agent, which renders under that agent's own block.
 *
 * Sending the wrong shape does not throw. `destinationFromChunkEvent` returns
 * null, the handler logs "unhandled stream chunk" to a file nobody is watching,
 * and the text silently never appears — which is exactly how a failed turn came
 * to look like an agent with nothing to say.
 */
export type StreamChunk =
  | string
  | { type: 'reasoning_chunk'; chunk: string; agentId?: string; ancestorRunIds: string[] }
  | { type: 'subagent_chunk'; chunk: string; agentId: string }

/** Everything one run needs. */
export interface RunConfig {
  logger: Logger
  agent: AgentDefinition | string
  prompt: string
  content: MessageContent[] | undefined
  previousRun?: RunState
  agentDefinitions: AgentDefinition[]
  maxAgentSteps: number
  handleStreamChunk: (chunk: StreamChunk) => void
  handleEvent: (event: PrintModeEvent) => void
  signal: AbortSignal
  costMode?: 'free' | 'lite' | 'normal' | 'max' | 'experimental' | 'ask'
  /**
   * What the interface's mode asks of this turn (`utils/agent-selection.ts`);
   * an absent field keeps the configured value.
   */
  modeSettings?: {
    effort?: 'fast' | 'normal' | 'high' | 'xhigh'
    permissionMode?: 'auto' | 'ask' | 'plan' | 'full'
  }
  extraCodebuffMetadata?: Record<string, string>
  fileFilter?: FileFilter
}

/**
 * The logging surface the interface passes around.
 *
 * Structured-first (`logger.error({ err }, 'message')`) because that is how
 * every call site already reads.
 */
export interface Logger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/** A file in the project tree, for the picker and `@`-completion. */
export interface FileTreeNode {
  name: string
  type: 'file' | 'directory'
  filePath: string
  children?: FileTreeNode[]
}

export interface PathInfo {
  path: string
  type: 'file' | 'directory'
}

/** A skill, as listed in the picker. */
export interface SkillDefinition {
  name: string
  description: string
  path?: string
}

export type SkillsMap = Record<string, SkillDefinition>

/** An MCP server entry, from the config. */
export interface MCPConfig {
  mcpServers?: Record<string, { command?: string; args?: string[]; url?: string }>
}
