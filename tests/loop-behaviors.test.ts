import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type JeanConfig, defaultConfig } from '../packages/config/src/index.ts'
import {
  EventStore,
  type LoopHooks,
  partition,
  runLoop,
  stableStringify,
} from '../packages/core/src/index.ts'
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  StopReason,
  StreamEvent,
} from '../packages/model/src/types.ts'
import {
  Registry,
  type Tool,
  type ToolContext,
  createSessionState,
} from '../packages/tools/src/index.ts'

/**
 * The loop behaviours that decide whether a task gets finished: concurrency,
 * truncation recovery, loop detection, and the hook seams.
 */

interface Turn {
  content: ContentBlock[]
  stopReason?: StopReason
}

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scripted(turns: Turn[]) {
  const requests: CompletionRequest[] = []
  let index = 0
  const respond = (request: CompletionRequest): CompletionResponse => {
    requests.push(request)
    const turn = turns[index++] ?? { content: [{ type: 'text', text: 'done' }] }
    return {
      content: turn.content,
      stopReason:
        turn.stopReason ?? (turn.content.some((b) => b.type === 'tool_call') ? 'tool_use' : 'stop'),
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'scripted',
      provider: 'scripted',
      latencyMs: 1,
    }
  }
  const client = {
    resolve: () => ({
      role: 'default',
      provider: 'scripted',
      modelId: 'scripted',
      maxTokens: 4096,
      fallbacks: [],
    }),
    isConfigured: () => true,
    complete: async (request: CompletionRequest) => respond(request),
    async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent, void, void> {
      yield { type: 'done', response: respond(request) }
    },
  }
  return { client: client as never, requests, turnsServed: () => index }
}

/** A tool whose calls are timed and logged, for ordering and overlap checks. */
function probe(name: string, risk: Tool['risk'], log: string[], delayMs = 60): Tool {
  return {
    name,
    risk,
    description: name,
    parameters: { type: 'object', properties: { tag: { type: 'string' } } },
    async execute(args: { tag?: string }) {
      log.push(`start:${args.tag ?? name}`)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      log.push(`end:${args.tag ?? name}`)
      return { output: `ok ${args.tag ?? name}` }
    },
  }
}

function failing(name: string): Tool {
  return {
    name,
    risk: 'read',
    description: name,
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { output: 'boom: the thing is broken', isError: true }
    },
  }
}

function setup(tools: Tool[], overrides: Partial<JeanConfig> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'jean-behaviors-'))
  temps.push(cwd)
  const config: JeanConfig = { ...defaultConfig(), permissionMode: 'full', ...overrides }
  const registry = new Registry()
  registry.registerAll(tools)
  const store = new EventStore()
  store.append({ type: 'user_message', at: Date.now(), text: 'go' })
  const toolContext: ToolContext = { cwd, config, session: createSessionState(cwd) }
  return { config, registry, store, toolContext }
}

const call = (id: string, name: string, input: unknown = {}): ContentBlock => ({
  type: 'tool_call',
  id,
  name,
  input,
})
const say = (text: string): ContentBlock => ({ type: 'text', text })

describe('partition', () => {
  test('groups consecutive parallel items and isolates serial ones', () => {
    const batches = partition(['r1', 'r2', 'w', 'r3', 'r4', 'w2'], (x) => x.startsWith('r'))
    expect(batches).toEqual([['r1', 'r2'], ['w'], ['r3', 'r4'], ['w2']])
  })

  test('handles an empty list', () => {
    expect(partition([], () => true)).toEqual([])
  })
})

describe('stableStringify', () => {
  test('ignores key order', () => {
    expect(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }),
    )
  })
})

