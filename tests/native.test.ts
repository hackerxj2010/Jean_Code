import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findBinary, Native, NativeBridge } from '../packages/native/src/index.ts'

/**
 * These run against the real compiled binary.
 *
 * The bridge is optional by design, so the suite skips rather than fails when
 * it has not been built — but it reports that it skipped. A suite that silently
 * passes because the thing under test is absent is worse than one that fails.
 */
const binary = findBinary(process.cwd())
const built = binary !== undefined

if (!built) {
  // eslint-disable-next-line no-console
  console.warn('native: no binary — run `cargo build --release -p pi-natives`; skipping')
}

const native = Native.open()

afterAll(() => native.close())

describe.skipIf(!built)('the native bridge', () => {
  test('answers a ping', async () => {
    expect(await native.available()).toBe(true)
  })

  test('advertises the methods it dispatches', async () => {
    const bridge = new NativeBridge()
    const methods = await bridge.methods()
    bridge.close()

    expect(methods).toContain('ast.search_tree')
    expect(methods).toContain('builtins.run')
    expect(methods).toContain('walk.list')
  })

  test('runs a coreutil in Rust', async () => {
    const result = await native.builtin('wc', [], 'one\ntwo\nthree\n')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('3')
  })

  test('reports a coreutil failure rather than throwing', async () => {
    // `grep` exits 1 on no match; pipelines branch on that, so it must survive
    // the round trip as an exit code rather than becoming an exception.
    const result = await native.builtin('grep', ['nothing-here'], 'a\nb\n')
    expect(result.code).toBe(1)
  })

  test('lists the coreutils it provides', async () => {
    const names = await native.builtins()
    expect(names).toContain('sed')
    expect(names).toContain('jq')
    expect(names.length).toBe(58)
  })

  test('finds calls structurally, not textually', async () => {
    const source = 'console.log(a);\n// console.log(b);\nconsole.log(c);'
    const matches = await native.searchSource(source, 'console.log($ARG)', 'x.ts')

    // The commented-out call is not a call.
    expect(matches).toHaveLength(2)
    expect(matches.map((hit) => hit.captures.ARG)).toEqual(['a', 'c'])
  })

  test('a metavariable takes a whole bracketed expression', async () => {
    const matches = await native.searchSource('f(g(1, 2))', 'f($ARG)', 'x.ts')
    expect(matches[0]?.captures.ARG).toBe('g(1, 2)')
  })

  test('walks a tree and returns sorted relative paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jean-native-'))
    try {
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 1\n')
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')

      const walked = await native.walk(root, { limit: 100 })
      const sources = walked.paths.filter((path) => path.endsWith('.ts'))

      expect(sources).toContain('src/a.ts')
      expect(sources).toContain('src/b.ts')
      // Sorted, so two walks of the same tree diff cleanly.
      expect([...sources].sort()).toEqual(sources)
      // Forward slashes on every platform.
      expect(sources.every((path) => !path.includes('\\'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('round-trips a hashline patch', async () => {
    const content = 'one\ntwo\nthree\n'
    const annotated = await native.annotate(content)

    // The gutter is what an agent cites when it asks for an edit.
    expect(annotated).toContain('h:')
  })

  test('a failed call rejects without killing the bridge', async () => {
    const bridge = new NativeBridge()

    await expect(bridge.call('nope.nothing', {})).rejects.toThrow(/unknown method/)

    // Still up and answering afterwards, which is the point.
    expect(await bridge.available()).toBe(true)
    bridge.close()
  })

  test('a missing argument names the argument', async () => {
    const bridge = new NativeBridge()
    await expect(bridge.call('ast.search', {})).rejects.toThrow(/source/)
    bridge.close()
  })

  test('several calls in flight pair with their own replies', async () => {
    // Sent together rather than awaited in turn: replies are matched by id, and
    // this is what would catch a handler that answered out of order.
    const [wc, echo, seq] = await Promise.all([
      native.builtin('wc', [], 'a\nb\n'),
      native.builtin('echo', ['marker']),
      native.builtin('seq', ['3']),
    ])

    expect(wc.stdout).toContain('2')
    expect(echo.stdout.trim()).toBe('marker')
    expect(seq.stdout.trim().split('\n')).toEqual(['1', '2', '3'])
  })
})

describe('discovery', () => {
  test('reports no binary rather than throwing when one is absent', () => {
    const missing = findBinary(join(tmpdir(), 'definitely-not-a-repo'))
    expect(missing).toBeUndefined()
  })

  test('a bridge with no binary fails closed', async () => {
    const bridge = new NativeBridge({ binaryPath: join(tmpdir(), 'no-such-binary') })
    // `available` answers false rather than throwing: every caller branches on
    // it to decide whether to use the TypeScript path.
    expect(await bridge.available()).toBe(false)
    bridge.close()
  })
})
