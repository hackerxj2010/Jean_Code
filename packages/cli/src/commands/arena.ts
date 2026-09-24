import type { JeanConfig } from '@jean/config'
import { Orchestrator, type ArenaResult } from '@jean/agent'
import { newSessionId } from '@jean/core'
import { defaultStreamRules, ModelClient } from '@jean/model'
import { color, errorLine, line, symbols } from '../ui.ts'

/**
 * `jean arena "<task>" --attempts 3 --verify "npm test"`
 *
 * Several independent attempts in parallel, the best one merged. See
 * `@jean/agent`'s arena for how attempts are isolated and ranked.
 */
export async function runArenaCommand(options: {
  task: string
  config: JeanConfig
  cwd: string
  attempts?: number
  verify?: string
  models?: string[]
  json: boolean
}): Promise<number> {
  if (!options.task.trim()) {
    errorLine('Usage: jean arena "<task>" [--attempts 3] [--verify "npm test"] [--models a,b]')
    return 2
  }

  let costUsd = 0
  const client = new ModelClient({
    config: options.config,
    streamRules: defaultStreamRules(),
    onUsage: (event) => {
      costUsd += event.costUsd
    },
  })
  const orchestrator = new Orchestrator({
    config: options.config,
    client,
    cwd: options.cwd,
    sessionId: newSessionId(),
    onEvent: options.json
      ? undefined
      : (event) => {
          if (event.type === 'notice') line(color.dim(`  ${event.text}`))
        },
  })

  const onSignal = () => orchestrator.interrupt()
  process.once('SIGINT', onSignal)

  let result: ArenaResult
  try {
    if (!options.json) {
      line(
        `${color.bold('Arena')} — ${options.attempts ?? 3} attempts${options.verify ? `, judged by ${color.cyan(options.verify)}` : ''}`,
      )
    }
    result = await orchestrator.arena(options.task, {
      attempts: options.attempts,
      verify: options.verify,
      models: options.models,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
    else errorLine(color.red(`${symbols.cross} ${message}`))
    return 1
  } finally {
    ;(process as NodeJS.EventEmitter).off('SIGINT', onSignal)
    orchestrator.end('arena complete')
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: result.merged, costUsd, ...result }, null, 2)}\n`)
    return result.merged ? 0 : 1
  }

  line()
  for (const [i, entry] of result.entries.entries()) {
    const mark = i === result.winner ? color.green('★') : entry.passed === false ? color.red('✗') : color.dim('·')
    const check = entry.passed === undefined ? '' : entry.passed ? color.green(' pass') : color.red(' fail')
    line(
      `  ${mark} #${entry.attempt} ${color.cyan(entry.model.padEnd(32))}${check}  ${String(entry.lines).padStart(5)} lines  ${String(entry.turns).padStart(3)} turns  ${(entry.durationMs / 1000).toFixed(0)}s${entry.error ? color.red(`  ${entry.error.slice(0, 60)}`) : ''}`,
    )
  }
  line()
  line(result.merged ? `${symbols.check} ${result.message}` : color.yellow(`${symbols.warn} ${result.message}`))
  line(color.dim(`  cost ≈ $${costUsd.toFixed(4)}`))
  return result.merged ? 0 : 1
}