describe('concurrency', () => {
  test('independent reads in one turn overlap', async () => {
    const log: string[] = []
    const { config, registry, store, toolContext } = setup([probe('look', 'read', log, 120)])
    const { client } = scripted([
      {
        content: [
          call('a', 'look', { tag: 'a' }),
          call('b', 'look', { tag: 'b' }),
          call('c', 'look', { tag: 'c' }),
        ],
      },
      { content: [say('done')] },
    ])

    const started = Date.now()
    await runLoop({ store, client, registry, config, toolContext, systemPrompt: 'x' })
    const elapsed = Date.now() - started

    // All three start before any finishes.
    expect(log.slice(0, 3).every((entry) => entry.startsWith('start:'))).toBe(true)
    // Well under the 360ms a serial run would take.
    expect(elapsed).toBeLessThan(330)
  })

  test('a write is a barrier: reads after it wait for it', async () => {
    const log: string[] = []
    const { config, registry, store, toolContext } = setup([
      probe('look', 'read', log),
      probe('change', 'write', log),
    ])
    const { client } = scripted([
      {
        content: [
          call('1', 'look', { tag: 'r1' }),
          call('2', 'change', { tag: 'w' }),
          call('3', 'look', { tag: 'r2' }),
        ],
      },
      { content: [say('done')] },
    ])
    await runLoop({ store, client, registry, config, toolContext, systemPrompt: 'x' })
    expect(log).toEqual(['start:r1', 'end:r1', 'start:w', 'end:w', 'start:r2', 'end:r2'])
  })

  test('results stay paired with their calls in issue order', async () => {
    const log: string[] = []
    const { config, registry, store, toolContext } = setup([probe('look', 'read', log)])
    const { client } = scripted([
      { content: [call('x1', 'look', { tag: 'first' }), call('x2', 'look', { tag: 'second' })] },
      { content: [say('done')] },
    ])
    await runLoop({ store, client, registry, config, toolContext, systemPrompt: 'x' })
    const results = store.ofType('tool_result')
    expect(results.map((r) => r.id)).toEqual(['x1', 'x2'])
    expect(results.map((r) => r.output)).toEqual(['ok first', 'ok second'])
  })
})

describe('truncation', () => {
  test('a response cut off mid-answer is continued, not returned', async () => {
    const { config, registry, store, toolContext } = setup([])
    const { client, turnsServed } = scripted([
      { content: [say('The answer begins')], stopReason: 'length' },
      { content: [say('and ends here.')] },
    ])
    const result = await runLoop({
      store,
      client,
      registry,
      config,
      toolContext,
      systemPrompt: 'x',
    })

    expect(turnsServed()).toBe(2)
    expect(result.stopReason).toBe('complete')
    expect(result.text).toBe('and ends here.')
    const reminders = store.ofType('reminder')
    expect(reminders.map((r) => r.source)).toContain('truncation')
  })

  test('continuation is bounded', async () => {
    const { config, registry, store, toolContext } = setup([])
    const { client, turnsServed } = scripted(
      Array.from({ length: 10 }, () => ({ content: [say('more')], stopReason: 'length' as const })),
    )
    await runLoop({ store, client, registry, config, toolContext, systemPrompt: 'x' })
    expect(turnsServed()).toBe(4)
  })

  test('a reminder reaches the model as a system-reminder message', async () => {
    const { config, registry, store, toolContext } = setup([])
    const { client, requests } = scripted([
      { content: [say('cut')], stopReason: 'length' },
      { content: [say('done')] },
    ])
    await runLoop({ store, client, registry, config, toolContext, systemPrompt: 'x' })
    const last = requests[1]!.messages.at(-1)!
    expect(last.role).toBe('user')
    expect((last.content[0] as { text: string }).text).toContain('<system-reminder>')
  })
})

describe('repeat detection', () => {
  test('names a call that keeps failing identically', async () => {
    const { config, registry, store, toolContext } = setup([failing('flaky')])
    const { client } = scripted([
      { content: [call('1', 'flaky')] },
      { content: [call('2', 'flaky')] },
      { content: [call('3', 'flaky')] },
      { content: [say('giving up')] },
    ])
    await runLoop({ store, client, registry, config, toolContext, systemPrompt: 'x' })
    const repeats = store.ofType('reminder').filter((r) => r.source === 'repeat')
    expect(repeats).toHaveLength(1)
    expect(repeats[0]!.text).toContain('3 times in a row')
    expect(repeats[0]!.text).toContain('boom: the thing is broken')
  })

  test('different arguments are not a repeat', async () => {
    const log: string[] = []
    const { config, registry, store, toolContext } = setup([probe('look', 'read', log, 1)])
    const { client } = scripted([
      ...Array.from({ length: 6 }, (_, i) => ({
        content: [call(`${i}`, 'look', { tag: `t${i}` })],
      })),
      { content: [say('done')] },
    ])
    await runLoop({ store, client, registry, config, toolContext, systemPrompt: 'x' })
    expect(store.ofType('reminder')).toHaveLength(0)
  })
})

