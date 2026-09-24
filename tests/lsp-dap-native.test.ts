import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Orchestrator } from '../packages/agent/src/index.ts'
import { type JeanConfig, defaultConfig } from '../packages/config/src/index.ts'
import { createDebugTools, DebugRegistry } from '../packages/dap/src/index.ts'
import { loadPolicy } from '../packages/hooks/src/index.ts'
import { createLspTools, LspManager } from '../packages/lsp/src/index.ts'
import type { CompletionRequest, CompletionResponse, ContentBlock, StreamEvent } from '../packages/model/src/types.ts'
import { findBinary, nativeCalls, nativeReady } from '../packages/native/src/index.ts'
import { createSessionState, Registry, type ToolContext, type ToolResult } from '../packages/tools/src/index.ts'

/**
 * The language-server and debugger engines (`crates/pi-lsp`, `crates/pi-dap`)
 * driven through the tools the agent calls, against the mock server and the
 * mock adapter in `tests/fixtures` — so every operation runs end to end, and
 * the bridge's call counter proves the Rust engine answered.
 */

const built = findBinary() !== undefined
// Servers and adapters are real processes; starting them takes a moment.
setDefaultTimeout(60_000)
const bun = process.execPath
const fixture = (name: string) => resolve(import.meta.dir, 'fixtures', name)

const temps: string[] = []
// A session a failed test left behind must not answer for the next one.
afterEach(async () => {
  await (await nativeReady())?.dap('stop', {}).catch(() => undefined)
})
afterAll(async () => {
  const native = await nativeReady()
  await native?.lsp('stop', {}).catch(() => undefined)
  await native?.dap('stop', {}).catch(() => undefined)
  // Windows holds a directory a process just left for a moment.
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch {}
  }
})

