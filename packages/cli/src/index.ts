#!/usr/bin/env bun
import {
  ensureJeanHome,
  getSetting,
  loadConfig,
  redactSecrets,
  setSetting,
  type Mode,
} from '@jean/config'
import { completionScript } from './completions.ts'
import { FLAGS, flagsToConfig, parseArgs, renderHelp } from './flags.ts'
import { color, errorLine, line, symbols } from './ui.ts'

// Everything else is imported where it is used. This file runs on every
// invocation, and the agent's dependency graph — language servers, the
// browser, kernels, memory — costs over a second to load; `jean --version`
// or `jean trust` should not pay for it.

/**
 * `jean` — the CLI entry point.
 *
 * Everything routes through here: flags become a config layer, the config layer
 * is resolved once, and the resulting `JeanConfig` is what every command reads.
 * No command re-reads config files or the environment on its own.
 */

const VERSION = '0.1.0'

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)

  if (args.flags.help === true || args.command === 'help') {
    line(renderHelp())
    return 0
  }
  if (args.flags.version === true || args.command === 'version') {
    line(`jean ${VERSION}`)
    return 0
  }
  for (const unknown of args.unknown) {
    errorLine(color.yellow(`${symbols.warn} unrecognized option ${unknown}`))
  }

  // `completions` runs before config: it must work in a shell startup file,
  // where a broken config should not produce garbage on stdout.
  if (args.command === 'completions') {
    const shell = args.positional[0] ?? 'bash'
    if (!['bash', 'zsh', 'fish'].includes(shell)) {
      errorLine(`Unknown shell "${shell}". Use bash, zsh, or fish.`)
      return 2
    }
    line(completionScript(shell as 'bash' | 'zsh' | 'fish'))
    return 0
  }

  ensureJeanHome()
  const cwd = process.cwd()
  const { config: flagConfig, warnings: flagWarnings } = flagsToConfig(args.flags)

  const loaded = loadConfig({
    cwd,
    configPath: typeof args.flags.config === 'string' ? args.flags.config : undefined,
    flags: flagConfig,
    skipImport: args.flags['no-import'] === true,
  })

  for (const warning of [...flagWarnings, ...loaded.warnings]) {
    errorLine(color.yellow(`${symbols.warn} ${warning}`))
  }

  const config = loaded.config

  switch (args.command) {
    case 'trust': {
      const { trustProject } = await import('@jean/hooks')
      trustProject(cwd)
      line(`${symbols.check} Trusted ${color.cyan(cwd)} — its hooks, allow rules, and \`!\` commands now apply.`)
      return 0
    }

    case 'untrust': {
      const { untrustProject } = await import('@jean/hooks')
      line(
        untrustProject(cwd)
          ? `${symbols.check} ${color.cyan(cwd)} is no longer trusted.`
          : color.dim(`${cwd} was not trusted.`),
      )
      return 0
    }

    case 'arena':
      return (await import('./commands/arena.ts')).runArenaCommand({
        task: [
          ...args.positional,
          ...(typeof args.flags.prompt === 'string' ? [args.flags.prompt] : []),
        ].join(' '),
        config,
        cwd,
        attempts: typeof args.flags.attempts === 'number' ? args.flags.attempts : undefined,
        verify: typeof args.flags.verify === 'string' ? args.flags.verify : undefined,
        models:
          typeof args.flags.models === 'string'
            ? args.flags.models.split(',').map((m) => m.trim()).filter(Boolean)
            : undefined,
        json: args.flags['output-format'] === 'json',
      })

    case 'doctor':
      return (await import('./commands/doctor.ts')).runDoctor(loaded, cwd)

    case 'native':
      return (await import('./commands/native.ts')).runNativeCommand(args.positional)

    case 'lsp':
      return (await import('./commands/languages.ts')).runLspCommand(args.positional, config, cwd)

    case 'debug':
      return (await import('./commands/languages.ts')).runDebugCommand(args.positional, config, cwd)

    case 'config':
      return runConfigCommand(args.positional, loaded, cwd)

    case 'models':
      return (await import('./commands/info.ts')).runModelsCommand()

    case 'memory':
      return (await import('./commands/info.ts')).runMemoryCommand(args.positional, config, cwd)

    case 'sessions':
      return (await import('./commands/info.ts')).runSessionsCommand(cwd)

    case 'skills':
      return (await import('./commands/info.ts')).runSkillsCommand(cwd)

    case 'plugins':
      return (await import('./commands/info.ts')).runPluginsCommand(cwd)

    case 'search':
      return (await import('./commands/extras.ts')).runSearchCommand(args.positional)

    case 'index':
      return (await import('./commands/extras.ts')).runIndexCommand(cwd)

    case 'scan':
      return (await import('./commands/extras.ts')).runScanCommand(args.positional, cwd)

    case 'eval':
      return (await import('./commands/eval.ts')).runEvalCommand(args.positional, config, {
        list: args.flags.list === true,
        verbose: args.flags.verbose === true,
        keep: args.flags.keep === true,
      })

    case 'schedule':
      return (await import('./commands/extras.ts')).runScheduleCommand(args.positional, cwd)

    case 'gateway':
      return (await import('./commands/extras.ts')).runGatewayCommand(args.positional, cwd, config)

    default:
      break
  }

  // Mode-selecting commands. `jean autonomous "goal"` sets the mode and treats
  // the rest of the line as the first prompt.
  let mode: Mode = config.mode
  let inlinePrompt: string | undefined

  if (args.command === 'autonomous' || args.command === 'swarm') {
    mode = args.command
    inlinePrompt = args.positional.join(' ') || undefined
  } else if (args.command && !args.flags.resume) {
    // `jean "do the thing"` — the whole command line is the prompt.
    inlinePrompt = [args.command, ...args.positional].join(' ')
  }

  config.mode = mode

  const promptFlag = typeof args.flags.prompt === 'string' ? args.flags.prompt : undefined
  const prompt = promptFlag ?? inlinePrompt

  // Resume: an explicit id, or the most recent session in this directory.
  let store
  let sessionId: string | undefined
  const resumeFlag = args.flags.resume
  if (args.command === 'resume' || resumeFlag !== undefined) {
    const requested =
      typeof resumeFlag === 'string' && resumeFlag !== 'true' ? resumeFlag : args.positional[0]
    const { latestSession, loadSession } = await import('@jean/core')
    const target = requested ?? latestSession(cwd)?.id
    if (!target) {
      errorLine(color.red('No previous session in this directory.'))
      return 1
    }
    store = loadSession(target)
    if (!store) {
      errorLine(color.red(`No session "${target}". Run \`jean sessions\` to list them.`))
      return 1
    }
    sessionId = target
  }

  // A prompt with `-p`, or any prompt on a non-TTY stdin, runs one-shot.
  const interactive = process.stdin.isTTY && !promptFlag

  if (prompt && !interactive) {
    return (await import('./commands/oneshot.ts')).runOneShot({
      prompt,
      config,
      cwd,
      format:
        args.flags['output-format'] === 'json' || args.flags['output-format'] === 'stream-json'
          ? args.flags['output-format']
          : 'text',
      quiet: args.flags.quiet === true,
      noSession: args.flags['no-session'] === true,
      store,
      sessionId,
      verify: typeof args.flags.verify === 'string' ? args.flags.verify : undefined,
    })
  }

  // The full-screen renderer needs a real terminal for raw-mode input and
  // cursor control; anywhere else the line-based session is the correct view,
  // not a degraded one.
  const wantsTui =
    args.flags['no-tui'] !== true &&
    Boolean(process.stdout.isTTY) &&
    Boolean(process.stdin.isTTY) &&
    process.env.TERM !== 'dumb'

  if (wantsTui) {
    return (await import('./tui-session.ts')).runTui({
      config,
      cwd,
      store,
      sessionId,
      initialPrompt: prompt,
      noSession: args.flags['no-session'] === true,
    })
  }

  // `jean "fix the failing test"` on a terminal starts interactively and runs
  // that prompt as the first turn, rather than dropping it.
  return (await import('./session.ts')).runInteractive({
    config,
    cwd,
    store,
    sessionId,
    initialPrompt: prompt,
    showThinking: config.debug,
    noSession: args.flags['no-session'] === true,
    verify: typeof args.flags.verify === 'string' ? args.flags.verify : undefined,
  })
}

