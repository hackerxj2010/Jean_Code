import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '../packages/config/src/index.ts'
import { DebugRegistry, NativeDebuggers, createDebugTools } from '../packages/dap/src/index.ts'
import { nativeReady } from '../packages/native/src/index.ts'
import { Registry, createSessionState } from '../packages/tools/src/index.ts'

/**
 * The debug tools against the real debuggers — debugpy, js-debug, CodeLLDB —
 * each one only where it is installed (`jean setup` installs them all).
 * Every program is debugged the way an agent does it: break on a line, read
 * a value, step, run to the end, read what it printed.
 */

setDefaultTimeout(180_000)

const probe = await NativeDebuggers.open({ projectRoot: process.cwd(), autoInstall: false }).catch(() => undefined)
const installed = new Set((await probe?.adapters().catch(() => []))?.filter((a) => a.status === 'installed').map((a) => a.id) ?? [])
const hasCargo = Bun.which('cargo') !== null

const temps: string[] = []
afterEach(async () => {
  await (await nativeReady())?.dap('stop', {}).catch(() => undefined)
})
afterAll(() => {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch {}
  }
})

async function debugging(files: Record<string, string>) {
  // The long form of the path: what an agent's workspace usually is.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'jean-realdbg-')))
  temps.push(dir)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const registry = new Registry()
  const debuggers = new DebugRegistry({ projectRoot: dir, autoInstall: false })
  registry.registerAll(createDebugTools(debuggers))
  const ctx = { cwd: dir, config: defaultConfig(), session: createSessionState(dir) }
  const call = (name: string, args: Record<string, unknown>) => registry.call(name, args, ctx, { approve: true })
  return { call, stop: () => debuggers.stopAll() }
}

describe('real debuggers', () => {
  test.skipIf(!installed.has('debugpy'))('Python through debugpy', async () => {
    const { call, stop } = await debugging({
      'main.py': 'def add(a, b):\n    return a + b\n\ntotal = add(2, 3)\nitems = [total, total + 1]\nprint("total", total)\n',
    })
    try {
      const started = await call('debug_start', { program: 'main.py', breakpoints: ['main.py:5'], waitMs: 60_000 })
      expect(started.output).toContain('Stopped: breakpoint')
      expect(started.output).toContain('main.py:5')
      expect(started.output).toContain('total (int) = 5')
      // debugpy's dunder groups are not opened, and module globals are not listed twice.
      expect(started.output).not.toContain('__builtins__')
      expect(started.output).toContain('Globals: the same as Locals')

      expect((await call('debug_inspect', { expression: 'total * 2' })).output).toContain('10')
      expect((await call('debug_control', { action: 'next' })).output).toContain('main.py:6')

      const ended = await call('debug_control', { action: 'continue' })
      expect(ended.output).toContain('exited with code 0')
      expect(ended.output).toContain('total 5')
    } finally {
      stop()
    }
  })

  test.skipIf(!installed.has('js-debug'))('JavaScript through js-debug and its child session', async () => {
    const { call, stop } = await debugging({
      'main.js': 'function add(a, b) {\n  return a + b\n}\nconst total = add(2, 3)\nconst items = [total, total + 1]\nconsole.log("total", total)\n',
    })
    try {
      const started = await call('debug_start', { program: 'main.js', breakpoints: ['main.js:5'], waitMs: 60_000 })
      expect(started.output).toContain('main.js:5')
      expect(started.output).toContain('total (number) = 5')
      // Node's own frames fold, the CommonJS wrapper is hidden, the inspector's chatter is dropped.
      expect(started.output).toMatch(/\.\.\. \d+ runtime frames?/)
      expect(started.output).not.toContain('__dirname')
      expect(started.output).not.toContain('Debugger attached')

      expect((await call('debug_inspect', { expression: 'total * 2' })).output).toContain('10')
      const ended = await call('debug_control', { action: 'continue' })
      expect(ended.output).toContain('The session has ended')
      expect(ended.output).toContain('total 5')
      expect(ended.output).not.toContain('Waiting for the debugger')
      // A finished program says so rather than answering with nothing.
      const late = await call('debug_control', { action: 'next' })
      expect(late.isError).toBe(true)
      expect(late.output).toContain('has ended')
    } finally {
      stop()
    }
  })

  test.skipIf(!installed.has('js-debug'))('TypeScript run by Node itself', async () => {
    const { call, stop } = await debugging({
      'main.ts': 'function add(a: number, b: number): number {\n  return a + b\n}\nconst total: number = add(2, 3)\nconst items: number[] = [total, total + 1]\nconsole.log("total", total)\n',
    })
    try {
      const started = await call('debug_start', { program: 'main.ts', breakpoints: ['main.ts:5'], waitMs: 60_000 })
      expect(started.output).toContain('main.ts:5')
      expect(started.output).toContain('total (number) = 5')
      const ended = await call('debug_control', { action: 'continue' })
      expect(ended.output).toContain('total 5')
    } finally {
      stop()
    }
  })

  test.skipIf(!installed.has('codelldb') || !hasCargo)('Rust through CodeLLDB, built from its source', async () => {
    const { call, stop } = await debugging({
      'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/main.rs':
        'fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\nfn main() {\n    let total = add(2, 3);\n    let items = vec![total, total + 1];\n    println!("total {total}");\n    println!("items {}", items.len());\n}\n',
    })
    try {
      const started = await call('debug_start', { program: 'src/main.rs', breakpoints: ['src/main.rs:7'], waitMs: 170_000 })
      expect(started.output).toContain('demo::main')
      expect(started.output).toContain('src/main.rs:7')
      expect(started.output).toContain('total (int) = 5')
      // The runtime's statics and registers are left for the asking.
      expect(started.output).toContain('Registers: not fetched')

      // An expression, not an LLDB command.
      expect((await call('debug_inspect', { expression: 'total' })).output).toContain('total = 5')
      expect((await call('debug_control', { action: 'next' })).output).toContain('src/main.rs:8')

      const ended = await call('debug_control', { action: 'continue' })
      expect(ended.output).toContain('exited with code 0')
      // The program's own stdout, which CodeLLDB leaves on its stdio.
      expect(ended.output).toContain('total 5')
      expect(ended.output).not.toContain('Launched process')
    } finally {
      stop()
    }
  })

  test.skipIf(!installed.has('codelldb') || !hasCargo)('a Rust build that fails answers with the compiler errors', async () => {
    const { call, stop } = await debugging({
      'Cargo.toml': '[package]\nname = "broken"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/main.rs': 'fn main() {\n    let x: i32 = "text";\n}\n',
    })
    try {
      const started = await call('debug_start', { program: 'src/main.rs', breakpoints: ['src/main.rs:2'], waitMs: 170_000 })
      expect(started.isError).toBe(true)
      expect(started.output).toContain('cargo build failed')
      expect(started.output).toContain('mismatched types')
    } finally {
      stop()
    }
  })
})
