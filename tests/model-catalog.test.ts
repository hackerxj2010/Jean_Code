import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultConfig,
  readAuth,
  removeKey,
  saveKey,
  savedKey,
} from '../packages/config/src/index.ts'
import {
  ModelClient,
  RoutedProvider,
  catalogFromModelsDev,
  chooseModel,
  createProvider,
  estimateCost,
  findModel,
  hasCredentials,
  listProviders,
  modelsOf,
  recommendedModel,
  rememberModel,
  setCatalog,
  toggleFavorite,
} from '../packages/model/src/index.ts'
import {
  OpenAIResponsesProvider,
  toResponseItems,
} from '../packages/model/src/providers/openai-responses.ts'
import type { Message, StreamEvent } from '../packages/model/src/types.ts'
import { matchesQuery, modelRows, providerRows } from '../packages/tui2/src/utils/model-picker.ts'

/**
 * The model catalog and the providers behind it: models.dev compacted,
 * 200+ providers listed, OpenCode Zen routed per model to four wire formats,
 * keys saved in `auth.json`, and a session that starts on a provider it has
 * a key for.
 */

const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  tool_call: true,
  reasoning: true,
  attachment: true,
  limit: { context: 1_000_000, output: 64_000 },
  cost: { input: 3, output: 15, cache_read: 0.3 },
  release_date: '2026-06-01',
  ...extra,
})

/** A slice of models.dev with every shape Jean reads. */
const RAW = {
  opencode: {
    id: 'opencode',
    name: 'OpenCode Zen',
    env: ['OPENCODE_API_KEY'],
    npm: '@ai-sdk/openai-compatible',
    api: 'https://opencode.ai/zen/v1',
    models: {
      'claude-sonnet-5': model('claude-sonnet-5', {
        name: 'Claude Sonnet 5',
        provider: { npm: '@ai-sdk/anthropic' },
      }),
      'claude-haiku-4-5': model('claude-haiku-4-5', {
        name: 'Claude Haiku 4.5',
        cost: { input: 1, output: 5 },
        provider: { npm: '@ai-sdk/anthropic' },
      }),
      'claude-opus-5-5': model('claude-opus-5-5', {
        name: 'Claude Opus 5.5',
        cost: { input: 5, output: 25 },
        provider: { npm: '@ai-sdk/anthropic' },
      }),
      'gpt-5.5': model('gpt-5.5', {
        name: 'GPT-5.5',
        provider: { npm: '@ai-sdk/openai' },
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] }],
      }),
      'gemini-3.8-flash': model('gemini-3.8-flash', {
        name: 'Gemini 3.8 Flash',
        provider: { npm: '@ai-sdk/google' },
      }),
      'big-pickle': model('big-pickle', {
        name: 'Big Pickle',
        cost: { input: 0, output: 0 },
        release_date: '2026-09-01',
      }),
      'old-free': model('old-free', { status: 'deprecated', cost: { input: 0, output: 0 } }),
      'no-context': model('no-context', { limit: {} }),
    },
  },
  'acme-cloud': {
    id: 'acme-cloud',
    name: 'Acme Cloud',
    env: ['ACME_API_KEY'],
    npm: '@ai-sdk/openai-compatible',
    api: 'https://api.acme.test/v1',
    models: { 'acme-1': model('acme-1', { name: 'Acme One' }) },
  },
  'amazon-bedrock': {
    id: 'amazon-bedrock',
    name: 'Amazon Bedrock',
    env: ['AWS_ACCESS_KEY_ID'],
    npm: '@ai-sdk/amazon-bedrock',
    models: { 'claude-x': model('claude-x') },
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    env: ['OPENROUTER_API_KEY'],
    npm: '@openrouter/ai-sdk-provider',
    api: 'https://openrouter.ai/api/v1',
    models: {
      'anthropic/claude-sonnet-5': model('anthropic/claude-sonnet-5', { name: 'Claude Sonnet 5' }),
    },
  },
}

const temps: string[] = []
const saved: Record<string, string | undefined> = {}
const KEYS = [
  'OPENROUTER_API_KEY',
  'OPENCODE_API_KEY',
  'ACME_API_KEY',
  'ANTHROPIC_API_KEY',
  'JEAN_AUTH_FILE',
  'JEAN_MODEL_STATE',
  'JEAN_HOME',
]

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jean-catalog-')))
  temps.push(dir)
  return dir
}