describe('hooks', () => {
  test('beforeTool can deny a call, and the tool never runs', async () => {
    const log: string[] = []
    const { config, registry, store, toolContext } = setup([probe('change', 'write', log)])
    const { client } = scripted([{ content: [call('1', 'change')] }, { content: [say('ok')] }])
    const hooks: LoopHooks = { beforeTool: () => ({ deny: 'Policy forbids this.' }) }
    await runLoop({ store, client, registry, config, toolContext, systemPrompt: 'x', hooks })

    expect(log).toEqual([])
    const result = store.ofType('tool_result')[0]!
    expect(result.isError).toBe(true)
    expect(result.output).toBe('Policy forbids this.')
  })

  test('beforeTool can rewrite the arguments', async () => {
    const log: string[] = []
    const { config, registry, store, toolContext } = setup([probe('look', 'read', log, 1)])
    const { client } = scripted([
      { content: [call('1', 'look', { tag: 'original' })] },
      { content: [say('ok')] },
    ])
    const hooks: LoopHooks = { beforeTool: () => ({ input: { tag: 'rewritten' } }) }
    await runLoop({ store, client, registry, config, toolContext, systemPrompt: 'x', hooks })
    expect(log).toEqual(['start:rewritten', 'end:rewritten'])
  })

  test('afterTool context is appended to what the model sees', async () => {
    const log: string[] = []
    const { config, registry, store, toolContext } = setup([probe('look', 'read', log, 1)])
    const { client } = scripted([{ content: [call('1', 'look')] }, { content: [say('ok')] }])
    const hooks: LoopHooks = { afterTool: () => ({ context: 'Lint: 2 warnings.' }) }
    await runLoop({ store, client, registry, config, toolContext, systemPrompt: 'x', hooks })
    expect(store.ofType('tool_result')[0]!.output).toBe('ok look\n\nLint: 2 warnings.')
  })

  test('a throwing hook is ignored rather than fatal', async () => {
    const log: string[] = []
    const { config, registry, store, toolContext } = setup([probe('look', 'read', log, 1)])
    const { client } = scripted([{ content: [call('1', 'look')] }, { content: [say('ok')] }])
    const hooks: LoopHooks = {
      beforeTool: () => {
        throw new Error('hook bug')
      },
    }
    const result = await runLoop({
      store,
      client,
      registry,
      config,
      toolContext,
      systemPrompt: 'x',
      hooks,
    })
    expect(result.stopReason).toBe('complete')
    expect(log).toHaveLength(2)
  })

  test('beforeStop keeps the agent working until satisfied', async () => {
    const { config, registry, store, toolContext } = setup([])
    const { client, turnsServed } = scripted([
      { content: [say('first try')] },
      { content: [say('second try')] },
      { content: [say('third try')] },
    ])
    let checks = 0
    const hooks: LoopHooks = {
      beforeStop: () => (++checks < 3 ? { continueWith: 'Tests still fail.' } : undefined),
    }
    const result = await runLoop({
      store,
      client,
      registry,
      config,
      toolContext,
      systemPrompt: 'x',
      hooks,
    })
    expect(turnsServed()).toBe(3)
    expect(result.text).toBe('third try')
    expect(store.ofType('reminder').filter((r) => r.source === 'stop-hook')).toHaveLength(2)
  })

  test('reminders are injected before the request', async () => {
    const { config, registry, store, toolContext } = setup([])
    const { client, requests } = scripted([{ content: [say('ok')] }])
    await runLoop({
      store,
      client,
      registry,
      config,
      toolContext,
      systemPrompt: 'x',
      reminders: () => ['src/a.ts changed on disk since you read it.'],
    })
    const sent = JSON.stringify(requests[0]!.messages)
    expect(sent).toContain('src/a.ts changed on disk')
  })
})

describe('interruption', () => {
  test('every issued call gets a result, so the transcript stays valid', async () => {
    const controller = new AbortController()
    const log: string[] = []
    const aborting: Tool = {
      name: 'stop_now',
      risk: 'write',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      async execute() {
        controller.abort()
        return { output: 'stopped' }
      },
    }
    const { config, registry, store, toolContext } = setup([
      aborting,
      probe('change', 'write', log, 1),
    ])
    const { client } = scripted([
      { content: [call('1', 'stop_now'), call('2', 'change'), call('3', 'change')] },
    ])
    const result = await runLoop({
      store,
      client,
      registry,
      config,
      toolContext,
      systemPrompt: 'x',
      signal: controller.signal,
    })
    expect(result.stopReason).toBe('aborted')
    expect(log).toEqual([])
    const ids = store.ofType('tool_result').map((r) => r.id)
    expect(ids).toEqual(['1', '2', '3'])
  })
})

