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
  Usage,
} from '../types.ts'
import { ProviderError } from '../types.ts'

/**
 * Anthropic Messages API adapter.
 *
 * Distinct enough from the OpenAI shape to need its own file: `system` is a
 * top-level field rather than a message, tool results ride inside *user*
 * messages, and thinking is a first-class content block.
 */

const DEFAULT_BASE = 'https://api.anthropic.com/v1'
const API_VERSION = '2023-06-01'

interface WireBlock {
  type: string
  text?: string
  thinking?: string
  signature?: string
  data?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

interface MessagesResponse {
  content?: WireBlock[]
  model?: string
  stop_reason?: string | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  error?: { message?: string; type?: string }
}

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic'
  readonly label = 'Anthropic'

  constructor(private readonly options: ProviderOptions = {}) {}

  private key(): string | undefined {
    return cleanKey(this.options.apiKey) ?? cleanKey(process.env.ANTHROPIC_API_KEY)
  }

  isConfigured(): boolean {
    return this.key() !== undefined
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'anthropic-version': API_VERSION,
      ...this.options.headers,
    }
    const key = this.key()
    if (key) headers['x-api-key'] = key
    return headers
  }

  private url(): string {
    return `${(this.options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')}/messages`
  }

  private payload(model: string, request: CompletionRequest, stream: boolean): unknown {
    const cache = request.cache !== false
    const body: Record<string, unknown> = {
      model,
      messages: toWireMessages(request.messages, { cache }),
      // Anthropic requires max_tokens; 4096 is a safe floor if a caller omits it.
      max_tokens: request.maxTokens ?? 4096,
      stream,
    }
    if (request.system) {
      // A breakpoint on the system prompt caches the tools too: the cache
      // prefix is tools, then system, then messages.
      body.system = cache
        ? [{ type: 'text', text: request.system, cache_control: EPHEMERAL }]
        : request.system
    }
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.stop?.length) body.stop_sequences = request.stop
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }))
    }

    // Extended thinking has a floor of 1024 budget tokens and must leave room
    // for the answer, so the budget is derived from max_tokens rather than set
    // independently.
    const budget = thinkingBudget(request.effort, (body.max_tokens as number) ?? 4096)
    if (budget) {
      body.thinking = { type: 'enabled', budget_tokens: budget }
      // Temperature must be unset when thinking is on.
      delete body.temperature
    }

    return body
  }

  async complete(model: string, request: CompletionRequest): Promise<CompletionResponse> {
    const started = Date.now()
    const data = await postJson<MessagesResponse>(
      this.url(),
      this.payload(model, request, false),
      {
        headers: this.headers(),
        signal: request.signal,
        maxRetries: this.options.maxRetries,
        provider: this.name,
      },
    )

    if (data.error?.message) throw new ProviderError(data.error.message, this.name)

    return {
      content: fromWireBlocks(data.content ?? []),
      stopReason: mapStopReason(data.stop_reason),
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
      maxRetries: this.options.maxRetries,
      provider: this.name,
    })

    const blocks: ContentBlock[] = []
    let usage: Usage = { inputTokens: 0, outputTokens: 0 }
    let servedModel = model
    let stopReason: StopReason = 'stop'
    // Anthropic streams block-by-block, keyed by index.
    const partial = new Map<
      number,
      { type: string; text: string; id?: string; name?: string; signature?: string; data?: string }
    >()

    for await (const chunk of parseSSE(response)) {
      let event: Record<string, any>
      try {
        event = JSON.parse(chunk)
      } catch {
        continue
      }

      switch (event.type) {
        case 'message_start': {
          const message = event.message ?? {}
          if (message.model) servedModel = message.model
          usage = mapUsage(message.usage)
          break
        }
        case 'content_block_start': {
          const block = event.content_block ?? {}
          partial.set(event.index ?? 0, {
            type: block.type,
            text: '',
            id: block.id,
            name: block.name,
            data: typeof block.data === 'string' ? block.data : undefined,
          })
          break
        }
        case 'content_block_delta': {
          const index = event.index ?? 0
          const current = partial.get(index)
          if (!current) break
          const delta = event.delta ?? {}
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            current.text += delta.text
            yield { type: 'text', delta: delta.text }
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            current.text += delta.thinking
            yield { type: 'thinking', delta: delta.thinking }
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            current.text += delta.partial_json
          } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
            current.signature = (current.signature ?? '') + delta.signature
          }
          break
        }
        case 'content_block_stop': {
          const index = event.index ?? 0
          const current = partial.get(index)
          if (!current) break
          if (current.type === 'text') {
            blocks.push({ type: 'text', text: current.text })
          } else if (current.type === 'thinking') {
            blocks.push({ type: 'thinking', text: current.text, signature: current.signature })
          } else if (current.type === 'redacted_thinking') {
            blocks.push({ type: 'thinking', text: '', redacted: current.data })
          } else if (current.type === 'tool_use') {
            const input = current.text ? safeParse(current.text) : {}
            const id = current.id ?? `call_${index}`
            const name = current.name ?? 'unknown'
            blocks.push({ type: 'tool_call', id, name, input })
            yield { type: 'tool_call', id, name, input }
          }
          partial.delete(index)
          break
        }
        case 'message_delta': {
          if (event.delta?.stop_reason) stopReason = mapStopReason(event.delta.stop_reason)
          if (event.usage?.output_tokens !== undefined) {
            usage = { ...usage, outputTokens: event.usage.output_tokens }
          }
          break
        }
        case 'error': {
          yield {
            type: 'error',
            error: new ProviderError(event.error?.message ?? 'stream error', this.name),
          }
          return
        }
      }
    }

    yield { type: 'usage', usage }
    yield {
      type: 'done',
      response: {
        content: blocks,
        // `length` wins over `tool_use`: a response cut off mid-call has a
        // tool call in it, and it is exactly the case that must be reported
        // as truncated.
        stopReason:
          stopReason === 'length'
            ? 'length'
            : blocks.some((b) => b.type === 'tool_call')
              ? 'tool_use'
              : stopReason,
        usage,
        model: servedModel,
        provider: this.name,
        latencyMs: Date.now() - started,
      },
    }
  }
}

