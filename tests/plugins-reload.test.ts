import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../packages/agent/src/index.ts'
import { type JeanConfig, defaultConfig } from '../packages/config/src/index.ts'
import type { LoopEvent } from '../packages/core/src/index.ts'
import {
  type LoadedPlugin,
  type Plugin,
  PluginLoader,
  discoverPlugins,
} from '../packages/plugins/src/index.ts'

/**
 * Plugins as they run: enabled by name, their tools registered with the
 * agent, their commands answered, and reloaded when their files change —
 * code and dependencies both — without restarting anything.
 */

const temps: string[] = []
const savedHome = process.env.JEAN_HOME
let home = ''

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'jean-plugins-')))
  temps.push(home)
  process.env.JEAN_HOME = home
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.JEAN_HOME
  else process.env.JEAN_HOME = savedHome
})
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A plugin in `~/.jean/plugins/<name>` whose tool answers with its dependency's value. */
function writePlugin(name: string, version: string, answer: string): string {
  const dir = join(home, 'plugins', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'jean-plugin.json'), JSON.stringify({ name, version, main: 'index.js' }))
  writeFileSync(join(dir, 'answer.js'), `export const answer = ${JSON.stringify(answer)}\n`)
  writeFileSync(
    join(dir, 'index.js'),
    [
      "import { answer } from './answer.js'",
      'export function activate(ctx) {',
      "  ctx.registerTool({ name: 'ask', description: 'answers', parameters: { type: 'object', properties: {} }, execute: () => answer })",
      "  ctx.registerCommand({ name: 'hello', description: 'greets', run: (args) => `hello ${args.join('+')} from ${answer}` })",
      '}',
    ].join('\n'),
  )
  return dir
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await settle(50)
  }
}

describe('the loader', () => {
  test('reload evaluates the plugin again, its own imports included', async () => {
    const dir = writePlugin('demo', '1.0.0', 'first')
    const plugin: Plugin = discoverPlugins(home).find((p) => p.manifest.name === 'demo')!
    const loader = new PluginLoader({ cwd: home, enabled: ['demo'] })
    const loaded = await loader.load(plugin)
    expect(await loaded.tools[0]!.execute({})).toBe('first')

    writeFileSync(join(dir, 'answer.js'), 'export const answer = "second"\n')
    writeFileSync(
      join(dir, 'jean-plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.1.0', main: 'index.js' }),
    )
    const reloaded = await loader.reload(plugin)
    expect(reloaded.error).toBeUndefined()
    expect(reloaded.manifest.version).toBe('1.1.0')
    expect(await reloaded.tools[0]!.execute({})).toBe('second')
    expect(loader.tools()).toHaveLength(1)
    await loader.unloadAll()
  })

  test('a change on disk reloads the plugin by itself', async () => {
    const dir = writePlugin('watched', '1.0.0', 'before')
    const plugin = discoverPlugins(home).find((p) => p.manifest.name === 'watched')!
    const loader = new PluginLoader({ cwd: home, enabled: ['watched'] })
    await loader.load(plugin)
    const seen: LoadedPlugin[] = []
    const stop = loader.watch([plugin], (loaded) => seen.push(loaded), 100)
    try {
      await settle(200)
      writeFileSync(join(dir, 'answer.js'), 'export const answer = "after"\n')
      const reloaded = await until(() => seen.at(-1))
      expect(await reloaded.tools[0]!.execute({})).toBe('after')
    } finally {
      stop()
      await loader.unloadAll()
    }
  })

  test('a reload that breaks the plugin disables it and says why', async () => {
    const dir = writePlugin('fragile', '1.0.0', 'ok')
    const plugin = discoverPlugins(home).find((p) => p.manifest.name === 'fragile')!
    const loader = new PluginLoader({ cwd: home, enabled: ['fragile'] })
    await loader.load(plugin)
    writeFileSync(
      join(dir, 'index.js'),
      'export function activate() { throw new Error("broken on purpose") }\n',
    )
    const reloaded = await loader.reload(plugin)
    expect(reloaded.error).toContain('broken on purpose')
    expect(loader.tools()).toHaveLength(0)
  })
})

describe('in a session', () => {
  const config = (enabled: string[]): JeanConfig => ({
    ...defaultConfig(),
    permissionMode: 'full',
    advisor: { enabled: false },
    plugins: { enabled, hotReload: true },
  })
  const silent = {
    complete: async () => ({}),
    stream: async function* () {},
    resolve: () => ({}),
    isConfigured: () => true,
  } as never
  type Registry = {
    get(name: string): { execute(a: unknown, c: unknown): Promise<{ output: string }> } | undefined
  }

  test('an enabled plugin registers its tools, answers its command, and reloads while the session runs', async () => {
    const dir = writePlugin('live', '1.0.0', 'v1')
    const events: LoopEvent[] = []
    const agent = new Orchestrator({
      config: config(['live']),
      client: silent,
      cwd: home,
      sessionId: `plugins-${Date.now()}`,
      onEvent: (e) => events.push(e),
    })
    try {
      // A plugin command needs no model: it answers by itself.
      const greeted = await agent.send('/hello a b')
      expect(greeted.text).toBe('hello a+b from v1')
      const registry = (agent as unknown as { registry: Registry }).registry
      const tool = registry.get('live__ask')
      expect(tool).toBeDefined()
      expect((await tool!.execute({}, {})).output).toBe('v1')

      writeFileSync(join(dir, 'answer.js'), 'export const answer = "v2"\n')
      await until(() =>
        events.find((e) => e.type === 'notice' && e.text.startsWith('Reloaded plugin live')),
      )
      expect((await registry.get('live__ask')!.execute({}, {})).output).toBe('v2')
      expect((await agent.send('/hello')).text).toBe('hello  from v2')
    } finally {
      agent.end('test')
    }
  })

  test('a plugin that is installed but not enabled does not run', async () => {
    writePlugin('dormant', '1.0.0', 'never')
    const agent = new Orchestrator({
      config: config([]),
      client: silent,
      cwd: home,
      sessionId: `plugins-off-${Date.now()}`,
    })
    try {
      await (agent as unknown as { loadPlugins(): Promise<void> }).loadPlugins()
      expect(
        (agent as unknown as { registry: Registry }).registry.get('dormant__ask'),
      ).toBeUndefined()
    } finally {
      agent.end('test')
    }
  })
})
