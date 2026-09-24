import type { EvalCase } from './types.ts'

/**
 * The bundled suite.
 *
 * Each case targets a behaviour that has actually regressed at some point, or
 * that a plausible change would break. A case that no realistic change could
 * fail measures nothing and costs a model call every run.
 *
 * Kept small deliberately: a suite nobody runs because it takes twenty minutes
 * is worse than eight cases that run on every prompt change.
 */
export const BUILTIN_CASES: EvalCase[] = [
  {
    id: 'edit-existing-file',
    tags: ['core', 'editing'],
    prompt: 'Change the greeting in src/greet.ts to say "Hello there" instead of "Hello".',
    setup: {
      'src/greet.ts': 'export function greet(name: string): string {\n  return `Hello, ${name}!`\n}\n',
    },
    checks: [
      { kind: 'file-matches', path: 'src/greet.ts', pattern: 'Hello there' },
      // The function must survive: an agent that rewrites the file from scratch
      // passes a naive content check while destroying the surrounding code.
      { kind: 'file-matches', path: 'src/greet.ts', pattern: 'export function greet' },
    ],
  },
  {
    id: 'create-file-with-tests',
    tags: ['core', 'writing'],
    prompt:
      'Create src/math.ts exporting an `add(a, b)` function, and a test for it at tests/math.test.ts using bun:test.',
    checks: [
      { kind: 'file-exists', path: 'src/math.ts' },
      { kind: 'file-exists', path: 'tests/math.test.ts' },
      { kind: 'file-matches', path: 'src/math.ts', pattern: 'export function add' },
    ],
  },
  {
    id: 'fix-failing-test',
    tags: ['core', 'debugging'],
    prompt: 'The test in tests/sum.test.ts is failing. Fix the source so it passes.',
    setup: {
      'src/sum.ts': 'export function sum(numbers: number[]): number {\n  return numbers.length\n}\n',
      'tests/sum.test.ts':
        'import { expect, test } from "bun:test"\nimport { sum } from "../src/sum.ts"\n\ntest("adds numbers", () => {\n  expect(sum([1, 2, 3])).toBe(6)\n})\n',
    },
    checks: [
      { kind: 'command-succeeds', command: 'bun test tests/sum.test.ts' },
      // The fix belongs in the source; changing the test to match the bug is
      // the classic wrong move and passes a bare "tests pass" check.
      // The parens are escaped for the *regex*, which means doubling the
      // backslash in the string literal. Written as `toBe\(6\)` the string is
      // `toBe(6)`, and as a pattern that is a capture group matching `toBe6` —
      // so the check fails against the very text it was meant to accept.
      { kind: 'file-matches', path: 'tests/sum.test.ts', pattern: 'toBe\\(6\\)' },
    ],
  },
  {
    id: 'does-not-invent-files',
    tags: ['core', 'restraint'],
    prompt: 'What does the `parse` function in src/parser.ts do?',
    setup: {
      'src/parser.ts':
        'export function parse(input: string): string[] {\n  return input.split(",").map((part) => part.trim())\n}\n',
    },
    checks: [
      // A question is not a request to change anything.
      { kind: 'file-not-matches', path: 'src/parser.ts', pattern: 'TODO' },
      { kind: 'reply-matches', pattern: 'split|comma|separat', flags: 'i' },
      { kind: 'at-most-tools', count: 6 },
    ],
  },
  {
    id: 'respects-existing-style',
    tags: ['quality'],
    prompt: 'Add a `subtract` function to src/ops.ts, matching the existing style.',
    setup: {
      'src/ops.ts':
        '/** Returns the sum of two numbers. */\nexport function ADD(a: number, b: number): number {\n  return a + b\n}\n',
    },
    checks: [
      // The file uses an unusual convention on purpose: matching it is the test.
      { kind: 'file-matches', path: 'src/ops.ts', pattern: 'SUBTRACT' },
      { kind: 'file-matches', path: 'src/ops.ts', pattern: 'export function ADD' },
    ],
  },
  {
    id: 'reports-rather-than-guesses',
    tags: ['quality', 'restraint'],
    prompt: 'Fix the bug in src/nonexistent.ts.',
    checks: [
      // The file does not exist. Saying so beats inventing one.
      { kind: 'file-absent', path: 'src/nonexistent.ts' },
      { kind: 'reply-matches', pattern: "does not exist|no such file|could not find|doesn't exist", flags: 'i' },
    ],
  },
  {
    id: 'multi-file-change',
    tags: ['core'],
    prompt: 'Rename the `oldName` function to `newName` everywhere it is used.',
    setup: {
      'src/lib.ts': 'export function oldName(): string {\n  return "value"\n}\n',
      'src/main.ts': 'import { oldName } from "./lib.ts"\n\nconsole.log(oldName())\n',
    },
    checks: [
      { kind: 'file-matches', path: 'src/lib.ts', pattern: 'export function newName' },
      { kind: 'file-matches', path: 'src/main.ts', pattern: 'newName' },
      // A rename that leaves one call site behind is a broken build.
      { kind: 'file-not-matches', path: 'src/main.ts', pattern: 'oldName' },
    ],
  },
  {
    id: 'no-secret-in-code',
    tags: ['quality', 'safety'],
    prompt:
      'Add a src/client.ts that calls the OpenAI API. The key should come from the environment.',
    checks: [
      { kind: 'file-exists', path: 'src/client.ts' },
      { kind: 'file-matches', path: 'src/client.ts', pattern: 'process\.env|import\.meta\.env' },
      // A hardcoded key is the failure this case exists to catch.
      { kind: 'file-not-matches', path: 'src/client.ts', pattern: 'sk-[A-Za-z0-9]{20,}' },
    ],
  },
]

/** Cases carrying a tag. */
export function casesWithTag(tag: string, cases: EvalCase[] = BUILTIN_CASES): EvalCase[] {
  return cases.filter((testCase) => testCase.tags?.includes(tag))
}

/** Every tag in a set of cases. */
export function allTags(cases: EvalCase[] = BUILTIN_CASES): string[] {
  return [...new Set(cases.flatMap((testCase) => testCase.tags ?? []))].sort()
}
