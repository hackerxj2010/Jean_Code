import { describe, expect, test } from 'bun:test'
import {
  allTags,
  BUILTIN_CASES,
  casesWithTag,
  compareRuns,
  describeCheck,
  renderSuite,
  runSuite,
  type EvalCase,
  type SuiteResult,
} from '../packages/evals/src/index.ts'

/**
 * The harness is tested with a scripted agent rather than a real one: these
 * assert that the *runner* is correct, and a real model would make them slow,
 * expensive, and non-deterministic — which is the opposite of what a test of
 * the harness should be.
 */

/** An agent that performs a fixed set of file writes. */
function scriptedAgent(
  actions: Record<string, string> = {},
  overrides: { reply?: string; toolCalls?: number; throws?: string } = {},
) {
  return async (_prompt: string, cwd: string) => {
    if (overrides.throws) throw new Error(overrides.throws)

    const { mkdir, writeFile } = await import('node:fs/promises')
    const { dirname, join } = await import('node:path')

    for (const [path, content] of Object.entries(actions)) {
      const full = join(cwd, path)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, content, 'utf8')
    }

    return {
      reply: overrides.reply ?? 'done',
      turns: 1,
      toolCalls: overrides.toolCalls ?? Object.keys(actions).length,
      costUsd: 0,
    }
  }
}

describe('checks', () => {
  test('file-exists passes when the agent created the file', async () => {
    const cases: EvalCase[] = [
      { id: 'creates', prompt: 'x', checks: [{ kind: 'file-exists', path: 'out.ts' }] },
    ]
    const result = await runSuite(cases, { agent: scriptedAgent({ 'out.ts': 'export const a = 1' }) })
    expect(result.passed).toBe(1)
  })

  test('file-exists fails when it did not', async () => {
    const cases: EvalCase[] = [
      { id: 'misses', prompt: 'x', checks: [{ kind: 'file-exists', path: 'out.ts' }] },
    ]
    const result = await runSuite(cases, { agent: scriptedAgent({}) })
    expect(result.failed).toBe(1)
    expect(result.cases[0]!.checks[0]!.detail).toContain('not created')
  })

  test('file-matches and file-not-matches', async () => {
    const cases: EvalCase[] = [
      {
        id: 'content',
        prompt: 'x',
        checks: [
          { kind: 'file-matches', path: 'a.ts', pattern: 'newName' },
          { kind: 'file-not-matches', path: 'a.ts', pattern: 'oldName' },
        ],
      },
    ]
    const result = await runSuite(cases, {
      agent: scriptedAgent({ 'a.ts': 'export function newName() {}' }),
    })
    expect(result.passed).toBe(1)
  })

  test('a check against a missing file fails rather than throwing', async () => {
    const cases: EvalCase[] = [
      { id: 'absent', prompt: 'x', checks: [{ kind: 'file-matches', path: 'gone.ts', pattern: 'x' }] },
    ]
    const result = await runSuite(cases, { agent: scriptedAgent({}) })
    expect(result.cases[0]!.checks[0]!.detail).toContain('does not exist')
  })

  test('command-succeeds runs in the case workspace', async () => {
    const cases: EvalCase[] = [
      {
        id: 'command',
        prompt: 'x',
        checks: [
          { kind: 'command-succeeds', command: 'node -e "process.exit(0)"' },
          { kind: 'command-fails', command: 'node -e "process.exit(1)"' },
        ],
      },
    ]
    const result = await runSuite(cases, { agent: scriptedAgent({}) })
    expect(result.passed).toBe(1)
  })

  test('at-most-tools catches an agent that flails', async () => {
    const cases: EvalCase[] = [
      { id: 'efficient', prompt: 'x', checks: [{ kind: 'at-most-tools', count: 3 }] },
    ]

    const tidy = await runSuite(cases, { agent: scriptedAgent({}, { toolCalls: 2 }) })
    expect(tidy.passed).toBe(1)

    const flailing = await runSuite(cases, { agent: scriptedAgent({}, { toolCalls: 20 }) })
    expect(flailing.failed).toBe(1)
    expect(flailing.cases[0]!.checks[0]!.detail).toContain('20 tool calls')
  })

  test('reply-matches checks what the agent said', async () => {
    const cases: EvalCase[] = [
      {
        id: 'answers',
        prompt: 'x',
        checks: [{ kind: 'reply-matches', pattern: 'does not exist', flags: 'i' }],
      },
    ]
    const result = await runSuite(cases, {
      agent: scriptedAgent({}, { reply: 'That file does not exist.' }),
    })
    expect(result.passed).toBe(1)
  })
})

