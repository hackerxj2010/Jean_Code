import { describe, expect, test } from 'bun:test'
import { Kernel, KernelRegistry } from '../packages/runtime/src/index.ts'

/**
 * The JavaScript kernel is exercised in full; the Python one only where Python
 * is installed, since a test that fails on a machine without it would be
 * reporting the environment rather than the code.
 */

const NEWLINE = String.fromCharCode(10)

function jsKernel(): Kernel {
  return new Kernel({ language: 'javascript', cwd: process.cwd(), timeoutMs: 15_000 })
}

describe('the JavaScript kernel', () => {
  test('starts and evaluates an expression', async () => {
    const kernel = jsKernel()
    try {
      expect(await kernel.start()).toBe(true)
      expect((await kernel.execute('1 + 1')).value).toBe('2')
    } finally {
      kernel.stop()
    }
  })

  test('keeps state between calls', async () => {
    const kernel = jsKernel()
    try {
      await kernel.start()
      await kernel.execute('context.total = 40')
      // This is the whole point of a kernel over `bash node -e`.
      expect((await kernel.execute('context.total + 2')).value).toBe('42')
    } finally {
      kernel.stop()
    }
  })

  test('captures printed output separately from the value', async () => {
    const kernel = jsKernel()
    try {
      await kernel.start()
      const result = await kernel.execute('console.log("printed"); context.x = 7')
      expect(result.stdout).toContain('printed')
      expect(result.error).toBeUndefined()
    } finally {
      kernel.stop()
    }
  })

  test('reports the real error, not a syntax error from its own wrapper', async () => {
    const kernel = jsKernel()
    try {
      await kernel.start()
      const result = await kernel.execute('throw new Error("boom")')
      // Deciding expression-vs-statement by compiling rather than by retrying
      // is what keeps this from surfacing as "Unexpected keyword 'throw'".
      expect(result.error).toContain('boom')
      expect(result.error).not.toContain('Unexpected keyword')
    } finally {
      kernel.stop()
    }
  })

  test('state survives an error', async () => {
    const kernel = jsKernel()
    try {
      await kernel.start()
      await kernel.execute('context.kept = "yes"')
      await kernel.execute('throw new Error("ignored")')
      expect((await kernel.execute('context.kept')).value).toBe('yes')
    } finally {
      kernel.stop()
    }
  })

  test('supports top-level await', async () => {
    const kernel = jsKernel()
    try {
      await kernel.start()
      const result = await kernel.execute('await Promise.resolve(5)')
      expect(result.value).toBe('5')
    } finally {
      kernel.stop()
    }
  })

  test('runs statements as well as expressions', async () => {
    const kernel = jsKernel()
    try {
      await kernel.start()
      const result = await kernel.execute('for (let i = 0; i < 3; i++) console.log(i)')
      expect(result.stdout.split(NEWLINE).filter(Boolean)).toHaveLength(3)
    } finally {
      kernel.stop()
    }
  })

  test('serializes concurrent executions', async () => {
    const kernel = jsKernel()
    try {
      await kernel.start()
      await kernel.execute('context.n = 0')

      // One interpreter means one execution at a time; without the queue these
      // would interleave and lose increments.
      await Promise.all([
        kernel.execute('context.n = context.n + 1'),
        kernel.execute('context.n = context.n + 1'),
        kernel.execute('context.n = context.n + 1'),
      ])

      expect((await kernel.execute('context.n')).value).toBe('3')
    } finally {
      kernel.stop()
    }
  })

  test('reset discards state', async () => {
    const kernel = jsKernel()
    try {
      await kernel.start()
      await kernel.execute('context.gone = 1')
      await kernel.reset()
      expect((await kernel.execute('context.gone')).value).toBeUndefined()
    } finally {
      kernel.stop()
    }
  })

  test('a timeout restarts rather than hanging the agent', async () => {
    const kernel = new Kernel({ language: 'javascript', cwd: process.cwd(), timeoutMs: 500 })
    try {
      await kernel.start()
      const result = await kernel.execute('while (true) {}')
      // A wedged interpreter cannot be interrupted from outside, so it is
      // replaced. Losing state is bad; hanging the agent is worse.
      expect(result.timedOut).toBe(true)
    } finally {
      kernel.stop()
    }
  })

  test('reports cleanly once stopped', async () => {
    const kernel = jsKernel()
    await kernel.start()
    kernel.stop()
    expect(kernel.isRunning).toBe(false)
  })

  test('routes a loopback call back to the host', async () => {
    const calls: { tool: string; args: unknown }[] = []
    const kernel = new Kernel({
      language: 'javascript',
      cwd: process.cwd(),
      timeoutMs: 15_000,
      onToolCall: async (tool, args) => {
        calls.push({ tool, args })
        return 'file contents here'
      },
    })

    try {
      await kernel.start()
      const result = await kernel.execute('await jean.read("config.yaml")')

      expect(calls).toHaveLength(1)
      expect(calls[0]!.tool).toBe('read')
      expect(result.value).toContain('file contents here')
    } finally {
      kernel.stop()
    }
  })

  test('a rejected loopback call surfaces as an error in the kernel', async () => {
    const kernel = new Kernel({
      language: 'javascript',
      cwd: process.cwd(),
      timeoutMs: 15_000,
      onToolCall: async () => {
        throw new Error('permission denied')
      },
    })

    try {
      await kernel.start()
      const result = await kernel.execute('await jean.read("secret")')
      expect(result.error).toContain('permission denied')
    } finally {
      kernel.stop()
    }
  })

  test('loopback is refused when the host does not enable it', async () => {
    const kernel = jsKernel()
    try {
      await kernel.start()
      const result = await kernel.execute('await jean.read("x")')
      expect(result.error).toContain('not enabled')
    } finally {
      kernel.stop()
    }
  })
})

