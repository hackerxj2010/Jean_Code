import { cleanKey, parseSSE, postJson, postStream } from './http.ts'
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Message,
  Provider,
  ProviderOptions,
  StopReason,
  StreamEvent,
  ToolSchema,
  Usage,
} from '../types.ts'
import { ProviderError } from '../types.ts'

/**
 * The OpenAI Chat Completions wire format.
 *
 * This one adapter covers most of the ecosystem — OpenRouter, OpenAI, Groq,
 * DeepSeek, Together, Fireworks, Cerebras, Mistral, xAI, Ollama, vLLM,
 * llama.cpp — because they all implement `/chat/completions`. Providers differ
 * only in base URL, auth header, and a few extra fields, which is what
 * [`OpenAICompatibleProvider`]'s constructor captures.
 */

interface WireMessage {
  role: string
  content: string | unknown[] | null
  tool_calls?: WireToolCall[]
  tool_call_id?: string
  name?: string
}

interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface ChatResponse {
  id?: string
  model?: string
  choices?: {
    message?: WireMessage
    delta?: WireMessage & { reasoning_content?: string; reasoning?: string }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  }
  error?: { message?: string }
}

export interface OpenAICompatibleConfig extends ProviderOptions {
  name: string
  label: string
  baseUrl: string
  /** Env vars probed for the key, in order. Empty means no auth needed. */
  keyEnv?: string[]
  /** Extra headers, e.g. OpenRouter's attribution pair. */
  extraHeaders?: Record<string, string>
  /** Some providers reject `temperature` on reasoning models. */
  supportsTemperature?: boolean
  /** Maps Jean's effort levels onto the provider's own field, if it has one. */
  effortField?: 'reasoning_effort' | 'reasoning'
  /**
   * Forwards explicit cache breakpoints for models that need them.
   *
   * OpenAI, DeepSeek, and Gemini cache automatically; Anthropic models behind
   * a router do not, and without breakpoints every turn of an agent loop is
   * billed and processed as if the whole transcript were new.
   */
  cacheBreakpoints?: boolean
}

export class OpenAICompatibleProvider implements Provider {
  readonly name: string
  readonly label: string
  private readonly config: OpenAICompatibleConfig

  constructor(config: OpenAICompatibleConfig) {
    this.name = config.name
    this.label = config.label
    this.config = config
  }

  /** The resolved key: explicit option first, then the provider's env vars. */
  private key(): string | undefined {
    const explicit = cleanKey(this.config.apiKey)
    if (explicit) return explicit
    for (const name of this.config.keyEnv ?? []) {
      const value = cleanKey(process.env[name])
      if (value) return value
    }
    return undefined
  }

  isConfigured(): boolean {
    // Local runtimes (Ollama, vLLM) advertise no key env and are always ready.
    if ((this.config.keyEnv ?? []).length === 0) return true
    return this.key() !== undefined
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { ...this.config.extraHeaders, ...this.config.headers }
    const key = this.key()
    if (key) headers.authorization = `Bearer ${key}`
    return headers
  }

  private url(): string {
    const base = (this.config.baseUrl ?? '').replace(/\/+$/, '')
    return `${base}/chat/completions`
  }

  private payload(model: string, request: CompletionRequest, stream: boolean): unknown {
    const cache =
      request.cache !== false && this.config.cacheBreakpoints === true && needsBreakpoints(model)
    const body: Record<string, unknown> = {
      model,
      messages: toWireMessages(request.messages, request.system, { cache }),
      stream,
    }
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
    if (request.temperature !== undefined && this.config.supportsTemperature !== false) {
      body.temperature = request.temperature
    }
    if (request.stop?.length) body.stop = request.stop
    if (request.tools?.length) {
      body.tools = request.tools.map(toWireTool)
      body.tool_choice = request.toolChoice ?? 'auto'
    }
    if (stream) body.stream_options = { include_usage: true }
    if (request.effort && this.config.effortField) {
      body[this.config.effortField] = mapEffort(request.effort)
    }
    return body
  }

