import { cleanKey, parseSSE, postJson, postStream } from './http.ts'
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Message,
  Provider,
  StopReason,
  StreamEvent,
  Usage,
} from '../types.ts'
import { ProviderError } from '../types.ts'
import type { OpenAICompatibleConfig } from './openai-compatible.ts'

/**
 * The OpenAI Responses wire format (`/responses`).
 *
 * The API OpenAI builds its newest models for — some of them (the Codex and
 * Pro lines) are served only here — and the one OpenCode Zen serves its GPT
 * models through. It differs from Chat Completions in shape rather than in
 * idea: the transcript is a flat list of *items* (messages, function calls,
 * their outputs, reasoning), the system prompt is `instructions`, and the
 * stream is a sequence of typed `response.*` events.
 *
 * Nothing is stored on OpenAI's side (`store: false`). Reasoning is asked for
 * encrypted instead and handed back on the next turn, so a reasoning model
 * keeps its chain of thought across tool calls without the conversation
 * living on someone else's server.
 */

interface ResponseItem {
  type?: string
  id?: string
  role?: string
  call_id?: string
  name?: string
  arguments?: string
  encrypted_content?: string
  summary?: { type?: string; text?: string }[]
  content?: { type?: string; text?: string }[]
}

interface ResponseObject {
  id?: string
  model?: string
  status?: string
  output?: ResponseItem[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
  }
  incomplete_details?: { reason?: string } | null
  error?: { message?: string; code?: string } | null
}

interface ResponseEvent {
  type?: string
  delta?: string
  item_id?: string
  output_index?: number
  item?: ResponseItem
  response?: ResponseObject
  message?: string
  code?: string
}

export class OpenAIResponsesProvider implements Provider {
  readonly name: string
  readonly label: string
  private readonly config: OpenAICompatibleConfig

  constructor(config: OpenAICompatibleConfig) {
    this.name = config.name
    this.label = config.label
    this.config = config
  }

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
    return `${(this.config.baseUrl ?? '').replace(/\/+$/, '')}/responses`
  }

  private payload(model: string, request: CompletionRequest, stream: boolean): unknown {
    const body: Record<string, unknown> = {
      model,
      input: toResponseItems(request.messages),
      stream,
      store: false,
    }
    if (request.system) body.instructions = request.system
    if (request.maxTokens !== undefined) body.max_output_tokens = request.maxTokens
    // Reasoning models reject `temperature`; it is sent only where the
    // provider says it is understood.
    if (request.temperature !== undefined && this.config.supportsTemperature === true) {
      body.temperature = request.temperature
    }
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
      }))
      body.tool_choice = request.toolChoice ?? 'auto'
    }
    if (request.effort) {
      body.reasoning = { effort: mapEffort(request.effort), summary: 'auto' }
      body.include = ['reasoning.encrypted_content']
    }
    return body
  }

  async complete(model: string, request: CompletionRequest): Promise<CompletionResponse> {
    const started = Date.now()
    const data = await postJson<ResponseObject>(this.url(), this.payload(model, request, false), {
      headers: this.headers(),
      signal: request.signal,
      maxRetries: this.config.maxRetries,
      provider: this.name,
    })
    if (data.error?.message) throw new ProviderError(data.error.message, this.name)

    const content = fromOutput(data.output ?? [])
    return {
      content,
      stopReason: stopReasonOf(data, content),
      usage: mapUsage(data.usage),
      model: data.model ?? model,
      provider: this.name,
      latencyMs: Date.now() - started,
    }
  }

  async *stream(model: string, request: CompletionRequest): AsyncGenerator<StreamEvent, void, void> {
    const started = Date.now()
    const response = await postStream(this.url(), this.payload(model, request, true), {
      headers: this.headers(),
      signal: request.signal,
      maxRetries: this.config.maxRetries,
      provider: this.name,
    })

    // Items finish in `output_item.done` carrying everything they were
    // streamed as; they are kept by position so the transcript keeps the
    // order the model produced them in.
    const done = new Map<number, ResponseItem>()
    let final: ResponseObject | undefined
    let servedModel = model

    for await (const chunk of parseSSE(response)) {
      let event: ResponseEvent
      try {
        event = JSON.parse(chunk) as ResponseEvent
      } catch {
        continue
      }

      switch (event.type) {
        case 'response.created':
        case 'response.in_progress':
          if (event.response?.model) servedModel = event.response.model
          break
        case 'response.output_text.delta':
          if (event.delta) yield { type: 'text', delta: event.delta }
          break
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          if (event.delta) yield { type: 'thinking', delta: event.delta }
          break
        case 'response.output_item.done':
          if (event.item) done.set(event.output_index ?? done.size, event.item)
          break
        case 'response.completed':
        case 'response.incomplete':
          final = event.response
          break
        case 'response.failed':
          yield {
            type: 'error',
            error: new ProviderError(event.response?.error?.message ?? 'the response failed', this.name),
          }
          return
        case 'error':
          yield { type: 'error', error: new ProviderError(event.message ?? event.code ?? 'stream error', this.name) }
          return
      }
    }

    // The completed response lists every item; the streamed ones stand in
    // when a server leaves `output` out of its final event.
    const items = final?.output?.length
      ? final.output
      : [...done.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item)
    const content = fromOutput(items)
    for (const block of content) {
      if (block.type === 'tool_call') yield { type: 'tool_call', id: block.id, name: block.name, input: block.input }
    }

    const usage = mapUsage(final?.usage)
    yield { type: 'usage', usage }
    yield {
      type: 'done',
      response: {
        content,
        stopReason: stopReasonOf(final ?? {}, content),
        usage,
        model: final?.model ?? servedModel,
        provider: this.name,
        latencyMs: Date.now() - started,
      },
    }
  }
}

