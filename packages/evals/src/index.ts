/**
 * `@jean/evals` — the evaluation harness (architecture §6.25).
 *
 * Every change to a prompt, a tool description, or a model is a guess until it
 * is measured, and an agent varies too much to judge from a few manual runs. A
 * prompt tweak that feels better and makes the agent worse is the normal
 * outcome, not the unusual one.
 *
 * Cases assert on the world after the run — files, exit codes, tests passing —
 * rather than on what the agent said, because two correct solutions to the same
 * task share no text.
 */

export {
  describeCheck,
  type CaseResult,
  type Check,
  type CheckResult,
  type EvalCase,
  type SuiteResult,
} from './types.ts'

export {
  compareRuns,
  renderSuite,
  runCase,
  runSuite,
  type RunOptions,
} from './runner.ts'

export { allTags, BUILTIN_CASES, casesWithTag } from './suite.ts'
