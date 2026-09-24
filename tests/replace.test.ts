import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '../packages/config/src/index.ts'
import {
  Registry,
  ReplaceError,
  type ToolContext,
  builtinTools,
  createSessionState,
  replaceText,
  similarity,
} from '../packages/tools/src/index.ts'

/**
 * The replacement engine behind `edit`'s `old_string` form.
 *
 * Every tolerance here exists because a model makes that exact slip, and every
 * refusal exists because guessing would edit the wrong code. Both directions
 * are tested: a matcher that is too strict wastes turns, and one that is too
 * loose corrupts files.
 */

describe('exact matching', () => {
  test('replaces a unique occurrence', () => {
    const result = replaceText('const a = 1\nconst b = 2\n', 'const a = 1', 'const a = 42')
    expect(result.content).toBe('const a = 42\nconst b = 2\n')
    expect(result.strategy).toBe('exact')
    expect(result.count).toBe(1)
  })

  test('refuses an ambiguous match and names every line', () => {
    try {
      replaceText('x = 1\ny = 2\nx = 1\n', 'x = 1', 'x = 3')
      throw new Error('expected a throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ReplaceError)
      expect((err as ReplaceError).code).toBe('ambiguous')
      expect((err as Error).message).toContain('lines 1, 3')
    }
  })

  test('replace_all changes every occurrence', () => {
    const result = replaceText('x = 1\ny = 2\nx = 1\n', 'x = 1', 'x = 3', { replaceAll: true })
    expect(result.content).toBe('x = 3\ny = 2\nx = 3\n')
    expect(result.count).toBe(2)
  })

  test('refuses a no-op and an empty search', () => {
    expect(() => replaceText('a', 'a', 'a')).toThrow(/identical/)
    expect(() => replaceText('a', '', 'b')).toThrow(/empty/)
  })

  test('reports the line range of the replacement', () => {
    const result = replaceText('a\nb\nc\nd\n', 'c', 'c1\nc2\nc3')
    expect(result.firstLine).toBe(3)
    expect(result.lastLine).toBe(5)
  })
})

describe('tolerant matching', () => {
  const source = [
    'class Limiter {',
    '    hit(key) {',
    '        this.count += 1',
    '        return this.count',
    '    }',
    '}',
    '',
  ].join('\n')

  test('matches with the wrong indentation and re-indents the replacement', () => {
    // The model quoted the block at two-space indentation; the file uses four.
    const result = replaceText(
      source,
      '  hit(key) {\n    this.count += 1',
      '  hit(key) {\n    this.count += 2',
    )
    expect(result.strategy).toBe('line-trimmed')
    expect(result.content).toContain('    hit(key) {\n        this.count += 2')
  })

  test('matches with collapsed whitespace', () => {
    const result = replaceText('foo(a,   b)\n', 'foo(a, b)', 'foo(a, c)')
    expect(result.strategy).toBe('whitespace-normalized')
    expect(result.content).toBe('foo(a, c)\n')
  })

  test('decodes literal escape sequences', () => {
    const result = replaceText('one\ntwo\n', 'one\\ntwo', 'one\\nthree')
    expect(result.strategy).toBe('escape-normalized')
    expect(result.content).toBe('one\nthree\n')
  })

  test('ignores stray whitespace at the ends of old_string', () => {
    const result = replaceText('let value = 1;\n', '  let value = 1;  ', 'let value = 2;')
    expect(result.content).toBe('let value = 2;\n')
  })

  test('matches a block whose middle drifted slightly', () => {
    const file = [
      'function total(items) {',
      '  let sum = 0',
      '  for (const item of items) sum += item.price',
      '  return sum',
      '}',
    ].join('\n')
    const quoted = [
      'function total(items) {',
      '  let sum = 0',
      '  for (const item of items) sum += item.prices',
      '  return sum',
      '}',
    ].join('\n')
    const result = replaceText(file, quoted, 'const total = (items) => 0')
    expect(result.strategy).toBe('block-anchor')
    expect(result.content).toBe('const total = (items) => 0')
  })

  test('does not guess between two similar blocks', () => {
    const block = (name: string) => `function ${name}() {\n  work()\n  more()\n}`
    const file = `${block('a')}\n${block('a')}\n`
    expect(() => replaceText(file, 'function a() {\n  work()\n  mor()\n}', 'gone')).toThrow(
      ReplaceError,
    )
  })

  test('preserves CRLF line endings', () => {
    const result = replaceText('a\r\nb\r\nc\r\n', 'b\nc', 'B\nC')
    expect(result.content).toBe('a\r\nB\r\nC\r\n')
  })

  test('a trailing newline in old_string that new_string drops removes the line break', () => {
    // Quoted at the wrong indentation, so the line matcher (not exact) lands it.
    const result = replaceText('keep\n  drop me\nafter\n', '    drop me\n', '')
    expect(result.strategy).toBe('line-trimmed')
    expect(result.content).toBe('keep\nafter\n')
  })

  test('maps a two-space quote onto a four-space file at every depth', () => {
    const file = 'fn() {\n    if (a) {\n        b()\n    }\n}\n'
    const result = replaceText(
      file,
      '  if (a) {\n    b()\n  }',
      '  if (a) {\n    b()\n    if (c) {\n      d()\n    }\n  }',
    )
    expect(result.content).toBe(
      'fn() {\n    if (a) {\n        b()\n        if (c) {\n            d()\n        }\n    }\n}\n',
    )
  })

  test('maps onto a tab-indented file', () => {
    const file = 'fn() {\n\tif (a) {\n\t\tb()\n\t}\n}\n'
    const result = replaceText(file, '  if (a) {\n    b()', '  if (a) {\n    c()')
    expect(result.content).toBe('fn() {\n\tif (a) {\n\t\tc()\n\t}\n}\n')
  })
})

describe('not found', () => {
  test('points at the closest region with line numbers', () => {
    const file = ['import x', '', 'function run() {', '  start()', '  stop()', '}', ''].join('\n')
    try {
      replaceText(file, 'function run() {\n  begin()\n  stop()\n}', 'x')
      throw new Error('expected a throw')
    } catch (err) {
      const hint = (err as ReplaceError).hint ?? ''
      expect((err as ReplaceError).code).toBe('not-found')
      expect(hint).toContain('lines 3-6')
      expect(hint).toContain('≠│   start()')
    }
  })

  test('gives generic advice when nothing is similar', () => {
    try {
      replaceText('alpha\nbeta\n', 'completely unrelated', 'x')
    } catch (err) {
      expect((err as ReplaceError).hint).toContain('Re-read the file')
    }
  })
})

describe('similarity', () => {
  test('is 1 for identical and 0 against empty', () => {
    expect(similarity('abc', 'abc')).toBe(1)
    expect(similarity('abc', '')).toBe(0)
  })

  test('ranks a one-character change as nearly identical', () => {
    expect(similarity('item.price', 'item.prices')).toBeGreaterThan(0.9)
  })
})

// ---------------------------------------------------------------------------
// Through the tool, end to end.

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(files: Record<string, string>): {
  dir: string
  ctx: ToolContext
  registry: Registry
} {
  const dir = mkdtempSync(join(tmpdir(), 'jean-replace-'))
  temps.push(dir)
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content)
  const registry = new Registry()
  registry.registerAll(builtinTools())
  const ctx: ToolContext = {
    cwd: dir,
    config: { ...defaultConfig(), permissionMode: 'full' },
    session: createSessionState(dir),
  }
  return { dir, ctx, registry }
}