/** Fresh, empty key and model-state files for one test. */
function isolate(): string {
  const dir = workspace()
  process.env.JEAN_AUTH_FILE = join(dir, 'auth.json')
  process.env.JEAN_MODEL_STATE = join(dir, 'models.json')
  return dir
}

beforeAll(() => {
  for (const key of KEYS) saved[key] = process.env[key]
  // The machine's own keys must not decide what these tests see.
  for (const key of ['OPENROUTER_API_KEY', 'OPENCODE_API_KEY', 'ACME_API_KEY', 'ANTHROPIC_API_KEY'])
    delete process.env[key]
  process.env.JEAN_HOME = workspace()
  setCatalog(catalogFromModelsDev(RAW, 'fixture', Date.now()))
})

afterAll(() => {
  setCatalog(undefined)
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the models.dev catalog', () => {
  test('is compacted to what Jean reads: limits, prices, abilities, and the wire format per model', () => {
    const catalog = catalogFromModelsDev(RAW, 'fixture', 1)
    const zen = catalog.providers.opencode!
    expect(zen.env).toEqual(['OPENCODE_API_KEY'])
    expect(zen.models['claude-sonnet-5']).toMatchObject({
      contextWindow: 1_000_000,
      maxOutput: 64_000,
      inputCost: 3,
      cacheReadCost: 0.3,
      api: 'anthropic',
    })
    expect(zen.models['gpt-5.5']).toMatchObject({
      api: 'responses',
      reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
    })
    expect(zen.models['gemini-3.8-flash']!.api).toBe('google')
    // The provider's own format is not repeated on each model.
    expect(zen.models['big-pickle']!.api).toBeUndefined()
    expect(zen.models['big-pickle']!.free).toBe(true)
    expect(zen.models['old-free']!.status).toBe('deprecated')
    // A model without a context window cannot be budgeted for.
    expect(zen.models['no-context']).toBeUndefined()
  })

  test('lookups prefer the named provider, and a free model costs nothing', () => {
    expect(findModel('claude-sonnet-5', 'opencode')?.provider).toBe('opencode')
    expect(findModel('anthropic/claude-sonnet-5')?.contextWindow).toBe(1_000_000)
    expect(estimateCost('big-pickle', 1_000_000, 1_000_000, 'opencode')).toBe(0)
    // Cached input is billed at the cache rate: 0.5M fresh at $3, 0.5M cached at $0.3, 1M out at $15.
    expect(estimateCost('claude-sonnet-5', 1_000_000, 1_000_000, 'opencode', 500_000)).toBeCloseTo(
      1.5 + 0.15 + 15,
      6,
    )
  })
})