function runConfigCommand(
  positional: string[],
  loaded: ReturnType<typeof loadConfig>,
  cwd: string,
): number {
  const [action, key, ...rest] = positional

  if (action === 'path' || action === undefined) {
    for (const source of loaded.sources) {
      line(`${source.kind.padEnd(10)} ${source.path}`)
    }
    return 0
  }

  if (action === 'get') {
    // Everything printed here goes through redaction: this output gets pasted
    // into issues and piped into logs.
    if (!key) {
      line(JSON.stringify(redactSecrets(loaded.config), null, 2))
      return 0
    }
    const value = redactSecrets(getSetting(loaded.config, key))
    if (value === undefined) {
      errorLine(color.red(`No setting "${key}".`))
      return 1
    }
    line(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
    return 0
  }

  if (action === 'set') {
    if (!key || rest.length === 0) {
      errorLine('Usage: jean config set <key> <value> [--project]')
      return 2
    }
    const scope = rest.includes('--project') ? 'project' : 'global'
    const raw = rest.filter((r) => r !== '--project').join(' ')
    const value = parseValue(raw)
    const path = setSetting(key, value, scope, cwd)
    line(`${color.green(symbols.check)} ${key} = ${JSON.stringify(value)} in ${path}`)
    return 0
  }

  errorLine(`Unknown config action "${action}". Use get, set, or path.`)
  return 2
}

/** Parses a CLI value into its JSON type, falling back to the string. */
function parseValue(raw: string): unknown {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw)
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

// `FLAGS` is re-exported so the completion generator and tests read one table.
export { FLAGS, VERSION }

const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')) ||
    import.meta.main === true)

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((err: unknown) => {
      errorLine(color.red(`${symbols.cross} ${err instanceof Error ? err.message : String(err)}`))
      if (process.env.JEAN_DEBUG && err instanceof Error && err.stack) errorLine(err.stack)
      process.exitCode = 1
    })
}

export { main }