/**
 * The neutral transcript as Responses input items.
 *
 * An assistant turn becomes its reasoning (when it was kept encrypted), its
 * words, then one `function_call` per tool call; a tool message becomes one
 * `function_call_output` per result.
 */
export function toResponseItems(messages: Message[]): unknown[] {
  const items: unknown[] = []
  for (const message of messages) {
    if (message.role === 'tool') {
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          items.push({ type: 'function_call_output', call_id: block.id, output: block.output })
        }
      }
      continue
    }

    if (message.role === 'assistant') {
      const text: string[] = []
      for (const block of message.content) {
        if (block.type === 'thinking' && block.replay?.format === 'openai-responses') {
          items.push({ type: 'reasoning', id: block.replay.id, encrypted_content: block.replay.data, summary: [] })
        } else if (block.type === 'text' && block.text) {
          text.push(block.text)
        }
      }
      if (text.length > 0) items.push({ role: 'assistant', content: text.join('\n') })
      for (const block of message.content) {
        if (block.type === 'tool_call') {
          items.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          })
        }
      }
      continue
    }

    // User and system messages: text and images as input parts.
    const parts: unknown[] = []
    for (const block of message.content) {
      if (block.type === 'text' && block.text) parts.push({ type: 'input_text', text: block.text })
      else if (block.type === 'image') {
        parts.push({ type: 'input_image', image_url: `data:${block.mediaType};base64,${block.data}` })
      } else if (block.type === 'tool_result') {
        // A result filed under a user message by an older transcript.
        items.push({ type: 'function_call_output', call_id: block.id, output: block.output })
      }
    }
    if (parts.length > 0) items.push({ role: message.role === 'system' ? 'developer' : 'user', content: parts })
  }
  return items
}

/** Output items as neutral content blocks. */
export function fromOutput(items: ResponseItem[]): ContentBlock[] {
  const content: ContentBlock[] = []
  for (const item of items) {
    if (item.type === 'reasoning') {
      const text = (item.summary ?? []).map((part) => part.text ?? '').join('\n')
      const block: ContentBlock = { type: 'thinking', text }
      if (item.id && item.encrypted_content) {
        block.replay = { format: 'openai-responses', id: item.id, data: item.encrypted_content }
      }
      if (text || block.replay) content.push(block)
    } else if (item.type === 'message') {
      const text = (item.content ?? [])
        .filter((part) => part.type === 'output_text' || part.type === 'text')
        .map((part) => part.text ?? '')
        .join('')
      if (text) content.push({ type: 'text', text })
    } else if (item.type === 'function_call') {
      content.push({
        type: 'tool_call',
        id: item.call_id ?? item.id ?? `call_${content.length}`,
        name: item.name ?? '',
        input: parseArguments(item.arguments ?? ''),
      })
    }
  }
  return content
}

function parseArguments(args: string): unknown {
  const trimmed = args.trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    return { _raw: trimmed, _parseError: 'arguments were not valid JSON' }
  }
}

function stopReasonOf(response: ResponseObject, content: ContentBlock[]): StopReason {
  if (response.status === 'incomplete' || response.incomplete_details?.reason) {
    return response.incomplete_details?.reason === 'content_filter' ? 'stop' : 'length'
  }
  return content.some((block) => block.type === 'tool_call') ? 'tool_use' : 'stop'
}

function mapUsage(usage: ResponseObject['usage']): Usage {
  const cached = usage?.input_tokens_details?.cached_tokens
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cachedTokens: cached,
    cacheReadTokens: cached,
  }
}

function mapEffort(effort: 'fast' | 'normal' | 'high' | 'xhigh'): string {
  switch (effort) {
    case 'fast':
      return 'low'
    case 'normal':
      return 'medium'
    case 'high':
      return 'high'
    case 'xhigh':
      return 'xhigh'
  }
}