  async complete(model: string, request: CompletionRequest): Promise<CompletionResponse> {
    const started = Date.now()
    const data = await postJson<ChatResponse>(this.url(), this.payload(model, request, false), {
      headers: this.headers(),
      signal: request.signal,
      maxRetries: this.config.maxRetries,
      provider: this.name,
    })

    if (data.error?.message) {
      throw new ProviderError(data.error.message, this.name)
    }
    const choice = data.choices?.[0]
    if (!choice) {
      throw new ProviderError('response contained no choices', this.name)
    }

    return {
      content: fromWireMessage(choice.message ?? {}),
      stopReason: mapStopReason(choice.finish_reason),
      usage: mapUsage(data.usage),
      model: data.model ?? model,
      provider: this.name,
      latencyMs: Date.now() - started,
    }
  }

  async *stream(
    model: string,
    request: CompletionRequest,
  ): AsyncGenerator<StreamEvent, void, void> {
    const started = Date.now()
    const response = await postStream(this.url(), this.payload(model, request, true), {
      headers: this.headers(),
      signal: request.signal,
      maxRetries: this.config.maxRetries,
      provider: this.name,
    })

    let text = ''
    let thinking = ''
    let finish: string | null = null
    let usage: Usage = { inputTokens: 0, outputTokens: 0 }
    let servedModel = model
    // Tool calls stream as fragments indexed by position; assemble then emit.
    const toolCalls = new Map<number, { id: string; name: string; args: string }>()

    for await (const chunk of parseSSE(response)) {
      if (chunk === '[DONE]') break

      let parsed: ChatResponse
      try {
        parsed = JSON.parse(chunk) as ChatResponse
      } catch {
        // A malformed frame is not worth killing a long generation over.
        continue
      }

      if (parsed.error?.message) {
        yield { type: 'error', error: new ProviderError(parsed.error.message, this.name) }
        return
      }
      if (parsed.model) servedModel = parsed.model
      if (parsed.usage) usage = mapUsage(parsed.usage)

      const choice = parsed.choices?.[0]
      if (!choice) continue
      if (choice.finish_reason) finish = choice.finish_reason

      const delta = choice.delta
      if (!delta) continue

      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoning === 'string' && reasoning) {
        thinking += reasoning
        yield { type: 'thinking', delta: reasoning }
      }
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content
        yield { type: 'text', delta: delta.content }
      }

      for (const [index, fragment] of enumerateToolCalls(delta.tool_calls)) {
        const existing = toolCalls.get(index) ?? { id: '', name: '', args: '' }
        toolCalls.set(index, {
          id: fragment.id || existing.id,
          name: fragment.function?.name || existing.name,
          args: existing.args + (fragment.function?.arguments ?? ''),
        })
      }
    }

    const content: ContentBlock[] = []
    if (thinking) content.push({ type: 'thinking', text: thinking })
    if (text) content.push({ type: 'text', text })

    for (const [index, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      const id = call.id || `call_${index}`
      const input = parseArguments(call.args)
      content.push({ type: 'tool_call', id, name: call.name, input })
      yield { type: 'tool_call', id, name: call.name, input }
    }

    yield { type: 'usage', usage }
    yield {
      type: 'done',
      response: {
        content,
        // A call cut off by the token limit is still a tool call, and the one
        // case where reporting `length` rather than `tool_use` matters.
        stopReason:
          mapStopReason(finish) === 'length'
            ? 'length'
            : toolCalls.size > 0
              ? 'tool_use'
              : mapStopReason(finish),
        usage,
        model: servedModel,
        provider: this.name,
        latencyMs: Date.now() - started,
      },
    }
  }
}

function enumerateToolCalls(
  calls: WireToolCall[] | undefined,
): [number, Partial<WireToolCall>][] {
  if (!calls) return []
  return calls.map((call, i) => {
    // Streaming fragments carry their own index; non-streaming ones do not.
    const index = (call as WireToolCall & { index?: number }).index ?? i
    return [index, call]
  })
}

/**
 * Tool arguments arrive as a JSON string. A model can emit a truncated or
 * slightly malformed one; returning the raw text under `_raw` lets the tool
 * layer produce a useful error instead of the loop dying here.
 */
