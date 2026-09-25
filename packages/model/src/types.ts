/**
 * Model layer types.
 *
 * One neutral message/response shape that every provider adapter translates to
 * and from. Agents never see a provider's wire format.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** A block inside a message. Text and tool traffic are first-class. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'thinking'
      text: string
      /**
       * Anthropic's integrity signature. A signed thinking block must be sent
       * back unchanged when a tool-use turn continues with thinking enabled —
       * the API rejects the request otherwise.
       */
      signature?: string
      /** Encrypted thinking the provider redacted; replayed as-is. */
      redacted?: string
      /**
       * Reasoning another wire format keeps encrypted and wants back on the
       * next turn — OpenAI's Responses reasoning items. Only the adapter of
       * that format replays it; every other one ignores it.
       */
      replay?: { format: 'openai-responses'; id: string; data: string }
    }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; output: string; isError?: boolean }
  | { type: 'image'; mediaType: string; data: string }

export interface Message {
  role: Role
  content: ContentBlock[]
  /** Wall-clock time the message entered the transcript. */
  timestamp?: number
}

/** A tool as advertised to the model. */
export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema for the tool's arguments. */
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface CompletionRequest {
  messages: Message[]
  system?: string
  tools?: ToolSchema[]
  /**
   * `none` keeps the tools visible — a transcript holding tool calls needs
   * them defined — but asks for an answer in words: a final report.
   */
  toolChoice?: 'auto' | 'none'
  maxTokens?: number
  temperature?: number
  /** Reasoning depth for models that expose it. */
  effort?: 'fast' | 'normal' | 'high' | 'xhigh'
  stop?: string[]
  signal?: AbortSignal
  /**
   * Mark stable prefixes (tools, system prompt, recent history) as cacheable,
   * on providers that need explicit breakpoints. Default on: an agent loop
   * resends the same prefix every turn, and caching it cuts both cost and
   * time-to-first-token on every turn after the first.
   */
  cache?: boolean
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** Tokens served from the provider's prompt cache, when reported. */
  cachedTokens?: number
  /** Input tokens read from the prompt cache (billed at a fraction of input). */
  cacheReadTokens?: number
  /** Input tokens written to the prompt cache (billed at a premium, once). */
  cacheWriteTokens?: number
}

export type StopReason = 'stop' | 'length' | 'tool_use' | 'error' | 'aborted'

export interface CompletionResponse {
  content: ContentBlock[]
  stopReason: StopReason
  usage: Usage
  /** The model that actually served the request — may be a fallback. */
  model: string
  provider: string
  /** Milliseconds from request to final chunk. */
  latencyMs: number
}

/** Incremental events emitted while a completion streams. */
export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; response: CompletionResponse }
  | { type: 'error'; error: Error }

/** What a provider adapter must implement. */
export interface Provider {
  readonly name: string
  /** Human-readable label for the TUI. */
  readonly label: string
  /** True when this provider has usable credentials. */
  isConfigured(): boolean
  complete(model: string, request: CompletionRequest): Promise<CompletionResponse>
  stream(model: string, request: CompletionRequest): AsyncGenerator<StreamEvent, void, void>
}

export interface ProviderOptions {
  apiKey?: string
  baseUrl?: string
  headers?: Record<string, string>
  /** Overrides the default retry budget for transient failures. */
  maxRetries?: number
  /**
   * The provider this adapter serves, when it is not the wire format's own
   * vendor — Claude through OpenCode Zen speaks Anthropic's format under
   * the name `opencode`, with Zen's key.
   */
  name?: string
  label?: string
  /** Env vars probed for the key, in order, in place of the vendor's own. */
  keyEnv?: string[]
}

/** Which wire format a model is spoken to in. */
export type ModelApi = 'chat' | 'responses' | 'anthropic' | 'google'

/** An entry in the model catalog. */
export interface ModelInfo {
  id: string
  provider: string
  label: string
  contextWindow: number
  maxOutput: number
  /** USD per million tokens. */
  inputCost?: number
  outputCost?: number
  /** USD per million tokens read from, and written to, the prompt cache. */
  cacheReadCost?: number
  cacheWriteCost?: number
  supportsTools: boolean
  supportsVision: boolean
  supportsThinking: boolean
  /** Costs nothing to use. */
  free?: boolean
  /** Reasoning effort levels the model accepts, when it names them. */
  reasoningLevels?: string[]
  /** `alpha`, `beta`, or `deprecated`; absent for a generally available model. */
  status?: string
  /** `YYYY-MM-DD`. */
  releaseDate?: string
  /** The wire format this model needs when it differs from its provider's. */
  api?: ModelApi
}

/** Raised when a provider rejects a request. Carries retry information. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
