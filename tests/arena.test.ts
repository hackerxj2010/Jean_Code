import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runArena } from '../packages/agent/src/index.ts'
import { defaultConfig } from '../packages/config/src/index.ts'
import type { StreamEvent } from '../packages/model/src/types.ts'
import { findBinary } from '../packages/native/src/index.ts'
import { Registry, builtinTools } from '../packages/tools/src/index.ts'

/**
 * The arena, driven by scripted attempts: one that breaks the check, one that
 * passes it with a large change, one that passes with a small one. The small
 * passing change must win and be the only thing merged.
 */

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows may still hold a handle.
    }
  }
})

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'jean-arena-'))
  temps.push(root)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(root, 'value.txt'), 'wrong\n')
  writeFileSync(join(root, 'notes.txt'), 'untouched\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return root
}

type Step = { text?: string; calls?: { name: string; input: unknown }[] }

function scripted(steps: Step[]) {
  let i = 0
  return {
    resolve: () => ({
      role: 'default',
      provider: 'x',
      modelId: 'scripted',
      maxTokens: 4096,
      fallbacks: [],
    }),
    isConfigured: () => true,
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      const step = steps[i++] ?? { text: 'done' }
      const content = [
        ...(step.text ? [{ type: 'text' as const, text: step.text }] : []),
        ...(step.calls ?? []).map((c, k) => ({
          type: 'tool_call' as const,
          id: `c${i}-${k}`,
          ...c,
        })),
      ]
      yield {
        type: 'done',
        response: {
          content,
          stopReason: step.calls?.length ? 'tool_use' : 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'scripted',
          provider: 'x',
          latencyMs: 1,
        },
      }
    },
  } as never
}

const read = (path: string) => ({ name: 'read', input: { path } })
const write = (path: string, content: string) => ({ name: 'write', input: { path, content } })

describe('the arena', () => {
  test('keeps the smallest change that passes the check, and only that one', async () => {
    const cwd = repo()
    const registry = new Registry()
    registry.registerAll(builtinTools())
    const check = `bun -e "process.exit(require('fs').readFileSync('value.txt','utf8').trim()==='right'?0:1)"`

    const attempts = [
      // 1: gives up with the check still failing.
      [{ text: 'I could not do it.' }, { text: 'Still cannot.' }],
      // 2: passes, but rewrites an unrelated file too — a bigger change.
      [
        { calls: [read('value.txt'), read('notes.txt')] },
        {
          calls: [
            write('value.txt', 'right\n'),
            write('notes.txt', 'rewritten\nfor\nno\nreason\n'),
          ],
        },
        { text: 'done' },
      ],
      // 3: passes with the minimal change.
      [
        { calls: [read('value.txt')] },
        { calls: [write('value.txt', 'right\n')] },
        { text: 'done' },
      ],
    ]

    const result = await runArena({
      task: 'make value.txt say right',
      attempts: 3,
      verify: check,
      client: scripted([]),
      config: { ...defaultConfig(), permissionMode: 'full' },
      cwd,
      registry,
      clientFor: (index) => scripted(attempts[index]!),
    })

    expect(result.entries.map((e) => e.passed)).toEqual([false, true, true])
    expect(result.winner).toBe(2)
    expect(result.merged).toBe(true)
    expect(readFileSync(join(cwd, 'value.txt'), 'utf8')).toBe('right\n')
    // The losing attempt's unrelated rewrite never reached the real tree.
    expect(readFileSync(join(cwd, 'notes.txt'), 'utf8')).toBe('untouched\n')
    // No commits were added to the user's branch.
    expect(
      execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
    ).toBe('1')
  }, 120_000)

  test('changes nothing when no attempt passes', async () => {
    const cwd = repo()
    const registry = new Registry()
    registry.registerAll(builtinTools())
    const result = await runArena({
      task: 'x',
      attempts: 2,
      verify: 'exit 1',
      client: scripted([]),
      config: { ...defaultConfig(), permissionMode: 'full' },
      cwd,
      registry,
      clientFor: () =>
        scripted([{ calls: [read('value.txt')] }, { calls: [write('value.txt', 'nope\n')] }]),
    })
    expect(result.winner).toBeUndefined()
    expect(result.merged).toBe(false)
    expect(readFileSync(join(cwd, 'value.txt'), 'utf8')).toBe('wrong\n')
  }, 120_000)

  test.skipIf(!findBinary())(
    'outside git, attempts run in pi-iso copies and the winner is merged',
    async () => {
      // It used to refuse here. With `pi-iso`, a plain directory isolates its
      // attempts as well as a repository does.
      const cwd = mkdtempSync(join(tmpdir(), 'jean-arena-nogit-'))
      temps.push(cwd)
      writeFileSync(join(cwd, 'value.txt'), 'wrong\n')
      writeFileSync(join(cwd, 'notes.txt'), 'untouched\n')
      const registry = new Registry()
      registry.registerAll(builtinTools())

      const attempts = [
        [
          { calls: [read('value.txt'), read('notes.txt')] },
          { calls: [write('value.txt', 'right\n'), write('notes.txt', 'noise\n')] },
          { text: 'done' },
        ],
        [
          { calls: [read('value.txt')] },
          { calls: [write('value.txt', 'right\n')] },
          { text: 'done' },
        ],
      ]
      const result = await runArena({
        task: 'make value.txt say right',
        attempts: 2,
        client: scripted([]),
        config: { ...defaultConfig(), permissionMode: 'full' },
        cwd,
        registry,
        clientFor: (index) => scripted(attempts[index]!),
      })

      expect(result.winner).toBe(1)
      expect(result.merged).toBe(true)
      expect(readFileSync(join(cwd, 'value.txt'), 'utf8')).toBe('right\n')
      expect(readFileSync(join(cwd, 'notes.txt'), 'utf8')).toBe('untouched\n')
    },
    120_000,
  )
})
