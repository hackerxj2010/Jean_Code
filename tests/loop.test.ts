import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type JeanConfig, defaultConfig } from '../packages/config/src/index.ts'
import {
  EventStore,
  type LoopEvent,
  measureContext,
  renderTranscript,
  runLoop,
  splitForCompaction,
  textOf,
  trimToolResults,
} from '../packages/core/src/index.ts'
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Provider,
  StreamEvent,
} from '../packages/model/src/types.ts'
import {
  Registry,
  type ToolContext,
  builtinTools,
  createSessionState,
} from '../packages/tools/src/index.ts'

/**
 * The agent loop, driven by a scripted provider.
 *
 * A mock provider rather than a live one: the loop's behaviour — how it pairs
 * tool results, when it stops, what it does when a tool fails — has to be
 * deterministic to test at all, and none of it depends on a real model.
 */

const temps: string[] = []

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'jean-loop-'))
  temps.push(dir)
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dir, path), content, 'utf8')
  }
  return dir
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true })
})

/** A provider that replays a fixed script of turns. */
class ScriptedProvider implements Provider {
  readonly name = 'scripted'
  readonly label = 'Scripted'
  /** Requests it received, for asserting on what the loop sent. */
  readonly requests: CompletionRequest[] = []
  private turn = 0

  constructor(private readonly script: ContentBlock[][]) {}

  isConfigured(): boolean {
    return true
  }

  async complete(model: string, request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request)
    const content = this.script[this.turn++] ?? [{ type: 'text', text: 'done' }]
    return {
      content,
      stopReason: content.some((b) => b.type === 'tool_call') ? 'tool_use' : 'stop',
      usage: { inputTokens: 100, outputTokens: 20 },
      model,
      provider: this.name,
      latencyMs: 1,
    }
  }

  async *stream(
    model: string,
    request: CompletionRequest,
  ): AsyncGenerator<StreamEvent, void, void> {
    const response = await this.complete(model, request)
    for (const block of response.content) {
      if (block.type === 'text') yield { type: 'text', delta: block.text }
      if (block.type === 'tool_call') {
        yield { type: 'tool_call', id: block.id, name: block.name, input: block.input }
      }
    }
    yield { type: 'done', response }
  }
}

/** A minimal `ModelClient` shape backed by a scripted provider. */
function scriptedClient(script: ContentBlock[][], config: JeanConfig) {
  const provider = new ScriptedProvider(script)
  return {
    provider,
    client: {
      resolve: () => ({
        role: 'default' as const,
        provider: 'scripted',
        modelId: 'scripted-model',
        maxTokens: 4096,
        fallbacks: [],
      }),
      isConfigured: () => true,
      complete: (request: CompletionRequest) => provider.complete('scripted-model', request),
      stream: (request: CompletionRequest) => provider.stream('scripted-model', request),
    } as never,
    config,
  }
}

function setup(files: Record<string, string> = {}, overrides: Partial<JeanConfig> = {}) {
  const cwd = workspace(files)
  const config: JeanConfig = { ...defaultConfig(), ...overrides }
  const store = new EventStore()
  const registry = new Registry()
  registry.registerAll(builtinTools())
  const toolContext: ToolContext = {
    cwd,
    config,
    session: createSessionState(cwd),
  }
  return { cwd, config, store, registry, toolContext }
}

const call = (id: string, name: string, input: unknown): ContentBlock => ({
  type: 'tool_call',
  id,
  name,
  input,
})