function workspace(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jean-lspdap-')))
  temps.push(dir)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

function context(cwd: string): ToolContext {
  return { cwd, config: defaultConfig(), session: createSessionState(cwd) }
}

async function counted(method: string, work: () => Promise<ToolResult>): Promise<{ result: ToolResult; calls: number }> {
  const before = nativeCalls(method)
  const result = await work()
  return { result, calls: nativeCalls(method) - before }
}

const MOCK_SERVER = { mock: { command: [bun, fixture('mock-lsp-full.mjs')], extensions: ['.mock'], settings: { mock: { flavor: 'tested' } } } }

function languageTools(cwd: string) {
  const manager = new LspManager({ projectRoot: cwd, config: MOCK_SERVER, autoInstall: false })
  const registry = new Registry()
  registry.registerAll(createLspTools(manager))
  const ctx = context(cwd)
  const call = (name: string, args: Record<string, unknown>) => registry.call(name, args, ctx, { approve: true })
  return { manager, call }
}

describe.skipIf(!built)('language tools on the Rust engine', () => {
  test('diagnostics come from the server, errors first, through lsp.diagnostics', async () => {
    const cwd = workspace({ 'a.mock': 'def alpha\nuse ERROR here\nWARN\n' })
    const { manager, call } = languageTools(cwd)
    const { result, calls } = await counted('lsp.diagnostics', () => call('lsp_diagnostics', { path: 'a.mock' }))
    expect(calls).toBe(1)
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('1 error, 1 warning')
    expect(result.output.indexOf('found ERROR')).toBeLessThan(result.output.indexOf('found WARN'))

    const errors = await call('lsp_diagnostics', { path: 'a.mock', severity: 'error' })
    expect(errors.output).not.toContain('found WARN')
    manager.stop()
  })

  test('navigation: hover, definition, references, symbols, hierarchy', async () => {
    const cwd = workspace({ 'a.mock': 'def alpha\n  def inner\nuse alpha\n', 'b.mock': 'use alpha\nalpha calls beta\ndef beta\n' })
    const { manager, call } = languageTools(cwd)
    const engine = (await manager.native())!
    // The mock knows only open files; a real server reads the rest from disk.
    await engine.touch(join(cwd, 'a.mock'), 'changed', true)
    await engine.touch(join(cwd, 'b.mock'), 'changed', true)

    const hover = await counted('lsp.hover', () => call('lsp_hover', { path: 'b.mock', line: 1, symbol: 'alpha' }))
    expect(hover.calls).toBe(1)
    expect(hover.result.output).toContain('def alpha')
    expect(hover.result.output).toContain('configured: tested')

    const definition = await call('lsp_definition', { path: 'b.mock', line: 1, symbol: 'alpha' })
    expect(definition.output).toContain('a.mock')
    expect(definition.output).toContain('1: def alpha')

    const references = await call('lsp_references', { path: 'b.mock', line: 1, symbol: 'alpha' })
    expect(references.output).toMatch(/3 references to `alpha` across 2 files/)

    const outline = await call('lsp_symbols', { path: 'a.mock' })
    expect(outline.output).toContain('alpha')
    expect(outline.output).toMatch(/\n {2}\S+\s+inner/)

    const callers = await counted('lsp.calls', () => call('lsp_hierarchy', { path: 'b.mock', line: 3, symbol: 'beta', direction: 'incoming' }))
    expect(callers.calls).toBe(1)
    expect(callers.result.output).toContain('Callers of `beta`')
    expect(callers.result.output).toContain('alpha')
    manager.stop()
  })

  test('a rename is written to every file, all or nothing', async () => {
    const cwd = workspace({ 'a.mock': 'def alpha\nuse alpha\n', 'b.mock': 'use alpha\n' })
    const { manager, call } = languageTools(cwd)
    const engine = (await manager.native())!
    await engine.touch(join(cwd, 'b.mock'), 'changed', true)

    const preview = await call('lsp_rename', { path: 'a.mock', line: 1, symbol: 'alpha', newName: 'omega', preview: true })
    expect(preview.output).toContain('Renaming would change')
    expect(readFileSync(join(cwd, 'b.mock'), 'utf8')).toBe('use alpha\n')

    const { result, calls } = await counted('lsp.rename', () => call('lsp_rename', { path: 'a.mock', line: 1, symbol: 'alpha', newName: 'omega' }))
    expect(calls).toBe(1)
    expect(result.output).toContain('Renamed `alpha` to `omega`')
    expect(result.touched?.length).toBe(2)
    expect(readFileSync(join(cwd, 'a.mock'), 'utf8')).toBe('def omega\nuse omega\n')
    expect(readFileSync(join(cwd, 'b.mock'), 'utf8')).toBe('use omega\n')
    manager.stop()
  })

  test('a quick fix is listed, then applied by its title', async () => {
    const cwd = workspace({ 'a.mock': 'def alpha\nuse ERROR here\n' })
    const { manager, call } = languageTools(cwd)
    await call('lsp_diagnostics', { path: 'a.mock' })

    const listed = await call('lsp_code_actions', { path: 'a.mock', line: 2 })
    expect(listed.output).toContain('Replace ERROR with OK')

    const applied = await call('lsp_code_actions', { path: 'a.mock', line: 2, apply: 'Replace ERROR' })
    expect(applied.output).toContain('Applied "Replace ERROR with OK"')
    expect(readFileSync(join(cwd, 'a.mock'), 'utf8')).toBe('def alpha\nuse OK here\n')
    const after = await call('lsp_diagnostics', { path: 'a.mock' })
    expect(after.output).toBe('No problems reported.')
    manager.stop()
  })

  test('lsp_servers shows the running server and what is available', async () => {
    const cwd = workspace({ 'a.mock': 'def alpha\n' })
    const { manager, call } = languageTools(cwd)
    await call('lsp_diagnostics', { path: 'a.mock' })
    const status = await call('lsp_servers', { path: 'a.mock' })
    expect(status.output).toContain('Running:')
    expect(status.output).toMatch(/mock\s+running/)
    manager.stop()
  })

  test('without the Rust core, the TypeScript client answers and Rust-only tools say what they need', async () => {
    process.env.JEAN_NATIVE = '0'
    try {
      const cwd = workspace({ 'a.mock': 'def alpha\n' })
      const { manager, call } = languageTools(cwd)
      expect(await manager.native()).toBeUndefined()
      const hierarchy = await call('lsp_hierarchy', { path: 'a.mock', line: 1, symbol: 'alpha', direction: 'incoming' })
      expect(hierarchy.isError).toBe(true)
      expect(hierarchy.output).toContain('jean native build')
      manager.stop()
    } finally {
      delete process.env.JEAN_NATIVE
    }
  })
})

// ---------------------------------------------------------------------------

const PROGRAM = 'print start\nset x\nprint middle\nset y\nprint end\n'
const MOCK_ADAPTER = {
  mock: {
    command: [bun, fixture('mock-dap-full.mjs')],
    transport: 'stdio',
    extensions: ['.prog'],
    defaults: { type: 'mock', request: 'launch' },
  },
}

function debugTools(cwd: string) {
  const debuggers = new DebugRegistry({ projectRoot: cwd, config: MOCK_ADAPTER, autoInstall: false })
  const registry = new Registry()
  registry.registerAll(createDebugTools(debuggers))
  const ctx = context(cwd)
  const call = (name: string, args: Record<string, unknown>) => registry.call(name, args, ctx, { approve: true })
  return { debuggers, call }
}

describe.skipIf(!built)('debugger tools on the Rust engine', () => {
  test('start runs to the breakpoint and shows the stack, the source line, and the variables', async () => {
    const cwd = workspace({ 'main.prog': PROGRAM })
    const { debuggers, call } = debugTools(cwd)

    const { result, calls } = await counted('dap.start', () => call('debug_start', { program: 'main.prog', breakpoints: ['main.prog:3'] }))
    expect(calls).toBe(1)
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('Stopped: breakpoint')
    expect(result.output).toContain('main.prog:3')
    expect(result.output).toContain('print middle')
    expect(result.output).toMatch(/line \S* ?= 3/)
    expect(result.output).toContain('Output:')

    const value = await call('debug_inspect', { expression: 'line + 41' })
    expect(value.output).toContain('line + 41 = 44')

    const changed = await call('debug_inspect', { variable: 'counter', value: '99' })
    expect(changed.output).toContain('counter = 99')
    expect((await call('debug_inspect', { expression: 'counter' })).output).toContain('= 99')

    // Added to the file's set, not replacing it.
    const added = await counted('dap.breakpoints', () => call('debug_breakpoint', { path: 'main.prog', line: 5 }))
    expect(added.calls).toBe(1)
    expect(added.result.output).toContain('Breakpoints in main.prog: 3, 5.')

    const next = await call('debug_control', { action: 'continue' })
    expect(next.output).toContain('main.prog:5')
    expect(next.output).toContain('print end')

    const done = await call('debug_control', { action: 'continue' })
    expect(done.output).toContain('The program exited with code 0')

    const all = await call('debug_output', { all: true })
    expect(all.output).toContain('start')
    expect(all.output).toContain('end')

    const status = await call('debug_status', {})
    expect(status.output).toMatch(/dbg-\d+\s+mock\s+exited/)
    expect((await call('debug_stop', {})).output).toMatch(/Ended dbg-\d+/)
    debuggers.stopAll()
  })

  test('breakpoints given before a session are set when it starts; conditions decide the stop', async () => {
    const cwd = workspace({ 'main.prog': PROGRAM })
    const { debuggers, call } = debugTools(cwd)

    const early = await call('debug_breakpoint', { path: 'main.prog', lines: [{ line: 3, condition: 'line > 3' }, 4] })
    expect(early.output).toContain('No session is running')

    const stopped = await call('debug_start', { program: 'main.prog' })
    expect(stopped.output).toContain('main.prog:4')
    await call('debug_stop', {})
    debuggers.stopAll()
  })

  test('uncaught exceptions stop the program, unless told otherwise', async () => {
    const cwd = workspace({ 'boom.prog': 'print before\ncrash\nprint never\n' })
    const { debuggers, call } = debugTools(cwd)
    const caught = await call('debug_start', { program: 'boom.prog' })
    expect(caught.output).toContain('Stopped: exception')
    await call('debug_stop', {})

    const through = await call('debug_start', { program: 'boom.prog', exceptions: 'none' })
    expect(through.output).toContain('exited with code 1')
    await call('debug_stop', {})
    debuggers.stopAll()
  })
})

// ---------------------------------------------------------------------------

/** A model that writes a file with an error in it, then stops. */
function writingClient(requests: CompletionRequest[]) {
  const script: ContentBlock[][] = [
    [{ type: 'tool_call', id: 'w1', name: 'write', input: { path: 'bad.mock', content: 'def alpha\nuse ERROR\n' } }],
    [{ type: 'text', text: 'Written.' }],
  ]
  let turn = 0
  const complete = async (request: CompletionRequest): Promise<CompletionResponse> => {
    requests.push(request)
    const content = script[turn++] ?? [{ type: 'text', text: 'done' }]
    return {
      content,
      stopReason: content.some((b) => b.type === 'tool_call') ? 'tool_use' : 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'scripted',
      provider: 'x',
      latencyMs: 1,
    }
  }
  return {
    resolve: () => ({ role: 'default', provider: 'x', modelId: 'scripted', maxTokens: 4096, fallbacks: [] }),
    isConfigured: () => true,
    complete,
    async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent, void, void> {
      const response = await complete(request)
      for (const block of response.content) {
        if (block.type === 'text') yield { type: 'text', delta: block.text }
        if (block.type === 'tool_call') yield { type: 'tool_call', id: block.id, name: block.name, input: block.input }
      }
      yield { type: 'done', response }
    },
  } as never
}

describe.skipIf(!built)('the agent loop', () => {
  test('an edit that introduces an error is answered with the error', async () => {
    const cwd = workspace({})
    const home = workspace({})
    const requests: CompletionRequest[] = []
    const config: JeanConfig = {
      ...defaultConfig(),
      permissionMode: 'full',
      advisor: { enabled: false },
      lsp: MOCK_SERVER,
      languageTools: { autoInstall: false },
    }
    const agent = new Orchestrator({
      config,
      client: writingClient(requests),
      cwd,
      sessionId: `lspdap-${Date.now()}`,
      policy: loadPolicy({ cwd, env: { ...process.env, HOME: home, USERPROFILE: home, JEAN_HOME: join(home, '.jean') } }),
    })
    await agent.send('Write bad.mock')
    const second = JSON.stringify(requests[1]?.messages ?? [])
    expect(second).toContain('Language server errors after this change')
    expect(second).toContain('found ERROR')
    agent.end('test')
  })
})