describe('the providers', () => {
  test('built-in ones first with OpenCode Zen leading, then the catalog, then the config', () => {
    const entries = listProviders({
      mine: { baseUrl: 'http://127.0.0.1:9/v1', name: 'Mine', models: { 'm-1': {} } },
    })
    expect(entries[0]!.id).toBe('opencode')
    expect(entries.slice(0, 4).map((entry) => entry.id)).toEqual([
      'opencode',
      'anthropic',
      'openai',
      'google',
    ])
    const acme = entries.find((entry) => entry.id === 'acme-cloud')!
    expect(acme).toMatchObject({
      builtin: false,
      api: 'chat',
      baseUrl: 'https://api.acme.test/v1',
      models: 1,
    })
    // Bedrock signs its requests its own way: listed, but not speakable.
    expect(entries.find((entry) => entry.id === 'amazon-bedrock')!.api).toBeUndefined()
    expect(entries.find((entry) => entry.id === 'mine')).toMatchObject({
      custom: true,
      label: 'Mine',
    })
    expect(() => createProvider('amazon-bedrock')).toThrow(/own sign-in/)
  })

  test('OpenCode Zen speaks four wire formats, one per model family, with one key', async () => {
    const hits: {
      path: string
      bearer: string | null
      xApiKey: string | null
      goog: string | null
      body: Record<string, unknown>
    }[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        hits.push({
          path,
          bearer: request.headers.get('authorization'),
          xApiKey: request.headers.get('x-api-key'),
          goog: request.headers.get('x-goog-api-key'),
          body: (await request.json()) as Record<string, unknown>,
        })
        if (path.endsWith('/chat/completions')) {
          return Response.json({
            choices: [{ message: { content: 'chat ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          })
        }
        if (path.endsWith('/messages')) {
          return Response.json({
            content: [{ type: 'text', text: 'anthropic ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          })
        }
        if (path.endsWith('/responses')) {
          return Response.json({
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'responses ok' }] }],
            usage: { input_tokens: 1, output_tokens: 1 },
          })
        }
        return Response.json({
          candidates: [{ content: { parts: [{ text: 'google ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        })
      },
    })
    try {
      const zen = createProvider('opencode', {
        baseUrl: `http://127.0.0.1:${server.port}/zen/v1`,
        apiKey: 'zen-key',
      })
      expect(zen).toBeInstanceOf(RoutedProvider)
      const ask = async (id: string) =>
        (
          await zen.complete(id, {
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
            maxTokens: 50,
          })
        ).content
      expect(await ask('claude-sonnet-5')).toEqual([{ type: 'text', text: 'anthropic ok' }])
      expect(await ask('gpt-5.5')).toEqual([{ type: 'text', text: 'responses ok' }])
      expect(await ask('gemini-3.8-flash')).toEqual([{ type: 'text', text: 'google ok' }])
      expect(await ask('big-pickle')).toEqual([{ type: 'text', text: 'chat ok' }])

      expect(hits.map((hit) => hit.path)).toEqual([
        '/zen/v1/messages',
        '/zen/v1/responses',
        '/zen/v1/models/gemini-3.8-flash:generateContent',
        '/zen/v1/chat/completions',
      ])
      // Each format carries the key the way its own SDK would.
      expect(hits[0]!.xApiKey).toBe('zen-key')
      expect(hits[1]!.bearer).toBe('Bearer zen-key')
      expect(hits[2]!.goog).toBe('zen-key')
      expect(hits[3]!.bearer).toBe('Bearer zen-key')
      expect(hits[1]!.body).toMatchObject({ model: 'gpt-5.5', store: false })
    } finally {
      server.stop(true)
    }
  })

  test('a provider of your own is one config entry', async () => {
    let seen = ''
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        seen = `${new URL(request.url).pathname} ${request.headers.get('authorization')}`
        return Response.json({
          choices: [{ message: { content: 'mine ok' }, finish_reason: 'stop' }],
          usage: {},
        })
      },
    })
    try {
      const provider = createProvider('mine', {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: 'k1',
      })
      const response = await provider.complete('m-1', {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })
      expect(response.content).toEqual([{ type: 'text', text: 'mine ok' }])
      expect(seen).toBe('/v1/chat/completions Bearer k1')
    } finally {
      server.stop(true)
    }
  })
})

describe('the Responses wire format', () => {
  const transcript: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'read a.ts' }] },
    {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          text: 'look first',
          replay: { format: 'openai-responses', id: 'rs_1', data: 'ENC' },
        },
        { type: 'text', text: 'Reading it.' },
        { type: 'tool_call', id: 'call_1', name: 'read', input: { path: 'a.ts' } },
      ],
    },
    {
      role: 'tool',
      content: [{ type: 'tool_result', id: 'call_1', name: 'read', output: 'export {}' }],
    },
  ]

  test('the transcript becomes items, the encrypted reasoning handed back', () => {
    expect(toResponseItems(transcript)).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'read a.ts' }] },
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] },
      { role: 'assistant', content: 'Reading it.' },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'export {}' },
    ])
  })

  test('a stream becomes text, reasoning, and a tool call', async () => {
    const frames = [
      { type: 'response.created', response: { model: 'gpt-5.5' } },
      { type: 'response.reasoning_summary_text.delta', delta: 'Thinking' },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_2',
          encrypted_content: 'ENC2',
          summary: [{ type: 'summary_text', text: 'Thinking' }],
        },
      },
      { type: 'response.output_text.delta', delta: 'Hel' },
      { type: 'response.output_text.delta', delta: 'lo' },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
      },
      {
        type: 'response.output_item.done',
        output_index: 2,
        item: {
          type: 'function_call',
          call_id: 'call_9',
          name: 'grep',
          arguments: '{"pattern":"x"}',
        },
      },
      {
        type: 'response.completed',
        response: {
          model: 'gpt-5.5',
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } },
        },
      },
    ]
    let body: Record<string, unknown> = {}
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        body = (await request.json()) as Record<string, unknown>
        return new Response(
          frames
            .map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
            .join(''),
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        )
      },
    })
    try {
      const provider = new OpenAIResponsesProvider({
        name: 'openai',
        label: 'OpenAI',
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: 'k',
      })
      const events: StreamEvent[] = []
      for await (const event of provider.stream('gpt-5.5', {
        messages: transcript,
        system: 'be brief',
        effort: 'high',
        tools: [
          { name: 'grep', description: 'search', parameters: { type: 'object', properties: {} } },
        ],
      })) {
        events.push(event)
      }
      expect(
        events
          .filter((event) => event.type === 'text')
          .map((event) => (event as { delta: string }).delta)
          .join(''),
      ).toBe('Hello')
      expect(events.some((event) => event.type === 'thinking')).toBe(true)
      expect(events.find((event) => event.type === 'tool_call')).toMatchObject({
        id: 'call_9',
        name: 'grep',
        input: { pattern: 'x' },
      })
      const done = events.find((event) => event.type === 'done') as Extract<
        StreamEvent,
        { type: 'done' }
      >
      expect(done.response.stopReason).toBe('tool_use')
      expect(done.response.usage).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 4,
      })
      expect(done.response.content[0]).toMatchObject({
        type: 'thinking',
        replay: { id: 'rs_2', data: 'ENC2' },
      })
      expect(body).toMatchObject({
        instructions: 'be brief',
        store: false,
        reasoning: { effort: 'high' },
        include: ['reasoning.encrypted_content'],
      })
      expect((body.tools as unknown[])[0]).toMatchObject({ type: 'function', name: 'grep' })
    } finally {
      server.stop(true)
    }
  })
})

