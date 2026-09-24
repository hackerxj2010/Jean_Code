import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { CheckpointStore, createAskTool, createSessionState, defaultConfigForTest } from './helpers/tool-context.ts'
import { compilePattern, matchInText, searchStructural } from '../packages/codemap/src/index.ts'
import { parseRemote } from '../packages/github/src/index.ts'

const temps: string[] = []

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'jean-new-'))
  temps.push(dir)
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true })
})

describe('checkpoints', () => {
  function store(cwd: string): CheckpointStore {
    return new CheckpointStore(cwd, join(workspace(), 'store'))
  }

  test('snapshots the tree and lists snapshots', async () => {
    const cwd = workspace({ 'a.ts': 'export const a = 1\n', 'src/b.ts': 'export const b = 2\n' })
    const s = store(cwd)

    const checkpoint = await s.create('before the refactor')
    expect(checkpoint.fileCount).toBe(2)
    expect((await s.list())[0]!.label).toBe('before the refactor')
  })

  test('reports what changed since a checkpoint', async () => {
    const cwd = workspace({ 'a.ts': 'original\n' })
    const s = store(cwd)
    const checkpoint = await s.create('start')

    writeFileSync(join(cwd, 'a.ts'), 'modified\n')
    writeFileSync(join(cwd, 'new.ts'), 'added\n')

    const changes = await s.diff(checkpoint.id)
    expect(changes.modified).toEqual(['a.ts'])
    expect(changes.added).toEqual(['new.ts'])
    expect(changes.deleted).toEqual([])
  })

  test('restores modified files and removes added ones', async () => {
    const cwd = workspace({ 'a.ts': 'original\n' })
    const s = store(cwd)
    const checkpoint = await s.create('start')

    writeFileSync(join(cwd, 'a.ts'), 'broken\n')
    writeFileSync(join(cwd, 'oops.ts'), 'should not survive\n')

    await s.restore(checkpoint.id)

    expect(readFileSync(join(cwd, 'a.ts'), 'utf8')).toBe('original\n')
    // "Roll back" means the tree matches, so files added since must go.
    expect(existsSync(join(cwd, 'oops.ts'))).toBe(false)
  })

  test('brings back a deleted file', async () => {
    const cwd = workspace({ 'important.ts': 'do not lose me\n' })
    const s = store(cwd)
    const checkpoint = await s.create('start')

    rmSync(join(cwd, 'important.ts'))
    await s.restore(checkpoint.id)

    expect(readFileSync(join(cwd, 'important.ts'), 'utf8')).toBe('do not lose me\n')
  })

  test('stores identical content once across checkpoints', async () => {
    const cwd = workspace({ 'a.ts': 'unchanged\n' })
    const s = store(cwd)

    const first = await s.create('one')
    const second = await s.create('two')

    // Content-addressed: an unchanged tree costs nothing to checkpoint again.
    expect(first.files['a.ts']).toBe(second.files['a.ts']!)
  })

  test('a restore of an unchanged tree does nothing', async () => {
    const cwd = workspace({ 'a.ts': 'same\n' })
    const s = store(cwd)
    const checkpoint = await s.create('start')

    const result = await s.restore(checkpoint.id)
    expect(result.restored).toBe(0)
    expect(result.removed).toBe(0)
  })

  test('reports an unknown checkpoint rather than doing nothing', async () => {
    const s = store(workspace())
    await expect(s.diff('nonexistent')).rejects.toThrow(/no checkpoint/)
  })

  test('removes a checkpoint', async () => {
    const cwd = workspace({ 'a.ts': 'x\n' })
    const s = store(cwd)
    const checkpoint = await s.create('temp')

    expect(await s.remove(checkpoint.id)).toBe(true)
    expect(await s.list()).toHaveLength(0)
    expect(await s.remove(checkpoint.id)).toBe(false)
  })
})