describe('the edit tool', () => {
  test('read shows line numbers alongside anchors', async () => {
    const { ctx, registry } = setup({ 'a.ts': 'one\ntwo\n' })
    const read = await registry.call('read', { path: 'a.ts' }, ctx)
    expect(read.output).toMatch(/^1 h:[0-9a-f]{8} │ one$/m)
    expect(read.output).toMatch(/^2 h:[0-9a-f]{8} │ two$/m)
  })

  test('replaces text and shows the edited region', async () => {
    const { dir, ctx, registry } = setup({ 'a.ts': 'const a = 1\nconst b = 2\n' })
    await registry.call('read', { path: 'a.ts' }, ctx)
    const result = await registry.call(
      'edit',
      { path: 'a.ts', old_string: 'const a = 1', new_string: 'const a = 42' },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('const a = 42\nconst b = 2\n')
    expect(result.output).toMatch(/1 h:[0-9a-f]{8} │ const a = 42/)
    expect(result.touched).toHaveLength(1)
  })

  test('a batch is all or nothing', async () => {
    const { dir, ctx, registry } = setup({ 'a.ts': 'alpha\nbeta\n' })
    await registry.call('read', { path: 'a.ts' }, ctx)
    const result = await registry.call(
      'edit',
      {
        path: 'a.ts',
        edits: [
          { old_string: 'alpha', new_string: 'ALPHA' },
          { old_string: 'gamma', new_string: 'GAMMA' },
        ],
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('edits[1]')
    expect(result.output).toContain('No edits were written')
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('alpha\nbeta\n')
  })

  test('a batch applies each edit to the result of the previous one', async () => {
    const { dir, ctx, registry } = setup({ 'a.ts': 'x\n' })
    await registry.call('read', { path: 'a.ts' }, ctx)
    await registry.call(
      'edit',
      {
        path: 'a.ts',
        edits: [
          { old_string: 'x', new_string: 'y' },
          { old_string: 'y', new_string: 'z' },
        ],
      },
      ctx,
    )
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('z\n')
  })

  test('reports a fuzzy match so the model knows its picture was off', async () => {
    const { ctx, registry } = setup({ 'a.ts': 'if (x) {\n    go()\n}\n' })
    await registry.call('read', { path: 'a.ts' }, ctx)
    const result = await registry.call(
      'edit',
      { path: 'a.ts', old_string: 'if (x) {\n  go()', new_string: 'if (x) {\n  stop()' },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('re-indented')
  })

  test('still requires a prior read', async () => {
    const { ctx, registry } = setup({ 'a.ts': 'a\n' })
    const result = await registry.call(
      'edit',
      { path: 'a.ts', old_string: 'a', new_string: 'b' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('has not been read')
  })

  test('explains what is missing when no form was given', async () => {
    const { ctx, registry } = setup({ 'a.ts': 'a\n' })
    await registry.call('read', { path: 'a.ts' }, ctx)
    const result = await registry.call('edit', { path: 'a.ts' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('old_string')
  })
})