describe('keys and the starting model', () => {
  test('a saved key is found, used, and forgotten', async () => {
    isolate()
    expect(hasCredentials('acme-cloud')).toBe(false)
    saveKey('acme-cloud', '  acme-secret \n')
    expect(savedKey('acme-cloud')).toBe('acme-secret')
    expect(readAuth()['acme-cloud']!.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(hasCredentials('acme-cloud')).toBe(true)

    let auth = null as string | null
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        auth = request.headers.get('authorization')
        return Response.json({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: {},
        })
      },
    })
    try {
      const config = defaultConfig()
      config.model = { provider: 'acme-cloud', modelId: 'acme-1' }
      config.agents.default.model = 'acme-cloud:acme-1'
      config.providers['acme-cloud'] = { baseUrl: `http://127.0.0.1:${server.port}/v1` }
      const client = new ModelClient({ config })
      await client.complete({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })
      expect(auth).toBe('Bearer acme-secret')
    } finally {
      server.stop(true)
    }

    expect(removeKey('acme-cloud')).toBe(true)
    expect(hasCredentials('acme-cloud')).toBe(false)
  })

  test('with no key for the default provider, the session starts on one that has a key', () => {
    isolate()
    saveKey('opencode', 'zen-key')
    const defaults = defaultConfig()
    const choice = chooseModel(structuredClone(defaults), false, defaults)
    expect(choice.config.model).toEqual({ provider: 'opencode', modelId: 'claude-sonnet-5' })
    expect(choice.config.agents.smol?.model).toBe('opencode:claude-haiku-4-5')
    expect(choice.config.agents.advisor?.model).toBe('opencode:claude-opus-5-5')
    expect(choice.note).toMatch(/OpenCode Zen/)
    // A model someone chose is never moved.
    expect(chooseModel(structuredClone(defaults), true, defaults).config.model.provider).toBe(
      'openrouter',
    )
  })

  test('the model picked last wins over the first connected provider', () => {
    isolate()
    saveKey('opencode', 'zen-key')
    rememberModel('opencode:gpt-5.5')
    const defaults = defaultConfig()
    const choice = chooseModel(structuredClone(defaults), false, defaults)
    expect(choice.config.model).toEqual({ provider: 'opencode', modelId: 'gpt-5.5' })
    expect(choice.note).toMatch(/picked last/)
  })

  test('each tier has a recommended model', () => {
    expect(recommendedModel('opencode', 'small')?.id).toBe('claude-haiku-4-5')
    expect(recommendedModel('opencode', 'large')?.id).toBe('claude-opus-5-5')
    // A provider with no preferred model: its newest that can use tools.
    expect(recommendedModel('acme-cloud')?.id).toBe('acme-1')
    expect(modelsOf('opencode').some((entry) => entry.id === 'no-context')).toBe(false)
  })
})

