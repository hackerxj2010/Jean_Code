import { readFileSync } from 'node:fs'
import {
  deleteSession,
  exportSession,
  forkSession,
  importSession,
  listSessions,
  loadSession,
  renameSession,
  sessionMarkdown,
  type JeanEvent,
} from '@jean/core'
import { estimateCost } from '@jean/model'
import { color, errorLine, line, symbols } from '../ui.ts'

/**
 * Sessions as things to keep, share, and account for.
 *
 *   jean sessions [--all]              this project's sessions (every project's)
 *   jean sessions delete <id>          remove one
 *   jean sessions rename <id> <title>  name one
 *   jean sessions fork <id>            copy one, to go on in another direction
 *   jean export [id] [--sanitize] [-f text]   one session as JSON, or Markdown
 *   jean import <file|url>             a session exported elsewhere
 *   jean stats [--days N] [--all]      tokens, cost, models, and tools over time
 */

type Flags = Record<string, string | boolean | number>

function when(at: number): string {
  return new Date(at).toLocaleString()
}

/** `jean sessions` */
export function runSessionsCommand(positional: string[], cwd: string, flags: Flags): number {
  const [action, id, ...rest] = positional

  if (action === 'delete' || action === 'rm') {
    if (!id) return usage('jean sessions delete <id>')
    if (!deleteSession(id)) return missing(id)
    line(`${symbols.check} Deleted session ${color.cyan(id)}.`)
    return 0
  }
  if (action === 'rename') {
    const title = rest.join(' ').trim()
    if (!id || !title) return usage('jean sessions rename <id> <title>')
    if (!renameSession(id, title)) return missing(id)
    line(`${symbols.check} ${color.cyan(id)} is now "${title}".`)
    return 0
  }
  if (action === 'fork') {
    if (!id) return usage('jean sessions fork <id>')
    const fork = forkSession(id)
    if (!fork) return missing(id)
    line(`${symbols.check} Forked ${color.cyan(id)} as ${color.cyan(fork)}. Continue it with \`jean resume ${fork}\`.`)
    return 0
  }

  const all = flags.all === true
  const sessions = listSessions(all ? undefined : cwd, all ? 100 : 25)
  if (sessions.length === 0) {
    line(color.dim(all ? '  No sessions yet.' : '  No sessions in this directory yet. `jean sessions --all` lists every project.'))
    return 0
  }
  line()
  for (const session of sessions) {
    line(`  ${color.cyan(session.id)} ${color.dim(`${when(session.updatedAt)} · ${session.events} events${session.model ? ` · ${session.model}` : ''}`)}`)
    line(`    ${session.title}${all && session.cwd ? color.dim(`  (${session.cwd})`) : ''}`)
  }
  line()
  line(color.dim('  Resume: jean resume <id> · continue the last: jean --continue · copy first: --fork'))
  line(color.dim('  Keep or share: jean export <id> [--sanitize] > session.json · jean import session.json'))
  line()
  return 0
}

function usage(text: string): number {
  errorLine(`Usage: ${text}`)
  return 2
}

function missing(id: string): number {
  errorLine(color.red(`${symbols.cross} No session "${id}". \`jean sessions --all\` lists them.`))
  return 1
}

/** `jean export` */
export function runExportCommand(positional: string[], cwd: string, flags: Flags): number {
  const id = positional[0] ?? listSessions(cwd, 1)[0]?.id
  if (!id) {
    errorLine(color.red('No session in this directory to export.'))
    return 1
  }
  const doc = exportSession(id, { sanitize: flags.sanitize === true })
  if (!doc) return missing(id)
  process.stdout.write(flags['output-format'] === 'text' ? sessionMarkdown(doc) : `${JSON.stringify(doc, null, 2)}\n`)
  return 0
}

/** `jean import` */
export async function runImportCommand(positional: string[]): Promise<number> {
  const source = positional[0]
  if (!source) return usage('jean import <file|https://…>')
  try {
    const data: unknown = /^https:\/\//.test(source)
      ? await (await fetch(source, { signal: AbortSignal.timeout(20_000) })).json()
      : JSON.parse(readFileSync(source, 'utf8'))
    const id = importSession(data)
    line(`${symbols.check} Imported as ${color.cyan(id)}. Continue it with \`jean resume ${id}\`.`)
    return 0
  } catch (error) {
    errorLine(color.red(`${symbols.cross} ${error instanceof Error ? error.message : String(error)}`))
    return 1
  }
}

export interface Tally {
  sessions: number
  prompts: number
  turns: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cost: number
}

function empty(): Tally {
  return { sessions: 0, prompts: 0, turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0 }
}