describe('transient failures', () => {
  function flaky(failures: { retryable: boolean }[], then: Turn) {
    let calls = 0
    const client = {
      resolve: () => ({
        role: 'default',
        provider: 'x',
        modelId: 'x',
        maxTokens: 4096,
        fallbacks: [],
      }),
      isConfigured: () => true,
      async *stream(): AsyncGenerator<StreamEvent, void, void> {
        const failure = failures[calls++]
        if (failure) {
          const err = Object.assign(new Error('openrouter returned 429 — rate limited'), failure)
          throw err
        }
        yield {
          type: 'done',
          response: {
            content: then.content,
            stopReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1 },
            model: 'x',
            provider: 'x',
            latencyMs: 1,
          },
        }
      },
    }
    return { client: client as never, calls: () => calls }
  }

  test('a rate limit is waited out and the turn retried', async () => {
    const { config, registry, store, toolContext } = setup([])
    const { client, calls } = flaky([{ retryable: true }, { retryable: true }], {
      content: [say('made it')],
    })
    const notices: string[] = []
    const result = await runLoop({
      store,
      client,
      registry,
      config,
      toolContext,
      systemPrompt: 'x',
      retryDelaysMs: [5, 5, 5],
      onEvent: (e) => {
        if (e.type === 'notice') notices.push(e.text)
      },
    })
    expect(result.stopReason).toBe('complete')
    expect(result.text).toBe('made it')
    expect(calls()).toBe(3)
    expect(notices[0]).toContain('retrying in')
  })

  test('a permanent failure is not retried', async () => {
    const { config, registry, store, toolContext } = setup([])
    const { client, calls } = flaky([{ retryable: false }], { content: [say('never')] })
    const result = await runLoop({
      store,
      client,
      registry,
      config,
      toolContext,
      systemPrompt: 'x',
      retryDelaysMs: [5, 5],
    })
    expect(result.stopReason).toBe('error')
    expect(calls()).toBe(1)
  })

  test('the retry budget is finite', async () => {
    const { config, registry, store, toolContext } = setup([])
    const { client, calls } = flaky(
      Array.from({ length: 10 }, () => ({ retryable: true })),
      { content: [say('never')] },
    )
    const result = await runLoop({
      store,
      client,
      registry,
      config,
      toolContext,
      systemPrompt: 'x',
      retryDelaysMs: [1, 1],
    })
    expect(result.stopReason).toBe('error')
    expect(calls()).toBe(3)
  })

  test('an interrupt during the wait ends the run promptly', async () => {
    const { config, registry, store, toolContext } = setup([])
    const { client } = flaky([{ retryable: true }], { content: [say('late')] })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const started = Date.now()
    const result = await runLoop({
      store,
      client,
      registry,
      config,
      toolContext,
      systemPrompt: 'x',
      retryDelaysMs: [60_000],
      signal: controller.signal,
    })
    expect(result.stopReason).toBe('aborted')
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('compaction', () => {
  test('the task list and changed files survive compaction exactly', async () => {
    const { config, registry, store, toolContext } = setup([], { compactThreshold: 0.0001 })
    toolContext.session.todos.push(
      { id: '1', text: 'write the parser', status: 'completed' },
      { id: '2', text: 'wire it into the CLI', status: 'in_progress' },
    )
    // Enough history that there is something older than the recent window.
    for (let i = 0; i < 8; i++) {
      store.append({
        type: 'user_message',
        at: Date.now(),
        text: `question ${i} ${'x'.repeat(200)}`,
      })
      store.append({ type: 'assistant_message', at: Date.now(), content: [say(`answer ${i}`)] })
    }
    const { client } = scripted([
      { content: [say('The user is building a parser.')] }, // the summary
      { content: [say('done')] },
    ])
    await runLoop({ store, client, registry, config, toolContext, systemPrompt: 'x' })

    const compaction = store.ofType('compaction')[0]
    expect(compaction).toBeDefined()
    expect(compaction!.summary).toContain('The user is building a parser.')
    expect(compaction!.summary).toContain('[x] write the parser')
    expect(compaction!.summary).toContain('[~] wire it into the CLI')
  })
})