describe('the picker', () => {
  test('opens on the model in use, then favorites and recent, then every connected model', () => {
    isolate()
    saveKey('opencode', 'zen-key')
    rememberModel('opencode:gemini-3.8-flash')
    toggleFavorite('opencode:gpt-5.5')
    const rows = modelRows({}, 'opencode:claude-sonnet-5')
    expect(rows.slice(0, 3).map((row) => [row.icon, row.id])).toEqual([
      ['→', 'opencode:claude-sonnet-5'],
      ['★', 'opencode:gpt-5.5'],
      ['◷', 'opencode:gemini-3.8-flash'],
    ])
    // Each model once; deprecated ones left out; connecting another is last.
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
    expect(rows.some((row) => row.id === 'opencode:old-free')).toBe(false)
    expect(rows.at(-1)!.kind).toBe('action')
    expect(rows.filter((row) => matchesQuery(row, 'pickle free')).map((row) => row.id)).toEqual([
      'opencode:big-pickle',
    ])
  })

  test('lists providers with what each needs', () => {
    isolate()
    saveKey('opencode', 'zen-key')
    const rows = providerRows({})
    expect(rows.find((row) => row.id === 'opencode')!.icon).toBe('●')
    expect(rows.find((row) => row.id === 'acme-cloud')!.icon).toBe('○')
    expect(rows.find((row) => row.id === 'ollama')!.icon).toBe('◇')
    // The ones Jean cannot speak come last.
    expect(rows.at(-1)!.id).toBe('amazon-bedrock')
    expect(rows.at(-1)!.icon).toBe('×')
  })
})

describe('the command line', () => {
  const cli = join(import.meta.dir, '..', 'packages', 'cli', 'src', 'index.ts')

  // Asynchronous, so the stand-in server in this process can answer the
  // child's key check while it waits.
  async function run(args: string[], env: Record<string, string>, stdin?: string) {
    const child = Bun.spawn(['bun', cli, ...args], {
      env: { ...process.env, ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, out: out + err }
  }

  test('`jean providers`, `jean models`, and `jean auth` over the catalog', async () => {
    const dir = isolate()
    const catalogFile = join(dir, 'catalog.json')
    writeFileSync(catalogFile, JSON.stringify(catalogFromModelsDev(RAW, 'fixture', Date.now())))
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        // The key check: a model list for the right key, 401 otherwise.
        return request.headers.get('authorization') === 'Bearer good-key'
          ? Response.json({ data: [] })
          : new Response('no', { status: 401 })
      },
    })
    const env = {
      JEAN_HOME: dir,
      JEAN_CATALOG_FILE: catalogFile,
      JEAN_AUTH_FILE: join(dir, 'auth.json'),
      JEAN_MODEL_STATE: join(dir, 'models.json'),
      JEAN_CONFIG_CONTENT: JSON.stringify({
        providers: {
          mine: {
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            name: 'Mine',
            keyEnv: ['MINE_KEY'],
          },
        },
      }),
    }
    try {
      const providers = await run(['providers', '--all', '--no-import'], env)
      expect(providers.code).toBe(0)
      expect(providers.out).toContain('opencode')
      expect(providers.out).toContain('Acme Cloud')
      expect(providers.out).toContain('Mine')

      const free = await run(['models', 'opencode', '--free', '--no-import'], env)
      expect(free.out).toContain('opencode:big-pickle')
      expect(free.out).not.toContain('opencode:claude-sonnet-5')

      const rejected = await run(['auth', 'login', 'mine', '--no-import'], env, 'bad-key\n')
      expect(rejected.code).toBe(1)
      expect(rejected.out).toContain('rejected')

      const accepted = await run(['auth', 'login', 'mine', '--no-import'], env, 'good-key\n')
      expect(accepted.code).toBe(0)
      expect(accepted.out).toContain('(checked)')
      expect((await run(['auth', 'list', '--no-import'], env)).out).toContain('mine')
      expect((await run(['auth', 'logout', 'mine', '--no-import'], env)).out).toContain('Forgot')
    } finally {
      server.stop(true)
    }
  }, 60_000)
})