/** Usage over a set of sessions: in total, by model, by tool, and by day. */
export function sessionStats(sessions: JeanEvent[][]): {
  total: Tally
  models: Map<string, Tally>
  tools: Map<string, number>
  days: Map<string, Tally>
} {
  const total = empty()
  const models = new Map<string, Tally>()
  const tools = new Map<string, number>()
  const days = new Map<string, Tally>()

  for (const session of sessions) {
    total.sessions += 1
    const start = session.find((event) => event.type === 'session_start')
    const fallbackModel = start && start.type === 'session_start' ? start.model : ''
    const seenModels = new Set<string>()
    const seenDays = new Set<string>()
    // Tool calls are events of their own; older sessions kept them only
    // inside the assistant's message.
    const separate = session.some((event) => event.type === 'tool_call')

    for (const event of session) {
      const day = new Date(event.at).toISOString().slice(0, 10)
      const today = days.get(day) ?? empty()
      days.set(day, today)
      if (!seenDays.has(day)) {
        seenDays.add(day)
        today.sessions += 1
      }

      if (event.type === 'user_message') {
        total.prompts += 1
        today.prompts += 1
      } else if (event.type === 'tool_call') {
        total.toolCalls += 1
        today.toolCalls += 1
        tools.set(event.name, (tools.get(event.name) ?? 0) + 1)
      } else if (event.type === 'assistant_message') {
        const model = event.model || fallbackModel || 'unknown'
        const bucket = models.get(model) ?? empty()
        models.set(model, bucket)
        if (!seenModels.has(model)) {
          seenModels.add(model)
          bucket.sessions += 1
        }
        const input = event.usage?.inputTokens ?? 0
        const output = event.usage?.outputTokens ?? 0
        const cached = event.usage?.cacheReadTokens ?? event.usage?.cachedTokens ?? 0
        const cost = estimateCost(model, input, output, undefined, cached)
        for (const tally of [total, bucket, today]) {
          tally.turns += 1
          tally.inputTokens += input
          tally.outputTokens += output
          tally.cacheReadTokens += cached
          tally.cost += cost
        }
        if (!separate) {
          for (const block of event.content) {
            if (block.type !== 'tool_call') continue
            total.toolCalls += 1
            today.toolCalls += 1
            tools.set(block.name, (tools.get(block.name) ?? 0) + 1)
          }
        }
      }
    }
  }
  return { total, models, tools, days }
}

function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`
  return String(count)
}

/** `jean stats` */
export function runStatsCommand(cwd: string, flags: Flags): number {
  const days = typeof flags.days === 'number' && flags.days > 0 ? flags.days : undefined
  const since = days ? Date.now() - days * 86_400_000 : 0
  const all = flags.all === true
  const metas = listSessions(all ? undefined : cwd, Number.MAX_SAFE_INTEGER).filter((meta) => meta.updatedAt >= since)
  const sessions = metas
    .map((meta) => loadSession(meta.id)?.toJSON().filter((event) => event.at >= since))
    .filter((events): events is JeanEvent[] => Boolean(events?.length))
  const { total, models, tools, days: byDay } = sessionStats(sessions)

  line()
  line(color.bold(`Usage — ${all ? 'every project' : 'this project'}, ${days ? `last ${days} days` : 'all time'}`))
  line()
  if (total.sessions === 0) {
    line(color.dim(`  No sessions${days ? ` in the last ${days} days` : ''}.${all ? '' : ' `--all` counts every project.'}`))
    line()
    return 0
  }
  line(`  Sessions   ${total.sessions}      Prompts ${total.prompts}      Model turns ${total.turns}      Tool calls ${total.toolCalls}`)
  line(`  Tokens     ${tokens(total.inputTokens)} in · ${tokens(total.outputTokens)} out · ${tokens(total.cacheReadTokens)} read from cache`)
  line(`  Cost       ~$${total.cost.toFixed(2)} ${color.dim('(estimated from catalog prices)')}`)

  line()
  line(color.bold('  By model'))
  for (const [model, tally] of [...models].sort((a, b) => b[1].cost - a[1].cost || b[1].turns - a[1].turns).slice(0, 12)) {
    line(
      `    ${color.cyan(model.slice(0, 40).padEnd(40))} ${String(tally.turns).padStart(6)} turns  ${tokens(tally.inputTokens).padStart(7)} in  ${tokens(tally.outputTokens).padStart(7)} out  ~$${tally.cost.toFixed(2)}`,
    )
  }

  if (tools.size > 0) {
    line()
    line(color.bold('  Tools'))
    const top = [...tools].sort((a, b) => b[1] - a[1]).slice(0, flags.verbose === true ? 40 : 12)
    line(`    ${top.map(([name, count]) => `${name} ${color.dim(String(count))}`).join('  ·  ')}`)
  }

  if (flags.verbose === true) {
    line()
    line(color.bold('  By day'))
    for (const [day, tally] of [...byDay].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 31)) {
      line(
        `    ${day}  ${String(tally.sessions).padStart(3)} sessions  ${String(tally.prompts).padStart(4)} prompts  ${tokens(tally.inputTokens + tally.outputTokens).padStart(7)} tokens  ~$${tally.cost.toFixed(2)}`,
      )
    }
  }
  line()
  return 0
}
