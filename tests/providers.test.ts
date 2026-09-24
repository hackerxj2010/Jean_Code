import { afterEach, describe, expect, test } from 'bun:test'
import { toWireMessages as anthropicWire } from '../packages/model/src/providers/anthropic.ts'
import {
  AnthropicProvider,
  OpenAICompatibleProvider,
} from '../packages/model/src/providers/index.ts'
import {
  needsBreakpoints,
  toWireMessages as openaiWire,
} from '../packages/model/src/providers/openai-compatible.ts'
import type { Message, StreamEvent } from '../packages/model/src/types.ts'

/**
 * Provider wire formats.
 *
 * These are where a harness silently loses money or breaks sessions: a
 * missing cache breakpoint costs the full input price on every turn, and a
 * dropped thinking signature makes Anthropic reject the next request. Neither
 * shows up as a wrong answer — only as a bill or an error much later — so both
 * are pinned here.
 */

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Replaces fetch with one that streams the given SSE frames and records the body. */
function mockSSE(frames: unknown[]): { bodies: unknown[] } {
  const bodies: unknown[] = []
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body))
    const text = frames
      .map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`)
      .join('')
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  return { bodies }
}

async function drain(stream: AsyncGenerator<StreamEvent, void, void>) {
  const events: StreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

const conversation: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'first question' }] },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', text: 'let me look', signature: 'sig-abc' },
      { type: 'tool_call', id: 't1', name: 'read', input: { path: 'a.ts' } },
    ],
  },
  { role: 'tool', content: [{ type: 'tool_result', id: 't1', name: 'read', output: 'contents' }] },
  { role: 'user', content: [{ type: 'text', text: 'follow up' }] },
]

describe('anthropic wire format', () => {
  test('replays signed thinking on the assistant turn, first', () => {
    const wire = anthropicWire(conversation) as {
      role: string
      content: Record<string, unknown>[]
    }[]
    const assistant = wire.find((m) => m.role === 'assistant')!
    expect(assistant.content[0]).toEqual({
      type: 'thinking',
      thinking: 'let me look',
      signature: 'sig-abc',
    })
    expect(assistant.content[1]!.type).toBe('tool_use')
  })

  test('drops unsigned reasoning, which Anthropic would reject', () => {
    const wire = anthropicWire([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'from another provider' },
          { type: 'text', text: 'a' },
        ],
      },
    ]) as { role: string; content: Record<string, unknown>[] }[]
    expect(wire[1]!.content).toEqual([{ type: 'text', text: 'a' }])
  })

  test('replays redacted thinking as redacted', () => {
    const wire = anthropicWire([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: '', redacted: 'opaque' },
          { type: 'text', text: 'a' },
        ],
      },
    ]) as { role: string; content: Record<string, unknown>[] }[]
    expect(wire[1]!.content[0]).toEqual({ type: 'redacted_thinking', data: 'opaque' })
  })

  test('puts cache breakpoints on the last two user messages', () => {
    const wire = anthropicWire(conversation, { cache: true }) as {
      role: string
      content: Record<string, unknown>[]
    }[]
    const marked = wire.flatMap((m) => m.content).filter((b) => b.cache_control)
    expect(marked).toHaveLength(2)
    // The tool result and the follow-up merge into one user message, so the
    // two user messages are the opening question and that merged one — each
    // marked on its last block.
    expect(marked[0]).toMatchObject({ type: 'text', text: 'first question' })
    expect(marked[1]).toMatchObject({ type: 'text', text: 'follow up' })
  })

  test('adds no breakpoints when caching is off', () => {
    const wire = JSON.stringify(anthropicWire(conversation))
    expect(wire).not.toContain('cache_control')
  })

  test('the request caches the system prompt', async () => {
    const { bodies } = mockSSE([
      { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 10 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    ])
    const provider = new AnthropicProvider({ apiKey: 'test' })
    await drain(provider.stream('claude', { messages: conversation, system: 'be good' }))
    expect((bodies[0] as { system: unknown }).system).toEqual([
      { type: 'text', text: 'be good', cache_control: { type: 'ephemeral' } },
    ])
  })

  test('streams the thinking signature and cache usage', async () => {
    mockSSE([
      {
        type: 'message_start',
        message: {
          model: 'claude',
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 50,
          },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'SIG' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    ])
    const provider = new AnthropicProvider({ apiKey: 'test' })
    const events = await drain(provider.stream('claude', { messages: conversation }))
    const done = events.find((e) => e.type === 'done') as Extract<StreamEvent, { type: 'done' }>
    expect(done.response.content[0]).toEqual({ type: 'thinking', text: 'hmm', signature: 'SIG' })
    expect(done.response.usage).toMatchObject({
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
      outputTokens: 3,
    })
  })

  test('a tool call cut off by max_tokens is reported as truncated', async () => {
    mockSSE([
      { type: 'message_start', message: { model: 'claude', usage: {} } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'x', name: 'write' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":"a' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'max_tokens' },
        usage: { output_tokens: 4096 },
      },
    ])
    const provider = new AnthropicProvider({ apiKey: 'test' })
    const events = await drain(provider.stream('claude', { messages: conversation }))
    const done = events.find((e) => e.type === 'done') as Extract<StreamEvent, { type: 'done' }>
    expect(done.response.stopReason).toBe('length')
  })
})

describe('openai-compatible wire format', () => {
  test('recognises Anthropic models behind a router', () => {
    expect(needsBreakpoints('anthropic/claude-sonnet-4.5')).toBe(true)
    expect(needsBreakpoints('openai/gpt-5')).toBe(false)
    expect(needsBreakpoints('deepseek/deepseek-chat')).toBe(false)
  })

  test('marks the system prompt and the last user message when caching', () => {
    const wire = openaiWire(conversation, 'system text', { cache: true })
    expect(wire[0]!.content).toEqual([
      { type: 'text', text: 'system text', cache_control: { type: 'ephemeral' } },
    ])
    const lastUser = [...wire].reverse().find((m) => m.role === 'user')!
    expect(lastUser.content).toEqual([
      { type: 'text', text: 'follow up', cache_control: { type: 'ephemeral' } },
    ])
    // Tool messages stay plain strings.
    expect(typeof wire.find((m) => m.role === 'tool')!.content).toBe('string')
  })

  test('leaves messages as plain strings without caching', () => {
    const wire = openaiWire(conversation, 'system text')
    expect(wire[0]!.content).toBe('system text')
  })

  function openrouter() {
    return new OpenAICompatibleProvider({
      name: 'openrouter',
      label: 'OpenRouter',
      baseUrl: 'https://example.invalid/v1',
      keyEnv: [],
      cacheBreakpoints: true,
    })
  }

  test('only Claude models get breakpoints through a router', async () => {
    const { bodies } = mockSSE(['[DONE]'])
    await drain(
      openrouter().stream('anthropic/claude-sonnet-4.5', { messages: conversation, system: 's' }),
    )
    await drain(openrouter().stream('openai/gpt-5', { messages: conversation, system: 's' }))
    expect(JSON.stringify(bodies[0])).toContain('cache_control')
    expect(JSON.stringify(bodies[1])).not.toContain('cache_control')
  })

  test('a truncated tool call reports length, and cached tokens are counted', async () => {
    mockSSE([
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'c1', function: { name: 'write', arguments: '{"pa' } }],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      },
      '[DONE]',
    ])
    const events = await drain(openrouter().stream('anthropic/claude', { messages: conversation }))
    const done = events.find((e) => e.type === 'done') as Extract<StreamEvent, { type: 'done' }>
    expect(done.response.stopReason).toBe('length')
    expect(done.response.usage.cacheReadTokens).toBe(80)
  })
})