describe('the ask tool', () => {
  test('returns the user answer', async () => {
    const tool = createAskTool(async (request) => `chose from ${request.options?.length ?? 0}`)
    const result = await tool.execute(
      { question: 'Which database?', options: ['postgres', 'sqlite'] },
      createSessionState(process.cwd()),
    )
    expect(result.output).toContain('chose from 2')
  })

  test('refuses rather than blocking when nobody can answer', async () => {
    const tool = createAskTool(undefined)
    // Waiting forever in a non-interactive run is the worst outcome.
    await expect(
      tool.execute({ question: 'anything?' }, createSessionState(process.cwd())),
    ).rejects.toThrow(/non-interactive/)
  })

  test('tells the agent to proceed when the user declines to answer', async () => {
    const tool = createAskTool(async () => undefined)
    const result = await tool.execute(
      { question: 'which one?' },
      createSessionState(process.cwd()),
    )
    expect(result.output).toContain('reasonable choice')
  })
})

describe('structural search', () => {
  test('matches regardless of spacing', () => {
    const source = ['try { a() } catch (e) {}', 'try { b() } catch(err){}'].join('\n')
    const matches = matchInText(source, 'catch ($E) {}')

    // `grep` for `catch (e) {}` finds the first and misses the second.
    expect(matches).toHaveLength(2)
    expect(matches.map((m) => m.captures.E)).toEqual(['e', 'err'])
  })

  test('captures a member expression and a call', () => {
    const matches = matchInText('JSON.parse(raw)\nJSON.parse(other.thing)', 'JSON.parse($ARG)')
    expect(matches.map((m) => m.captures.ARG)).toEqual(['raw', 'other.thing'])
  })

  test('$$$ matches any run of arguments', () => {
    const matches = matchInText(
      ['console.log(a)', 'console.log(a, b, c)', 'console.log()'].join('\n'),
      'console.log($$$)',
    )
    expect(matches).toHaveLength(3)
  })

  test('reports line numbers', () => {
    const matches = matchInText('first\nsecond\nfoo(bar)', 'foo($X)')
    expect(matches[0]!.line).toBe(3)
  })

  test('compiles a pattern with its metavariable names', () => {
    const { names } = compilePattern('$A.method($B)')
    expect(names).toEqual(['A', 'B'])
  })

  test('a literal pattern matches literally', () => {
    expect(matchInText('// @ts-ignore\nconst x = 1', '@ts-ignore')).toHaveLength(1)
  })

  test('searches a directory tree', async () => {
    const cwd = workspace({
      'a.ts': 'console.log("one")\n',
      'src/b.ts': 'console.log("two")\n',
      'notes.md': 'console.log("not code")\n',
    })

    const matches = await searchStructural(cwd, 'console.log($$$)')
    // Markdown is not a language the scanner covers, so it is skipped.
    expect(matches.map((m) => m.path).sort()).toEqual(['a.ts', 'src/b.ts'])
  })

  test('respects a language filter', async () => {
    const cwd = workspace({ 'a.ts': 'foo(1)\n', 'b.py': 'foo(1)\n' })
    const matches = await searchStructural(cwd, 'foo($X)', { language: 'python' })
    expect(matches.map((m) => m.path)).toEqual(['b.py'])
  })

  test('honours the limit', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 20; i++) files[`f${i}.ts`] = 'call(1)\n'
    const matches = await searchStructural(workspace(files), 'call($X)', { limit: 5 })
    expect(matches).toHaveLength(5)
  })
})

describe('GitHub remote parsing', () => {
  test('handles both URL forms', () => {
    expect(parseRemote('git@github.com:owner/name.git')).toEqual({ owner: 'owner', name: 'name' })
    expect(parseRemote('https://github.com/owner/name.git')).toEqual({
      owner: 'owner',
      name: 'name',
    })
    // Which form a clone has depends on how it was made; neither is unusual.
    expect(parseRemote('https://github.com/owner/name')).toEqual({ owner: 'owner', name: 'name' })
  })

  test('handles an enterprise host', () => {
    expect(parseRemote('git@github.example.com:team/project.git')).toEqual({
      owner: 'team',
      name: 'project',
    })
  })

  test('returns undefined for something that is not a git remote', () => {
    expect(parseRemote('not a url')).toBeUndefined()
  })
})
