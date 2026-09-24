import { join } from 'node:path'
import type { JeanConfig } from '@jean/config'
import { jeanHome } from '@jean/config'
import { CodeMap } from '@jean/codemap'
import { IdentityStore, identityStorePath } from '@jean/gateway'
import { renderResults, SearchChain } from '@jean/search'
import { renderReport, scanDirectory } from '@jean/security'
import { Daemon, describeSchedule, type ScheduleKind } from '@jean/scheduler'
import { color, errorLine, line, symbols } from '../ui.ts'

/**
 * Commands for the subsystems that are not part of a normal session
 * (architecture §15, §19, §21).
 *
 * Grouped here rather than in `index.ts` because each is self-contained: none
 * needs a model client, a session, or the orchestrator.
 */

// ---- search ---------------------------------------------------------------

export async function runSearchCommand(args: string[]): Promise<number> {
  const query = args.join(' ').trim()
  if (!query) {
    errorLine('Usage: jean search <query>')
    return 2
  }

  const chain = new SearchChain()
  line()

  try {
    const response = await chain.search(query, {
      onAttempt: (provider, outcome, detail) => {
        if (outcome === 'skipped') return // not interesting unless it failed
        const mark = outcome === 'succeeded' ? color.green(symbols.check) : color.dim(symbols.cross)
        errorLine(`  ${mark} ${provider}${detail ? color.dim(` — ${detail}`) : ''}`)
      },
    })

    line()
    line(renderResults(response))
    return 0
  } catch (err) {
    errorLine(color.red(`${symbols.cross} ${err instanceof Error ? err.message : String(err)}`))

    const ready = chain.available().filter((p) => p.ready)
    if (ready.length === 0) {
      errorLine('')
      errorLine('No provider is configured. Set TAVILY_API_KEY, BRAVE_API_KEY, or SERPER_API_KEY.')
    }
    return 1
  }
}

// ---- index ----------------------------------------------------------------

export async function runIndexCommand(cwd: string): Promise<number> {
  const map = new CodeMap(cwd)
  line()
  line(color.dim('  Scanning...'))

  const started = Date.now()
  const stats = await map.build({
    onProgress: (scanned) => errorLine(color.dim(`  ${scanned} files...`)),
  })

  const overview = map.overview()
  line()
  line(
    `  ${stats.files} files, ${overview.totalLines.toLocaleString()} lines, ${stats.symbols.toLocaleString()} symbols in ${Date.now() - started}ms`,
  )
  line()

  line(color.bold('  Languages'))
  for (const language of overview.languages.slice(0, 10)) {
    line(
      `    ${language.language.padEnd(12)} ${String(language.files).padStart(5)} files  ${language.lines.toLocaleString()} lines`,
    )
  }

  line()
  line(color.bold('  Where the code is'))
  for (const directory of overview.directories.slice(0, 12)) {
    line(`    ${directory.path.padEnd(36)} ${directory.files} files`)
  }
  line()
  return 0
}

// ---- schedule -------------------------------------------------------------

function scheduleStorePath(): string {
  return join(jeanHome(), 'schedules.json')
}