function parseArguments(args: string): unknown {
  const trimmed = args.trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    return { _raw: trimmed, _parseError: 'arguments were not valid JSON' }
  }
}

function toWireTool(tool: ToolSchema): unknown {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

/** Model ids served by Anthropic, which cache only at explicit breakpoints. */
export function needsBreakpoints(model: string): boolean {
  return /(^|\/)anthropic\/|claude/i.test(model)
}

const EPHEMERAL = { type: 'ephemeral' } as const

/**
 * Translates neutral messages into the Chat Completions array.
 *
 * With `cache`, the system prompt and the most recent user message carry
 * `cache_control` on a text part — the form routers forward to Anthropic.
 * Tool-role messages are left as plain strings: not every router accepts parts
 * there, and a rejected request costs far more than a missed cache hit.
 */
export function toWireMessages(
  messages: Message[],
  system?: string,
  options: { cache?: boolean } = {},
): WireMessage[] {
  const out: WireMessage[] = []
  if (system) {
    out.push({
      role: 'system',
      content: options.cache
        ? [{ type: 'text', text: system, cache_control: EPHEMERAL }]
        : system,
    })
  }

  for (const message of messages) {
    if (message.role === 'tool') {
      // Each tool result is its own message, keyed to the call it answers.
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: block.id, name: block.name, content: block.output })
        }
      }
      continue
    }

    const texts: string[] = []
    const images: unknown[] = []
    const toolCalls: WireToolCall[] = []

    for (const block of message.content) {
      if (block.type === 'text') texts.push(block.text)
      else if (block.type === 'tool_call') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        })
      } else if (block.type === 'image') {
        images.push({
          type: 'image_url',
          image_url: { url: `data:${block.mediaType};base64,${block.data}` },
        })
      }
      // `thinking` blocks are dropped: they are provider-internal and replaying
      // them as assistant text confuses the next turn.
    }

    const text = texts.join('\n')
    const wire: WireMessage = {
      role: message.role,
      content: images.length > 0 ? [{ type: 'text', text }, ...images] : text || null,
    }
    if (toolCalls.length > 0) wire.tool_calls = toolCalls
    out.push(wire)
  }

  if (options.cache) {
    for (let i = out.length - 1; i >= 0; i--) {
      const message = out[i]!
      if (message.role !== 'user' || message.content === null) continue
      const parts =
        typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : [...(message.content as Record<string, unknown>[])]
      const lastText = parts.map((p) => (p as { type?: string }).type).lastIndexOf('text')
      if (lastText === -1) break
      parts[lastText] = { ...(parts[lastText] as object), cache_control: EPHEMERAL }
      message.content = parts
      break
    }
  }

  return out
}

function fromWireMessage(message: Partial<WireMessage>): ContentBlock[] {
  const content: ContentBlock[] = []

  const reasoning = (message as { reasoning_content?: string; reasoning?: string })
  if (reasoning.reasoning_content || reasoning.reasoning) {
    content.push({ type: 'thinking', text: reasoning.reasoning_content ?? reasoning.reasoning ?? '' })
  }
  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content })
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
        content.push({ type: 'text', text: String((part as { text?: string }).text ?? '') })
      }
    }
  }
  for (const call of message.tool_calls ?? []) {
    content.push({
      type: 'tool_call',
      id: call.id,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
    })
  }
  return content
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'length':
    case 'max_tokens':
      return 'length'
    case 'stop':
    case 'end_turn':
    case null:
    case undefined:
      return 'stop'
    default:
      return 'stop'
  }
}

function mapUsage(usage: ChatResponse['usage']): Usage {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens,
    cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens,
    cacheWriteTokens: usage?.prompt_tokens_details?.cache_write_tokens,
  }
}

function mapEffort(effort: 'fast' | 'normal' | 'high' | 'xhigh'): string {
  switch (effort) {
    case 'fast':
      return 'low'
    case 'normal':
      return 'medium'
    case 'high':
    case 'xhigh':
      return 'high'
  }
}