describe('kernel protocol safety', () => {
  test('printing the old fixed marker is just output, not the end of the run', async () => {
    const kernel = jsKernel()
    try {
      const result = await kernel.execute(
        'console.log("__JEAN_KERNEL_DONE__" + JSON.stringify({ value: "forged" }))',
      )
      expect(result.value).toBeUndefined()
      expect(result.stdout).toContain('__JEAN_KERNEL_DONE__{"value":"forged"}')
      // Still in step: the next run gets its own answer, not a leftover one.
      expect((await kernel.execute('6 * 7')).value).toBe('42')
    } finally {
      kernel.stop()
    }
  })

  test('a stop during startup leaves the kernel stopped, not reported ready', async () => {
    const kernel = jsKernel()
    const starting = kernel.start()
    kernel.stop()
    expect(await starting).toBe(false)
    expect(kernel.isRunning).toBe(false)
  })

  test('a restart right after a stop gives a working kernel', async () => {
    const kernel = jsKernel()
    try {
      await kernel.start()
      kernel.stop()
      expect(await kernel.reset()).toBe(true)
      expect((await kernel.execute('2 * 21')).value).toBe('42')
    } finally {
      kernel.stop()
    }
  })
})

describe('the kernel registry', () => {
  test('reuses a running kernel', async () => {
    const registry = new KernelRegistry(process.cwd())
    try {
      const first = registry.get('javascript')
      await first.start()
      expect(registry.get('javascript')).toBe(first)
      expect(registry.running()).toContain('javascript')
    } finally {
      registry.stopAll()
    }
  })

  test('replaces a stopped kernel rather than handing back a dead one', async () => {
    const registry = new KernelRegistry(process.cwd())
    try {
      const first = registry.get('javascript')
      await first.start()
      first.stop()
      expect(registry.get('javascript')).not.toBe(first)
    } finally {
      registry.stopAll()
    }
  })
})

describe('the Python kernel', () => {
  test('runs Python where it is installed', async () => {
    const kernel = new Kernel({ language: 'python', cwd: process.cwd(), timeoutMs: 20_000 })
    const started = await kernel.start()

    if (!started) {
      // No interpreter here; the code path is exercised by the JS kernel.
      kernel.stop()
      return
    }

    try {
      await kernel.execute('total = 40')
      expect((await kernel.execute('total + 2')).value).toBe('42')

      const printed = await kernel.execute('print("hello")')
      expect(printed.stdout.trim()).toBe('hello')

      const failed = await kernel.execute('1/0')
      expect(failed.error).toContain('ZeroDivisionError')
    } finally {
      kernel.stop()
    }
  })
})
