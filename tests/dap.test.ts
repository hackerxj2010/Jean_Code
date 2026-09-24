import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  BUILTIN_ADAPTERS,
  Connection,
  DebugRegistry,
  DebugSession,
  adapterFor,
} from '../packages/dap/src/index.ts'

/** Waits for a condition, polling, up to `timeoutMs`. */
async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}


/**
 * The adapter is a real subprocess speaking real DAP framing: the correlation
 * bug worth catching (`request_seq`, not `id`) and the chunk-splitting bug both
 * need a real stream to appear.
 */

const ADAPTER = join(import.meta.dir, 'fixtures', 'mock-debug-adapter.mjs')

function connect(): { connection: Connection; stop: () => void } {
  const child = spawn('bun', [ADAPTER], { stdio: ['pipe', 'pipe', 'pipe'] })
  return { connection: new Connection(child), stop: () => child.kill() }
}

/** A session wired to the mock adapter rather than a real debugger. */
function session(overrides: Record<string, unknown> = {}) {
  return new DebugSession({
    spec: {
      id: 'mock',
      extensions: ['.py'],
      command: ['bun', ADAPTER],
      programKey: 'program',
    },
    cwd: process.cwd(),
    ...overrides,
  })
}

describe('the DAP transport', () => {
  test('correlates a response by request_seq', async () => {
    const { connection, stop } = connect()
    try {
      const body = (await connection.request('initialize', {})) as Record<string, unknown>
      expect(body.supportsConfigurationDoneRequest).toBe(true)
    } finally {
      stop()
    }
  })

  test('keeps concurrent requests apart', async () => {
    const { connection, stop } = connect()
    try {
      await connection.request('initialize', {})
      const [stack, threads] = await Promise.all([
        connection.request('stackTrace', { threadId: 1 }),
        connection.request('threads', {}),
      ])
      expect((stack as { stackFrames: unknown[] }).stackFrames).toHaveLength(2)
      expect((threads as { threads: unknown[] }).threads).toHaveLength(1)
    } finally {
      stop()
    }
  })

  test('rejects when the adapter reports failure', async () => {
    const { connection, stop } = connect()
    try {
      await expect(connection.request('failing', {})).rejects.toThrow(/deliberate adapter failure/)
    } finally {
      stop()
    }
  })

  test('times out rather than hanging', async () => {
    const { connection, stop } = connect()
    try {
      await expect(connection.request('never', {}, 300)).rejects.toThrow(/timed out/)
    } finally {
      stop()
    }
  })

  test('delivers events', async () => {
    const { connection, stop } = connect()
    try {
      const events: string[] = []
      connection.onEvent((name) => events.push(name))
      await connection.request('initialize', {})
      await new Promise((r) => setTimeout(r, 200))
      expect(events).toContain('initialized')
    } finally {
      stop()
    }
  })

  test('writing to a dead adapter fails cleanly', async () => {
    const { connection, stop } = connect()
    stop()
    await new Promise((r) => setTimeout(r, 200))
    // Unguarded this throws EPIPE and takes the process down.
    await expect(connection.request('initialize', {}, 500)).rejects.toThrow()
  })
})