export function runScheduleCommand(args: string[], cwd: string): number {
  const daemon = new Daemon({
    storePath: scheduleStorePath(),
    // Listing and editing never fire anything, so the runner is unreachable
    // from this command and rejects rather than silently doing nothing.
    run: async () => {
      throw new Error('the scheduler daemon is not running in this process')
    },
  })

  const [action, ...rest] = args

  switch (action ?? 'list') {
    case 'list': {
      const schedules = daemon.schedules.all()
      line()
      if (schedules.length === 0) {
        line(color.dim('  No schedules. Add one with `jean schedule add <cron> <prompt>`.'))
        line()
        return 0
      }

      for (const schedule of schedules) {
        const state = schedule.enabled ? color.green('on ') : color.dim('off')
        const detail = describeSchedule(schedule)
        line(`  ${state} ${schedule.id}  ${color.cyan(schedule.when.padEnd(16))} ${detail.detail}`)
        line(color.dim(`        ${schedule.prompt.slice(0, 80)}`))
      }
      line()
      return 0
    }

    case 'add': {
      const [when, ...promptParts] = rest
      const prompt = promptParts.join(' ')
      if (!when || !prompt) {
        errorLine('Usage: jean schedule add "<cron expression>" <prompt>')
        return 2
      }

      // A bare ISO timestamp means a one-off; anything else is cron.
      const kind: ScheduleKind = /^\d{4}-\d{2}-\d{2}/.test(when) ? 'once' : 'cron'

      try {
        const created = daemon.schedules.add({ kind, when, prompt, cwd, enabled: true })
        line(
          `${color.green(symbols.check)} ${created.id} — ${describeSchedule(created).detail}`,
        )
        line(color.dim('  Nothing fires until `jean schedule run` is running.'))
        return 0
      } catch (err) {
        errorLine(color.red(`${symbols.cross} ${err instanceof Error ? err.message : String(err)}`))
        return 1
      }
    }

    case 'remove':
      if (!rest[0]) {
        errorLine('Usage: jean schedule remove <id>')
        return 2
      }
      if (!daemon.schedules.remove(rest[0])) {
        errorLine(color.red(`No schedule ${rest[0]}.`))
        return 1
      }
      line(`${color.green(symbols.check)} removed ${rest[0]}`)
      return 0

    case 'enable':
    case 'disable': {
      if (!rest[0]) {
        errorLine(`Usage: jean schedule ${action} <id>`)
        return 2
      }
      if (!daemon.schedules.setEnabled(rest[0], action === 'enable')) {
        errorLine(color.red(`No schedule ${rest[0]}.`))
        return 1
      }
      line(`${color.green(symbols.check)} ${rest[0]} ${action}d`)
      return 0
    }

    case 'history': {
      const runs = daemon.schedules.history(rest[0])
      line()
      if (runs.length === 0) {
        line(color.dim('  No runs recorded.'))
        line()
        return 0
      }
      for (const run of runs) {
        const mark = run.ok ? color.green(symbols.check) : color.red(symbols.cross)
        const when = new Date(run.startedAt).toLocaleString()
        line(`  ${mark} ${run.scheduleId}  ${when}`)
        if (run.error) line(color.red(`      ${run.error.slice(0, 100)}`))
      }
      line()
      return 0
    }

    default:
      errorLine(`Unknown action "${action}". Use list, add, remove, enable, disable, or history.`)
      return 2
  }
}

// ---- gateway --------------------------------------------------------------

export function runGatewayCommand(args: string[], cwd: string, _config: JeanConfig): number {
  const identities = new IdentityStore(identityStorePath(jeanHome()))
  const [action] = args

  switch (action ?? 'status') {
    case 'link': {
      // A fresh identity per link keeps one code from granting access to a
      // directory the user was not thinking about.
      const identity = identities.create(cwd)
      const code = identities.issueLinkCode(identity.id)

      line()
      line(`  Link code: ${color.bold(color.cyan(code))}`)
      line()
      line(`  Send this to your Jean Code bot within ten minutes. It works once.`)
      line(color.dim(`  It will attach that account to ${cwd}`))
      line()
      return 0
    }

    case 'status': {
      const all = identities.all()
      line()
      if (all.length === 0) {
        line(color.dim('  No linked identities. Run `jean gateway link` to create one.'))
        line()
        return 0
      }

      for (const identity of all) {
        line(`  ${identity.id}  ${color.dim(identity.cwd ?? '(no directory)')}`)
        for (const account of identity.accounts) {
          line(`      ${account.platform}${account.label ? ` (${account.label})` : ''}`)
        }
        if (identity.accounts.length === 0) line(color.dim('      no accounts linked yet'))
      }
      line()
      return 0
    }

    case 'unlink': {
      const [, platform, accountId] = args
      if (!platform || !accountId) {
        errorLine('Usage: jean gateway unlink <platform> <account-id>')
        return 2
      }
      if (!identities.unlink(platform, accountId)) {
        errorLine(color.red('That account is not linked.'))
        return 1
      }
      line(`${color.green(symbols.check)} unlinked ${platform}:${accountId}`)
      return 0
    }

    case 'start':
      errorLine(
        'Starting the gateway needs a bot token. Set it in config under `gateway.telegram.token`, then run `jean gateway start` again.',
      )
      return 1

    default:
      errorLine(`Unknown action "${action}". Use link, status, unlink, or start.`)
      return 2
  }
}

// ---- scan -----------------------------------------------------------------

export async function runScanCommand(args: string[], cwd: string): Promise<number> {
  const target = args[0] ? join(cwd, args[0]) : cwd

  line()
  line(color.dim('  Scanning...'))

  const report = await scanDirectory(target)
  line()
  line(renderReport(report))
  line()

  const certain = report.secrets.filter((finding) => finding.confidence === 'certain').length
  const high = report.code.filter((finding) => finding.severity === 'high').length

  // A non-zero exit makes this usable as a pre-commit hook.
  if (certain > 0) {
    errorLine(color.red(`  ${symbols.cross} ${certain} confirmed secrets. Rotate them; deleting the line does not remove them from git history.`))
    return 1
  }
  if (high > 0) {
    errorLine(color.yellow(`  ${symbols.warn} ${high} high-severity findings.`))
    return 1
  }
  return 0
}
