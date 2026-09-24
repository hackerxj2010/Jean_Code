import { exec } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  describeCheck,
  type CaseResult,
  type Check,
  type CheckResult,
  type EvalCase,
  type SuiteResult,
} from './types.ts'

/**
 * The eval runner.
 *
 * Each case runs in a fresh temporary directory. That isolation is the whole
 * design: cases that share a workspace pass or fail depending on the order they
 * ran in, which makes a regression indistinguishable from a scheduling change —
 * and the point of an eval suite is telling those apart.
 */

const run = promisify(exec)

export interface RunOptions {
  /** Runs one case's prompt and reports what happened. */
  agent: (
    prompt: string,
    cwd: string,
    options: { maxTurns?: number; signal?: AbortSignal },
  ) => Promise<{ reply: string; turns: number; toolCalls: number; costUsd: number }>
  /** Cases sharing this tag only. */
  tag?: string
  /** How many cases run at once. */
  concurrency?: number
  onCaseStart?: (id: string) => void
  onCaseEnd?: (result: CaseResult) => void
  /**
   * Keep the workspace of a failed case.
   *
   * Without this a failure reports only which check failed, and the state that
   * produced it is deleted — leaving nothing to look at but a guess about what
   * the agent did.
   */
  keepFailures?: boolean
  model?: string
  signal?: AbortSignal
}

/** Runs a suite. */
export async function runSuite(cases: EvalCase[], options: RunOptions): Promise<SuiteResult> {
  const selected = options.tag ? cases.filter((c) => c.tags?.includes(options.tag!)) : cases
  const startedAt = Date.now()
  const results: CaseResult[] = []

  // Cases are independent, so they parallelize — but not without bound: each
  // one is a model conversation, and twenty at once will hit a rate limit and
  // report failures that are about the provider rather than the agent.
  const concurrency = Math.max(1, options.concurrency ?? 3)
  const queue = [...selected]

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const testCase = queue.shift()
      if (!testCase) return
      if (options.signal?.aborted) return

      options.onCaseStart?.(testCase.id)
      const result = await runCase(testCase, options)
      results.push(result)
      options.onCaseEnd?.(result)
    }
  })

  await Promise.all(workers)

  // Restored to declaration order: a report that changes order between runs is
  // far harder to diff against the previous one.
  results.sort((a, b) => selected.findIndex((c) => c.id === a.id) - selected.findIndex((c) => c.id === b.id))

  return {
    cases: results,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    durationMs: Date.now() - startedAt,
    totalCostUsd: results.reduce((sum, r) => sum + r.costUsd, 0),
    model: options.model,
    startedAt,
  }
}

/** Runs one case in an isolated workspace. */
export async function runCase(testCase: EvalCase, options: RunOptions): Promise<CaseResult> {
  const started = Date.now()
  const workspace = await mkdtemp(join(tmpdir(), `jean-eval-${testCase.id}-`))

  const result: CaseResult = {
    id: testCase.id,
    passed: false,
    checks: [],
    turns: 0,
    toolCalls: 0,
    durationMs: 0,
    costUsd: 0,
    reply: '',
  }

  try {
    for (const [path, content] of Object.entries(testCase.setup ?? {})) {
      const full = join(workspace, path)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, content, 'utf8')
    }

    for (const command of testCase.before ?? []) {
      await run(command, { cwd: workspace, timeout: 60_000 }).catch(() => undefined)
    }

    const outcome = await withTimeout(
      options.agent(testCase.prompt, workspace, {
        maxTurns: testCase.maxTurns,
        signal: options.signal,
      }),
      testCase.timeoutMs ?? 300_000,
      `${testCase.id} exceeded its time budget`,
    )

    result.reply = outcome.reply
    result.turns = outcome.turns
    result.toolCalls = outcome.toolCalls
    result.costUsd = outcome.costUsd

    for (const check of testCase.checks) {
      result.checks.push(await evaluate(check, workspace, outcome))
    }
    result.passed = result.checks.every((check) => check.passed)
  } catch (err) {
    // A run that fails is a failure, not an absence of data: reporting it as
    // "no result" would let a crash look like a suite that did not cover the
    // case.
    result.error = err instanceof Error ? err.message : String(err)
    result.passed = false
  } finally {
    result.durationMs = Date.now() - started

    if (result.passed || !options.keepFailures) {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
    } else {
      result.workspace = workspace
    }
  }

  return result
}