const EPHEMERAL = { type: 'ephemeral' } as const

/**
 * Translates neutral messages into Anthropic's array.
 *
 * The important asymmetry: tool *results* are user-role blocks, and consecutive
 * results must be merged into one user message or the API rejects the turn.
 *
 * With `cache`, the last block of each of the final two user messages carries a
 * cache breakpoint. Two, not one: the newest breakpoint covers this request,
 * and the one before it is what the *next* request will hit — its prefix is
 * this request's prefix plus one turn. Together with the system breakpoint
 * that is three of the four Anthropic allows.
 */
export function toWireMessages(messages: Message[], options: { cache?: boolean } = {}): unknown[] {
  const out: { role: 'user' | 'assistant'; content: WireBlock[] }[] = []

  for (const message of messages) {
    if (message.role === 'system') continue // carried in the top-level field

    const role: 'user' | 'assistant' = message.role === 'assistant' ? 'assistant' : 'user'
    const blocks: WireBlock[] = []

    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          if (block.text) blocks.push({ type: 'text', text: block.text })
          break
        case 'tool_call':
          blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} })
          break
        case 'tool_result':
          blocks.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: block.output,
            is_error: block.isError,
          })
          break
        case 'image':
          blocks.push({
            type: 'image',
            // @ts-expect-error — Anthropic's image block carries a `source`.
            source: { type: 'base64', media_type: block.mediaType, data: block.data },
          })
          break
        case 'thinking':
          // Only Anthropic's own signed thinking is replayed, and only on the
          // assistant side. Unsigned reasoning from another provider would be
          // rejected, and it adds nothing the model needs.
          if (role !== 'assistant') break
          if (block.redacted) {
            blocks.push({ type: 'redacted_thinking', data: block.redacted } as WireBlock)
          } else if (block.signature) {
            blocks.push({ type: 'thinking', thinking: block.text, signature: block.signature } as WireBlock)
          }
          break
      }
    }

    if (blocks.length === 0) continue

    const previous = out[out.length - 1]
    if (previous && previous.role === role) {
      previous.content.push(...blocks)
    } else {
      out.push({ role, content: blocks })
    }
  }

  if (options.cache) {
    let marked = 0
    for (let i = out.length - 1; i >= 0 && marked < 2; i--) {
      const message = out[i]!
      if (message.role !== 'user') continue
      const last = message.content[message.content.length - 1]
      if (!last) continue
      ;(last as WireBlock & { cache_control?: typeof EPHEMERAL }).cache_control = EPHEMERAL
      marked++
    }
  }

  return out
}

function fromWireBlocks(blocks: WireBlock[]): ContentBlock[] {
  const out: ContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'text' && block.text) out.push({ type: 'text', text: block.text })
    else if (block.type === 'thinking' && block.thinking) {
      out.push({ type: 'thinking', text: block.thinking, signature: block.signature })
    } else if (block.type === 'redacted_thinking' && block.data) {
      out.push({ type: 'thinking', text: '', redacted: block.data })
    } else if (block.type === 'tool_use') {
      out.push({
        type: 'tool_call',
        id: block.id ?? 'call_0',
        name: block.name ?? 'unknown',
        input: block.input ?? {},
      })
    }
  }
  return out
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'length'
    default:
      return 'stop'
  }
}

function mapUsage(usage: MessagesResponse['usage']): Usage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cachedTokens: usage?.cache_read_input_tokens,
    cacheReadTokens: usage?.cache_read_input_tokens,
    cacheWriteTokens: usage?.cache_creation_input_tokens,
  }
}

/** Thinking budget by effort, or `undefined` when thinking stays off. */
function thinkingBudget(
  effort: CompletionRequest['effort'],
  maxTokens: number,
): number | undefined {
  if (!effort || effort === 'fast' || effort === 'normal') return undefined
  const requested = effort === 'high' ? 8192 : 16384
  // Must leave room for the response itself.
  const budget = Math.min(requested, Math.floor(maxTokens * 0.75))
  return budget >= 1024 ? budget : undefined
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { _raw: text, _parseError: 'tool input was not valid JSON' }
  }
}