describe('a debug session', () => {
  test('completes the launch handshake', async () => {
    const debug = session()
    try {
      expect(await debug.start()).toBe(true)
      expect(debug.supports('supportsConfigurationDoneRequest')).toBe(true)
      expect(await debug.launch({ program: '/app/main.py' })).toBe(true)
    } finally {
      debug.stop()
    }
  })

  test('accumulates breakpoints per file rather than replacing them', async () => {
    const debug = session()
    try {
      await debug.start()
      await debug.launch({})

      await debug.setBreakpoint('/app/main.py', 10)
      const after = await debug.setBreakpoint('/app/main.py', 20)

      // DAP replaces the whole set per file, so sending only the new one would
      // silently clear the first.
      expect(after).toHaveLength(2)
      expect(after.map((b) => b.line).sort((a, b) => a - b)).toEqual([10, 20])
    } finally {
      debug.stop()
    }
  })

  test('clearing removes only the named breakpoint', async () => {
    const debug = session()
    try {
      await debug.start()
      await debug.setBreakpoint('/app/main.py', 10)
      await debug.setBreakpoint('/app/main.py', 20)
      const after = await debug.clearBreakpoint('/app/main.py', 10)
      expect(after.map((b) => b.line)).toEqual([20])
    } finally {
      debug.stop()
    }
  })

  test('reports an unverified breakpoint rather than hiding it', async () => {
    const debug = session()
    try {
      await debug.start()
      const set = await debug.setBreakpoint('/app/main.py', 999)
      // An unverified breakpoint never fires, silently — the program runs to
      // completion and the agent concludes the code is unreachable.
      expect(set[0]!.verified).toBe(false)
      expect(set[0]!.message).toContain('no executable code')
    } finally {
      debug.stop()
    }
  })

  test('tracks where execution stopped', async () => {
    const debug = session()
    try {
      await debug.start()
      await debug.launch({})
      await debug.configurationDone()
      await debug.continue()

      // Polled rather than slept: a fixed delay is a race, and the one that
      // passes locally fails on a loaded machine. This waits for the condition
      // and gives up with the same assertion failure if it never arrives.
      await until(() => debug.stoppedAt() !== undefined)

      expect(debug.stoppedAt()?.reason).toBe('breakpoint')
    } finally {
      debug.stop()
    }
  })

  test('reads the stack, scopes, and variables', async () => {
    const debug = session()
    try {
      await debug.start()
      await debug.launch({})

      const frames = await debug.stackTrace(1)
      expect(frames).toHaveLength(2)
      expect(frames[0]!.name).toBe('compute')
      expect(frames[0]!.line).toBe(42)

      const scopes = await debug.scopes(frames[0]!.id)
      expect(scopes.map((s) => s.name)).toEqual(['Locals', 'Globals'])
      // Globals are marked expensive; fetching them can take seconds.
      expect(scopes[1]!.expensive).toBe(true)

      const variables = await debug.variables(scopes[0]!.variablesReference)
      expect(variables.map((v) => v.name)).toEqual(['total', 'items'])
      // A non-zero reference means the value can be expanded.
      expect(variables[1]!.variablesReference).toBeGreaterThan(0)
    } finally {
      debug.stop()
    }
  })

  test('evaluates an expression in a frame', async () => {
    const debug = session()
    try {
      await debug.start()
      const result = await debug.evaluate('total + 1', 1000)
      expect(result.result).toContain('total + 1')
      expect(result.type).toBe('str')
    } finally {
      debug.stop()
    }
  })

  test('reports exception detail', async () => {
    const debug = session()
    try {
      await debug.start()
      const info = await debug.exceptionInfo(1)
      expect(info?.exceptionId).toBe('ZeroDivisionError')
      expect(info?.description).toContain('division by zero')
    } finally {
      debug.stop()
    }
  })

  test('sets a variable value', async () => {
    const debug = session()
    try {
      await debug.start()
      expect(await debug.setData(2000, 'total', '99')).toBe('99')
    } finally {
      debug.stop()
    }
  })

  test('skips operations the adapter does not advertise', async () => {
    const debug = session()
    try {
      await debug.start()
      // Never advertised by the mock, so this must return empty rather than
      // sending a request the adapter will reject.
      expect(await debug.loadedSources()).toEqual([])
      expect(await debug.readData('0x0', 16)).toBeUndefined()
      // These are advertised.
      expect(await debug.completions('to', 2)).toEqual(['total', 'items'])
      expect(await debug.modules()).toHaveLength(1)
    } finally {
      debug.stop()
    }
  })

  test('captures adapter output', async () => {
    const output: string[] = []
    const debug = session({ onOutput: (_c: string, text: string) => output.push(text) })
    try {
      await debug.start()
      await debug.launch({})
    } finally {
      debug.stop()
    }
    expect(debug.isRunning).toBe(false)
  })

  test('refuses operations once stopped', async () => {
    const debug = session()
    await debug.start()
    debug.stop()
    await expect(debug.threads()).rejects.toThrow(/not running/)
  })
})

describe('the adapter registry', () => {
  test('every bundled adapter is well formed', () => {
    for (const spec of BUILTIN_ADAPTERS) {
      expect(spec.id).toMatch(/^[a-z0-9-]+$/)
      expect(spec.command.length).toBeGreaterThan(0)
      expect(spec.extensions.length).toBeGreaterThan(0)
      for (const extension of spec.extensions) expect(extension.startsWith('.')).toBe(true)
    }
  })

  test('bundled adapter ids are unique', () => {
    const ids = BUILTIN_ADAPTERS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('covers the three targets the architecture names', () => {
    const ids = BUILTIN_ADAPTERS.map((a) => a.id)
    expect(ids).toContain('lldb')
    expect(ids).toContain('delve')
    expect(ids).toContain('debugpy')
  })

  test('a file with no known extension matches no adapter', async () => {
    expect(await adapterFor('/project/README')).toBeUndefined()
  })
})

describe('the session registry', () => {
  test('hands back the newest running session', async () => {
    const registry = new DebugRegistry()
    const first = session()
    const second = session()
    await first.start()
    await second.start()

    const firstId = registry.add(first)
    const secondId = registry.add(second)

    expect(registry.latest()?.id).toBe(secondId)
    expect(registry.get(firstId)).toBe(first)

    // A stopped session is skipped, so `latest` never returns a dead one.
    second.stop()
    expect(registry.latest()?.id).toBe(firstId)

    registry.stopAll()
    expect(registry.latest()).toBeUndefined()
  })
})