async function evaluate(
  check: Check,
  workspace: string,
  outcome: { reply: string; toolCalls: number },
): Promise<CheckResult> {
  const described = describeCheck(check)

  try {
    switch (check.kind) {
      case 'file-exists': {
        const present = existsSync(join(workspace, check.path))
        return { check, passed: present, detail: present ? undefined : 'the file was not created' }
      }

      case 'file-absent': {
        const present = existsSync(join(workspace, check.path))
        return { check, passed: !present, detail: present ? 'the file exists' : undefined }
      }

      case 'file-matches':
      case 'file-not-matches': {
        const text = await readFile(join(workspace, check.path), 'utf8').catch(() => undefined)
        if (text === undefined) {
          return { check, passed: false, detail: `${check.path} does not exist` }
        }
        const matched = new RegExp(check.pattern, check.flags).test(text)
        const wanted = check.kind === 'file-matches'
        return {
          check,
          passed: matched === wanted,
          detail: matched === wanted ? undefined : `the file ${matched ? 'matched' : 'did not match'}`,
        }
      }

      case 'command-succeeds':
      case 'command-fails': {
        const wantSuccess = check.kind === 'command-succeeds'
        let succeeded = true
        let output = ''
        try {
          const { stdout, stderr } = await run(check.command, {
            cwd: workspace,
            timeout: check.timeoutMs ?? 120_000,
          })
          output = `${stdout}${stderr}`
        } catch (err) {
          succeeded = false
          const failure = err as { stdout?: string; stderr?: string }
          output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
        }
        return {
          check,
          passed: succeeded === wantSuccess,
          detail: succeeded === wantSuccess ? undefined : output.trim().split('\n').slice(-6).join('\n'),
        }
      }

      case 'command-outputs': {
        let output = ''
        try {
          const { stdout, stderr } = await run(check.command, {
            cwd: workspace,
            timeout: check.timeoutMs ?? 120_000,
          })
          output = `${stdout}${stderr}`
        } catch (err) {
          const failure = err as { stdout?: string; stderr?: string }
          output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
        }
        const matched = new RegExp(check.pattern).test(output)
        return {
          check,
          passed: matched,
          detail: matched ? undefined : output.trim().split('\n').slice(-6).join('\n'),
        }
      }

      case 'reply-matches': {
        const matched = new RegExp(check.pattern, check.flags).test(outcome.reply)
        return { check, passed: matched, detail: matched ? undefined : outcome.reply.slice(0, 300) }
      }

      case 'at-most-tools':
        return {
          check,
          passed: outcome.toolCalls <= check.count,
          detail:
            outcome.toolCalls <= check.count ? undefined : `used ${outcome.toolCalls} tool calls`,
        }
    }
  } catch (err) {
    return { check, passed: false, detail: `${described} could not be evaluated: ${String(err)}` }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms)
      timer.unref?.()
    }),
  ])
}

/** Renders a suite result. */
export function renderSuite(result: SuiteResult, verbose = false): string {
  const errored = result.cases.filter((testCase) => testCase.error).length

  const sections: string[] = [
    `${result.passed}/${result.cases.length} passed in ${(result.durationMs / 1000).toFixed(1)}s${result.model ? ` on ${result.model}` : ''}`,
  ]

  // Called out separately: cases that never reached the model say nothing about
  // the agent, and reading them as failures points at the wrong problem.
  if (errored > 0) {
    sections.push(
      `${errored} case${errored === 1 ? '' : 's'} could not run — these measure the setup, not the agent.`,
    )
  }
  if (result.totalCostUsd > 0) sections.push(`cost $${result.totalCostUsd.toFixed(3)}`)
  sections.push('')

  for (const testCase of result.cases) {
    const mark = testCase.passed ? 'pass' : 'FAIL'
    sections.push(
      `  ${mark}  ${testCase.id.padEnd(28)} ${testCase.turns} turns, ${testCase.toolCalls} tools, ${(testCase.durationMs / 1000).toFixed(1)}s`,
    )

    if (testCase.error) sections.push(`        error: ${testCase.error}`)
    if (testCase.workspace) sections.push(`        workspace kept: ${testCase.workspace}`)

    // Only failures by default: a passing suite's detail is noise, and the
    // point of the report is what to fix.
    for (const check of testCase.checks) {
      if (check.passed && !verbose) continue
      const status = check.passed ? '  ok' : 'FAIL'
      sections.push(`        ${status}  ${describeCheck(check.check)}`)
      if (check.detail) {
        for (const line of check.detail.split('\n').slice(0, 4)) {
          sections.push(`              ${line}`)
        }
      }
    }
  }

  return sections.join('\n')
}

/**
 * Compares two runs.
 *
 * The comparison that matters is not the pass rate but *which* cases changed:
 * a suite going from 8/10 to 8/10 with two different failures is a regression
 * and an improvement at once, and a single number hides both.
 */
export function compareRuns(
  before: SuiteResult,
  after: SuiteResult,
): { fixed: string[]; broken: string[]; unchanged: number } {
  const previous = new Map(before.cases.map((c) => [c.id, c.passed]))
  const fixed: string[] = []
  const broken: string[] = []
  let unchanged = 0

  for (const testCase of after.cases) {
    const was = previous.get(testCase.id)
    if (was === undefined) continue
    if (was === testCase.passed) unchanged++
    else if (testCase.passed) fixed.push(testCase.id)
    else broken.push(testCase.id)
  }

  return { fixed, broken, unchanged }
}