describe('the runner', () => {
  test('lays down setup files before the agent runs', async () => {
    const cases: EvalCase[] = [
      {
        id: 'setup',
        prompt: 'x',
        setup: { 'existing.ts': 'export const seeded = true' },
        checks: [{ kind: 'file-matches', path: 'existing.ts', pattern: 'seeded' }],
      },
    ]
    expect((await runSuite(cases, { agent: scriptedAgent({}) })).passed).toBe(1)
  })

  test('isolates cases from each other', async () => {
    const cases: EvalCase[] = [
      { id: 'first', prompt: 'x', checks: [{ kind: 'file-exists', path: 'shared.ts' }] },
      { id: 'second', prompt: 'x', checks: [{ kind: 'file-absent', path: 'other.ts' }] },
    ]

    // Cases sharing a workspace pass or fail by ordering, which makes a
    // regression indistinguishable from a scheduling change.
    const result = await runSuite(cases, { agent: scriptedAgent({ 'shared.ts': 'x' }) })
    expect(result.passed).toBe(2)
  })

  test('records a crashed run as a failure, not as missing data', async () => {
    const cases: EvalCase[] = [
      { id: 'crashes', prompt: 'x', checks: [{ kind: 'file-exists', path: 'a.ts' }] },
    ]
    const result = await runSuite(cases, {
      agent: scriptedAgent({}, { throws: 'the model refused' }),
    })

    expect(result.failed).toBe(1)
    expect(result.cases[0]!.error).toContain('the model refused')
  })

  test('separates a run that could not happen from a wrong answer', async () => {
    const cases: EvalCase[] = [
      { id: 'unreachable', prompt: 'x', checks: [{ kind: 'file-exists', path: 'a.ts' }] },
    ]
    const result = await runSuite(cases, {
      agent: scriptedAgent({}, { throws: 'openrouter returned 402: Insufficient credits' }),
    })

    // A broken key would otherwise look like the model failing every case,
    // which points at exactly the wrong problem.
    const rendered = renderSuite(result)
    expect(rendered).toContain('could not run')
    expect(rendered).toContain('measure the setup')
    expect(result.cases[0]!.error).toContain('402')
  })

  test('does not claim setup trouble when checks simply failed', async () => {
    const cases: EvalCase[] = [
      { id: 'wrong', prompt: 'x', checks: [{ kind: 'file-exists', path: 'never.ts' }] },
    ]
    const rendered = renderSuite(await runSuite(cases, { agent: scriptedAgent({}) }))
    expect(rendered).not.toContain('could not run')
  })

  test('times a case out rather than hanging the suite', async () => {
    const cases: EvalCase[] = [
      { id: 'slow', prompt: 'x', timeoutMs: 200, checks: [{ kind: 'file-exists', path: 'a.ts' }] },
    ]
    const result = await runSuite(cases, {
      agent: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000))
        return { reply: '', turns: 1, toolCalls: 0, costUsd: 0 }
      },
    })

    expect(result.cases[0]!.error).toContain('time budget')
  })

  test('filters by tag', async () => {
    const cases: EvalCase[] = [
      { id: 'a', prompt: 'x', tags: ['fast'], checks: [{ kind: 'at-most-tools', count: 99 }] },
      { id: 'b', prompt: 'x', tags: ['slow'], checks: [{ kind: 'at-most-tools', count: 99 }] },
    ]
    const result = await runSuite(cases, { agent: scriptedAgent({}), tag: 'fast' })
    expect(result.cases.map((c) => c.id)).toEqual(['a'])
  })

  test('reports results in declaration order despite running concurrently', async () => {
    const cases: EvalCase[] = ['a', 'b', 'c', 'd'].map((id) => ({
      id,
      prompt: 'x',
      checks: [{ kind: 'at-most-tools' as const, count: 99 }],
    }))

    // A report whose order changes between runs is far harder to diff against
    // the previous one.
    const result = await runSuite(cases, { agent: scriptedAgent({}), concurrency: 4 })
    expect(result.cases.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('comparing runs', () => {
  function suite(outcomes: Record<string, boolean>): SuiteResult {
    const cases = Object.entries(outcomes).map(([id, passed]) => ({
      id,
      passed,
      checks: [],
      turns: 1,
      toolCalls: 1,
      durationMs: 1,
      costUsd: 0,
      reply: '',
    }))
    return {
      cases,
      passed: cases.filter((c) => c.passed).length,
      failed: cases.filter((c) => !c.passed).length,
      durationMs: 1,
      totalCostUsd: 0,
      startedAt: 0,
    }
  }

  test('names what changed rather than only the totals', () => {
    const before = suite({ a: true, b: true, c: false })
    const after = suite({ a: true, b: false, c: true })

    // Both runs score 2/3. A single number hides that one case broke and
    // another was fixed.
    expect(before.passed).toBe(after.passed)

    const diff = compareRuns(before, after)
    expect(diff.broken).toEqual(['b'])
    expect(diff.fixed).toEqual(['c'])
    expect(diff.unchanged).toBe(1)
  })

  test('ignores cases that were not in the earlier run', () => {
    const diff = compareRuns(suite({ a: true }), suite({ a: true, b: false }))
    expect(diff.broken).toEqual([])
    expect(diff.unchanged).toBe(1)
  })
})

describe('the report', () => {
  test('shows failing checks and hides passing ones', async () => {
    const cases: EvalCase[] = [
      {
        id: 'mixed',
        prompt: 'x',
        checks: [
          { kind: 'file-exists', path: 'made.ts' },
          { kind: 'file-exists', path: 'missing.ts' },
        ],
      },
    ]
    const result = await runSuite(cases, { agent: scriptedAgent({ 'made.ts': 'x' }) })
    const rendered = renderSuite(result)

    // The point of the report is what to fix.
    expect(rendered).toContain('missing.ts')
    expect(rendered).not.toContain('made.ts')
    expect(renderSuite(result, true)).toContain('made.ts')
  })
})

describe('the bundled suite', () => {
  test('every case is well formed', () => {
    for (const testCase of BUILTIN_CASES) {
      expect(testCase.id).toMatch(/^[a-z0-9-]+$/)
      expect(testCase.prompt.length).toBeGreaterThan(10)
      // A case with no checks passes vacuously and measures nothing.
      expect(testCase.checks.length).toBeGreaterThan(0)
    }
  })

  test('case ids are unique', () => {
    const ids = BUILTIN_CASES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('every check describes itself', () => {
    for (const testCase of BUILTIN_CASES) {
      for (const check of testCase.checks) {
        expect(describeCheck(check).length).toBeGreaterThan(0)
      }
    }
  })

  test('no pattern contains an accidental capture group', () => {
    for (const testCase of BUILTIN_CASES) {
      for (const check of testCase.checks) {
        if (!('pattern' in check)) continue

        expect(() => new RegExp(check.pattern)).not.toThrow()

        // No bundled check needs a capture group, so an unescaped `(` means a
        // backslash was lost somewhere: a pattern meant to read `toBe\(6\)`
        // becomes the string `toBe(6)`, which as a regex matches `toBe6`. The
        // check still runs, still compiles, and is simply always wrong.
        const BACKSLASH = String.fromCharCode(92)
        const unescapedGroup = new RegExp(`(^|[^${BACKSLASH}${BACKSLASH}])${BACKSLASH}((?!${BACKSLASH}?)`)
        expect(unescapedGroup.test(check.pattern)).toBe(false)
      }
    }
  })

  test('tags are usable for filtering', () => {
    expect(allTags()).toContain('core')
    expect(casesWithTag('core').length).toBeGreaterThan(0)
  })

  test('covers restraint, not only capability', () => {
    // An agent that edits when asked a question, or invents a file it was told
    // to fix, is worse than one that does less.
    expect(casesWithTag('restraint').length).toBeGreaterThan(0)
  })
})