describe('the agent loop', () => {
  test('a malformed tool call is reported, not fatal to the turn', async () => {
    // `summarize` runs on unvalidated arguments so the user can see what the
    // agent is attempting. A `write` with no `path` used to throw there --
    // outside the registry's try/catch -- and kill the whole turn instead of
    // coming back as a tool error the model could correct.
    const { cwd, config, store, registry, toolContext } = setup()
    const { client } = scriptedClient(
      [
        [call('c1', 'write', { content: 'no path given' })],
        [{ type: 'text', text: 'I left out the path.' }],
      ],
      config,
    )

    const result = await runLoop({
      store,
      client,
      registry,
      config,
      toolContext,
      systemPrompt: 'x',
    })

    expect(result.stopReason).toBe('complete')
    expect(result.text).toBe('I left out the path.')

    // The model must be told what was wrong, so its next turn can fix it.
    const toolResult = store.all().find((e) => e.type === 'tool_result')
    expect(toolResult).toBeDefined()
    expect((toolResult as { isError?: boolean }).isError).toBe(true)
    expect((toolResult as { output: string }).output).toContain('path')
    expect(cwd).toBeTruthy()
  })

  test('stops when the model stops calling tools', async () => {
    const { config, store, registry, toolContext } = setup()
    const { client } = scriptedClient([[{ type: 'text', text: 'All done.' }]], config)
    store.append({ type: 'user_message', at: Date.now(), text: 'hello' })

    const result = await runLoop({
      store,
      client,
      registry,
      config,
      toolContext,
      systemPrompt: 'test',
    })

    expect(result.stopReason).toBe('complete')
    expect(result.turns).toBe(1)
    expect(result.text).toBe('All done.')
    expect(result.toolCalls).toBe(0)
  })

  test('runs a tool call and feeds the result back', async () => {
    const { config, store, registry, toolContext } = setup({ 'a.txt': 'file contents here\n' })
    const { client, provider } = scriptedClient(
      [
        [call('c1', 'read', { path: 'a.txt' })],
        [{ type: 'text', text: 'The file says: file contents here' }],
      ],
      config,
    )
    store.append({ type: 'user_message', at: Date.now(), text: 'read a.txt' })

    const result = await runLoop({
      store,
      client,
      registry,
      config,
      toolContext,
      systemPrompt: 'test',
    })

    expect(result.turns).toBe(2)
    expect(result.toolCalls).toBe(1)

    // The second request must carry the tool result, correctly paired.
    const second = provider.requests[1]!
    const toolMessage = second.messages.find((m) => m.role === 'tool')
    expect(toolMessage).toBeDefined()
    const block = toolMessage!.content[0]!
    expect(block.type).toBe('tool_result')
    if (block.type === 'tool_result') {
      expect(block.id).toBe('c1')
      expect(block.output).toContain('file contents here')
    }
  })

  test('records every event in order', async () => {
    const { config, store, registry, toolContext } = setup({ 'a.txt': 'x\n' })
    const { client } = scriptedClient(
      [[call('c1', 'read', { path: 'a.txt' })], [{ type: 'text', text: 'done' }]],
      config,
    )
    store.append({ type: 'user_message', at: Date.now(), text: 'go' })

    await runLoop({ store, client, registry, config, toolContext, systemPrompt: 'test' })

    expect(store.all().map((e) => e.type)).toEqual([
      'user_message',
      'assistant_message',
      'tool_call',
      'tool_result',
      'assistant_message',
    ])
  })

  test('a failing tool does not end the run', async () => {
    const { config, store, registry, toolContext } = setup()
    const { client, provider } = scriptedClient(
      [
        [call('c1', 'read', { path: 'does-not-exist.txt' })],
        [{ type: 'text', text: 'That file is missing.' }],
      ],
      config,
    )
    store.append({ type: 'user_message', at: Date.now(), text: 'read it' })

    const result = await runLoop({
      store,
      client,
      registry,
      config,
      toolContext,
      systemPrompt: 'test',
    })

    expect(result.stopReason).toBe('complete')
    // The agent must see the failure so it can correct.
    const toolMessage = provider.requests[1]!.messages.find((m) => m.role === 'tool')!
    const block = toolMessage.content[0]!
    expect(block.type === 'tool_result' && block.isError).toBe(true)
  })

  test('honours the turn cap', async () => {
    const { config, store, registry, toolContext } = setup({ 'a.txt': 'x\n' })
    // A script that never stops calling tools.
    const script = Array.from({ length: 20 }, (_, i) => [call(`c${i}`, 'read', { path: 'a.txt' })])
    const { client } = scriptedClient(script, config)
    store.append({ type: 'user_message', at: Date.now(), text: 'loop forever' })

    const result = await runLoop({
      store,
      client,
      registry,
      config,
      toolContext,
      systemPrompt: 'test',
      maxTurns: 3,
    })

    expect(result.stopReason).toBe('max_turns')
    expect(result.turns).toBe(3)
  })

  test('stops when the signal aborts', async () => {
    const { config, store, registry, toolContext } = setup({ 'a.txt': 'x\n' })
    const script = Array.from({ length: 10 }, (_, i) => [call(`c${i}`, 'read', { path: 'a.txt' })])
    const { client } = scriptedClient(script, config)
    store.append({ type: 'user_message', at: Date.now(), text: 'go' })

    const controller = new AbortController()
    let turns = 0
    const result = await runLoop({
      store,
      client,
      registry,
      config,
      toolContext,
      systemPrompt: 'test',
      signal: controller.signal,
      onEvent: (event: LoopEvent) => {
        if (event.type === 'turn_start' && ++turns === 2) controller.abort()
      },
    })

    expect(result.stopReason).toBe('aborted')
  })

  test('reports files it changed', async () => {
    const { cwd, config, store, registry, toolContext } = setup()
    const { client } = scriptedClient(
      [
        [call('c1', 'write', { path: 'new.ts', content: 'export const x = 1\n' })],
        [{ type: 'text', text: 'Created it.' }],
      ],
      config,
    )
    store.append({ type: 'user_message', at: Date.now(), text: 'create new.ts' })

    const result = await runLoop({
      store,
      client,
      registry,
      config,
      toolContext,
      systemPrompt: 'test',
    })

    expect(result.files).toHaveLength(1)
    expect(readFileSync(join(cwd, 'new.ts'), 'utf8')).toBe('export const x = 1\n')
  })

  test('a provider failure becomes an error result, not a crash', async () => {
    const { config, store, registry, toolContext } = setup()
    const client = {
      resolve: () => ({
        modelId: 'x',
        provider: 'y',
        maxTokens: 100,
        fallbacks: [],
        role: 'default',
      }),
      // eslint-disable-next-line require-yield
      stream: async function* (): AsyncGenerator<StreamEvent, void, void> {
        throw new Error('provider is down')
      },
    } as never

    store.append({ type: 'user_message', at: Date.now(), text: 'go' })
    const result = await runLoop({
      store,
      client,
      registry,
      config,
      toolContext,
      systemPrompt: 'test',
    })

    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('provider is down')
  })
})

