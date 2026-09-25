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
 * Google Gemini `generateContent` adapter.
 *
 * Gemini's shape differs on every axis that matters: messages are `contents`
 * with `parts`, the assistant role is `model`, tools are grouped under a single
 * `functionDeclarations` array, and the key goes in a query parameter.
 */

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta'

interface WirePart {
  text?: string
  thought?: boolean
  functionCall?: { name: string; args?: unknown }
  functionResponse?: { name: string; response: unknown }
  inlineData?: { mimeType: string; data: string }
}

interface GenerateResponse {
  candidates?: {
    content?: { parts?: WirePart[]; role?: string }
    finishReason?: string
  }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
  }
  error?: { message?: string }
}

export class GoogleProvider implements Provider {
  readonly name: string
  readonly label: string

  constructor(private readonly options: ProviderOptions = {}) {
    this.name = options.name ?? 'google'
    this.label = options.label ?? 'Google Gemini'
  }

  private key(): string | undefined {
    const explicit = cleanKey(this.options.apiKey)
    if (explicit) return explicit
    for (const name of this.options.keyEnv ?? ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']) {
      const value = cleanKey(process.env[name])
      if (value) return value
    }
    return undefined
  }

  isConfigured(): boolean {
    return this.key() !== undefined
  }

  private url(model: string, stream: boolean): string {
    const base = (this.options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')
    const method = stream ? 'streamGenerateContent' : 'generateContent'
    const query = stream ? '?alt=sse' : ''
    return `${base}/models/${encodeURIComponent(model)}:${method}${query}`
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { ...this.options.headers }
    const key = this.key()
    // The key goes in a header rather than the query string so it never lands
    // in a proxy log or an error message that echoes the URL.
    if (key) headers['x-goog-api-key'] = key
    return headers
  }

  private payload(request: CompletionRequest): unknown {
    const body: Record<string, unknown> = {
      contents: toWireContents(request.messages),
      generationConfig: {
        maxOutputTokens: request.maxTokens,
        temperature: request.temperature,
        stopSequences: request.stop,
      },
    }
    if (request.system) {
      body.systemInstruction = { parts: [{ text: request.system }] }
    }
    if (request.tools?.length) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: stripUnsupportedSchema(tool.parameters),
          })),
        },
      ]
      if (request.toolChoice === 'none') body.toolConfig = { functionCallingConfig: { mode: 'NONE' } }
    }
    return body
  }

  async complete(model: string, request: CompletionRequest): Promise<CompletionResponse> {
    const started = Date.now()
    const data = await postJson<GenerateResponse>(this.url(model, false), this.payload(request), {
      headers: this.headers(),
      signal: request.signal,
      maxRetries: this.options.maxRetries,
      provider: this.name,
    })

    if (data.error?.message) throw new ProviderError(data.error.message, this.name)
    const candidate = data.candidates?.[0]
    if (!candidate) throw new ProviderError('response contained no candidates', this.name)

    const content = fromWireParts(candidate.content?.parts ?? [])
    return {
      content,
      stopReason: content.some((b) => b.type === 'tool_call')
        ? 'tool_use'
        : mapStopReason(candidate.finishReason),
      usage: mapUsage(data.usageMetadata),
      model,
      provider: this.name,
      latencyMs: Date.now() - started,
    }
  }

  async *stream(
    model: string,
    request: CompletionRequest,
  ): AsyncGenerator<StreamEvent, void, void> {
    const started = Date.now()
    const response = await postStream(this.url(model, true), this.payload(request), {
      headers: this.headers(),
      signal: request.signal,
      maxRetries: this.options.maxRetries,
      provider: this.name,
    })

    let text = ''
    let thinking = ''
    const toolCalls: ContentBlock[] = []
    let usage: Usage = { inputTokens: 0, outputTokens: 0 }
    let finish: string | undefined

    for await (const chunk of parseSSE(response)) {
      let parsed: GenerateResponse
      try {
        parsed = JSON.parse(chunk) as GenerateResponse
      } catch {
        continue
      }
      if (parsed.error?.message) {
        yield { type: 'error', error: new ProviderError(parsed.error.message, this.name) }
        return
      }
      if (parsed.usageMetadata) usage = mapUsage(parsed.usageMetadata)

      const candidate = parsed.candidates?.[0]
      if (!candidate) continue
      if (candidate.finishReason) finish = candidate.finishReason

      for (const part of candidate.content?.parts ?? []) {
        if (part.functionCall) {
          const block: ContentBlock = {
            type: 'tool_call',
            id: `call_${toolCalls.length}`,
            name: part.functionCall.name,
            input: part.functionCall.args ?? {},
          }
          toolCalls.push(block)
          yield { type: 'tool_call', id: block.id, name: block.name, input: block.input }
        } else if (typeof part.text === 'string' && part.text) {
          if (part.thought) {
            thinking += part.text
            yield { type: 'thinking', delta: part.text }
          } else {
            text += part.text
            yield { type: 'text', delta: part.text }
          }
        }
      }
    }

    const content: ContentBlock[] = []
    if (thinking) content.push({ type: 'thinking', text: thinking })
    if (text) content.push({ type: 'text', text })
    content.push(...toolCalls)

    yield { type: 'usage', usage }
    yield {
      type: 'done',
      response: {
        content,
        stopReason: toolCalls.length > 0 ? 'tool_use' : mapStopReason(finish),
        usage,
        model,
        provider: this.name,
        latencyMs: Date.now() - started,
      },
    }
  }
}

export function toWireContents(messages: Message[]): unknown[] {
  const out: { role: 'user' | 'model'; parts: WirePart[] }[] = []

  for (const message of messages) {
    if (message.role === 'system') continue
    const role: 'user' | 'model' = message.role === 'assistant' ? 'model' : 'user'
    const parts: WirePart[] = []

    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          if (block.text) parts.push({ text: block.text })
          break
        case 'tool_call':
          parts.push({ functionCall: { name: block.name, args: block.input ?? {} } })
          break
        case 'tool_result':
          parts.push({
            functionResponse: { name: block.name, response: { result: block.output } },
          })
          break
        case 'image':
          parts.push({ inlineData: { mimeType: block.mediaType, data: block.data } })
          break
        case 'thinking':
          break
      }
    }

    if (parts.length === 0) continue
    const previous = out[out.length - 1]
    if (previous && previous.role === role) previous.parts.push(...parts)
    else out.push({ role, parts })
  }

  return out
}

function fromWireParts(parts: WirePart[]): ContentBlock[] {
  const out: ContentBlock[] = []
  let calls = 0
  for (const part of parts) {
    if (part.functionCall) {
      out.push({
        type: 'tool_call',
        id: `call_${calls++}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      })
    } else if (typeof part.text === 'string' && part.text) {
      out.push({ type: part.thought ? 'thinking' : 'text', text: part.text })
    }
  }
  return out
}

/**
 * Gemini rejects JSON Schema keywords it does not implement. Strip them rather
 * than let one unsupported `additionalProperties` fail every tool call.
 */
function stripUnsupportedSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripUnsupportedSchema)
  if (schema === null || typeof schema !== 'object') return schema

  const unsupported = new Set([
    'additionalProperties',
    '$schema',
    'default',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'const',
  ])
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (unsupported.has(key)) continue
    out[key] = stripUnsupportedSchema(value)
  }
  return out
}

function mapStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
      return 'error'
    default:
      return 'stop'
  }
}

function mapUsage(usage: GenerateResponse['usageMetadata']): Usage {
  return {
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
    cachedTokens: usage?.cachedContentTokenCount,
  }
}
