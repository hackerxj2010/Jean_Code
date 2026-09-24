import { Orchestrator } from '@jean/agent'
import type { JeanConfig } from '@jean/config'
import { newSessionId } from '@jean/core'
import { allTags, BUILTIN_CASES, renderSuite, runSuite } from '@jean/evals'
import { ModelClient, defaultStreamRules } from '@jean/model'
import { color, errorLine, line, symbols } from '../ui.ts'

/**
 * `jean eval` — runs the evaluation suite against the configured model.
 *
 * Each case gets a fresh orchestrator in its own workspace. Reusing one would
 * carry memory, session state, and a warm code map between cases, which is
 * exactly the contamination the isolation is there to prevent.
 */
export async function runEvalCommand(
  args: string[],
  config: JeanConfig,
  flags: { list?: boolean; verbose?: boolean; keep?: boolean } = {},
): Promise<number> {
  const tag = args.find((arg) => !arg.startsWith('-'))
  const verbose = flags.verbose ?? false

  if (flags.list) {
    line()
    for (const testCase of BUILTIN_CASES) {
      line(`  ${testCase.id.padEnd(28)} ${(testCase.tags ?? []).join(', ')}`)
      line(color.dim(`      ${testCase.prompt.slice(0, 90)}`))
    }
    line()
    line(color.dim(`  tags: ${allTags().join(', ')}`))
    line()
    return 0
  }

  const client = new ModelClient({ config, streamRules: defaultStreamRules() })
  if (!client.isConfigured()) {
    errorLine(color.red('No API key is configured. Run `jean doctor` to see what is missing.'))
    return 1
  }

  const resolved = client.resolve('default')
  line()
  line(`  Running ${tag ? `"${tag}" cases` : 'the suite'} against ${color.cyan(resolved.modelId)}`)
  line()

  const result = await runSuite(BUILTIN_CASES, {
    tag,
    model: resolved.modelId,
    concurrency: 2,
    keepFailures: flags.keep ?? false,
    onCaseStart: (id) => errorLine(color.dim(`  running ${id}...`)),
    onCaseEnd: (caseResult) => {
      const mark = caseResult.passed ? color.green(symbols.check) : color.red(symbols.cross)
      errorLine(`  ${mark} ${caseResult.id}`)
    },

    async agent(prompt, cwd, options) {
      // `permissionMode: 'full'` because a case runs unattended in a throwaway
      // directory: a confirmation prompt with nobody to answer it would fail
      // every case that writes a file, measuring the harness rather than the
      // agent.
      const orchestrator = new Orchestrator({
        config: { ...config, permissionMode: 'full', maxTurns: options.maxTurns ?? 20 },
        client,
        cwd,
        sessionId: newSessionId(),
      })

      try {
        const outcome = await orchestrator.send(prompt)

        // A run that could not reach the model is an infrastructure failure,
        // not a wrong answer. Reported as a passing run with an empty reply it
        // looks like the model failing every case, which is the opposite of
        // the conclusion to draw from a bad API key.
        if (outcome.stopReason === 'error') {
          throw new Error(outcome.error ?? 'the run failed before the model answered')
        }

        return {
          reply: outcome.text,
          turns: outcome.turns,
          toolCalls: outcome.toolCalls,
          costUsd: 0,
        }
      } finally {
        // Ends language servers, kernels, and the browser this case started.
        orchestrator.end('eval finished')
      }
    },
  })

  line()
  line(renderSuite(result, verbose))
  line()

  return result.failed === 0 ? 0 : 1
}