describe('the event store', () => {
  test('projects events into a provider-shaped transcript', () => {
    const store = new EventStore()
    store.append({ type: 'user_message', at: 1, text: 'hi' })
    store.append({
      type: 'assistant_message',
      at: 2,
      content: [call('c1', 'read', { path: 'a' })],
    })
    store.append({ type: 'tool_result', at: 3, id: 'c1', name: 'read', output: 'contents' })
    store.append({ type: 'assistant_message', at: 4, content: [{ type: 'text', text: 'done' }] })

    expect(store.transcript().map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
  })

  test('merges consecutive tool results into one message', () => {
    const store = new EventStore()
    store.append({ type: 'tool_result', at: 1, id: 'a', name: 'read', output: '1' })
    store.append({ type: 'tool_result', at: 2, id: 'b', name: 'read', output: '2' })
    const transcript = store.transcript()
    expect(transcript).toHaveLength(1)
    expect(transcript[0]!.content).toHaveLength(2)
  })

  test('compaction replaces earlier events with a summary', () => {
    const store = new EventStore()
    store.append({ type: 'user_message', at: 1, text: 'first' })
    store.append({ type: 'assistant_message', at: 2, content: [{ type: 'text', text: 'reply' }] })
    store.append({
      type: 'compaction',
      at: 3,
      throughIndex: 2,
      summary: 'They talked about things.',
      tokensBefore: 100,
      tokensAfter: 10,
    })
    store.append({ type: 'user_message', at: 4, text: 'second' })

    const transcript = store.transcript()
    expect(transcript).toHaveLength(2)
    expect(textOf(transcript[0]!.content)).toContain('They talked about things.')
    expect(textOf(transcript[1]!.content)).toBe('second')
    // The full history is still on disk for rewind and inspection.
    expect(store.length).toBe(4)
  })

  test('rewind truncates', () => {
    const store = new EventStore()
    store.append({ type: 'user_message', at: 1, text: 'a' })
    store.append({ type: 'user_message', at: 2, text: 'b' })
    store.rewind(1)
    expect(store.length).toBe(1)
  })

  test('tracks usage and touched files', () => {
    const store = new EventStore()
    store.append({
      type: 'assistant_message',
      at: 1,
      content: [],
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    store.append({
      type: 'tool_result',
      at: 2,
      id: 'c',
      name: 'write',
      output: 'ok',
      touched: ['/a.ts', '/b.ts'],
    })
    expect(store.usage()).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 1,
    })
    expect(store.touchedFiles()).toEqual(['/a.ts', '/b.ts'])
  })

  test('survives a subscriber that throws', () => {
    const store = new EventStore()
    store.subscribe(() => {
      throw new Error('render crashed')
    })
    expect(() => store.append({ type: 'user_message', at: 1, text: 'x' })).not.toThrow()
    expect(store.length).toBe(1)
  })

  test('round-trips through JSON', () => {
    const store = new EventStore()
    store.append({ type: 'user_message', at: 1, text: 'hello' })
    const restored = EventStore.fromJSON(JSON.parse(JSON.stringify(store.toJSON())))
    expect(restored.transcript()).toEqual(store.transcript())
  })
})

describe('context management', () => {
  test('flags compaction once the window fills', () => {
    // Sonnet 4.5 has a 200k window; at ~3.6 chars per token this is roughly
    // 222k tokens, comfortably past the 95% threshold.
    const big = 'x'.repeat(800_000)
    const status = measureContext(
      [{ role: 'user', content: [{ type: 'text', text: big }] }],
      'system',
      'anthropic/claude-sonnet-4.5',
      0.95,
    )
    expect(status.shouldCompact).toBe(true)
    expect(status.ratio).toBeGreaterThan(0.95)
  })

  test('leaves a small conversation alone', () => {
    const status = measureContext(
      [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      'system',
      'anthropic/claude-sonnet-4.5',
      0.95,
    )
    expect(status.shouldCompact).toBe(false)
  })

  test('trims an oversized tool result from the middle', () => {
    const huge = 'a'.repeat(50_000)
    const [message] = trimToolResults(
      [{ role: 'tool', content: [{ type: 'tool_result', id: '1', name: 'bash', output: huge }] }],
      1000,
    )
    const block = message!.content[0]!
    expect(block.type).toBe('tool_result')
    if (block.type === 'tool_result') {
      expect(block.output.length).toBeLessThan(1200)
      expect(block.output).toContain('characters omitted')
      // The head and the tail are what carry the command and the summary.
      expect(block.output.startsWith('aaa')).toBe(true)
      expect(block.output.endsWith('aaa')).toBe(true)
    }
  })

  test('never splits a compaction between a tool call and its results', () => {
    const messages = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'a'.repeat(4000) }] },
      { role: 'assistant' as const, content: [call('c1', 'read', {})] },
      {
        role: 'tool' as const,
        content: [{ type: 'tool_result' as const, id: 'c1', name: 'read', output: 'x' }],
      },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'done' }] },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'more' }] },
    ]
    const { recent } = splitForCompaction(messages, 0.3)
    expect(recent[0]?.role).not.toBe('tool')
  })

  test('renders a transcript for summarization', () => {
    const rendered = renderTranscript([
      { role: 'user', content: [{ type: 'text', text: 'question' }] },
      { role: 'assistant', content: [call('c1', 'grep', { pattern: 'x' })] },
      {
        role: 'tool',
        content: [{ type: 'tool_result', id: 'c1', name: 'grep', output: 'a match' }],
      },
    ])
    expect(rendered).toContain('USER: question')
    expect(rendered).toContain('TOOL CALL grep')
    expect(rendered).toContain('TOOL RESULT grep: a match')
  })
})

describe('bounded parallelism', () => {
  test('mapLimit never runs more than the limit at once, and keeps order', async () => {
    const { mapLimit } = await import('../packages/core/src/index.ts')
    let running = 0
    let peak = 0
    const results = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running--
      return n * 10
    })
    expect(peak).toBe(3)
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
  })

  test('mapLimit handles an empty list', async () => {
    const { mapLimit } = await import('../packages/core/src/index.ts')
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
  })
})
