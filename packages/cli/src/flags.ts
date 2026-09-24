import type { PartialConfig } from '@jean/config'

/**
 * Flag parsing (architecture §25.2).
 *
 * Hand-rolled rather than an argument library: the flag table doubles as the
 * source for `--help` and for the completion scripts, so it has to be data this
 * package can read, not a builder's internal state.
 */

export interface FlagSpec {
  long: string
  short?: string
  /** `boolean` flags take no value. */
  type: 'string' | 'boolean' | 'number'
  description: string
  /** Valid values, for validation and completion. */
  values?: string[]
  placeholder?: string
}

export const FLAGS: FlagSpec[] = [
  { long: 'model', short: 'm', type: 'string', description: 'Model for this session (provider:model)', placeholder: '<model>' },
  { long: 'execution', short: 'e', type: 'string', description: 'Execution backend', values: ['local', 'docker', 'ssh', 'daytona', 'modal', 'singularity'] },
  { long: 'permission-mode', type: 'string', description: 'Permission gating', values: ['auto', 'ask', 'plan', 'full'] },
  { long: 'teammate-mode', short: 't', type: 'string', description: 'Teammate display mode', values: ['auto', 'in-process', 'tmux', 'iterm2'] },
  { long: 'effort', type: 'string', description: 'Reasoning depth', values: ['fast', 'normal', 'high', 'xhigh'] },
  { long: 'config', short: 'c', type: 'string', description: 'Use only this config file (ignores .jean.json)', placeholder: '<file>' },
  { long: 'prompt', short: 'p', type: 'string', description: 'One-shot prompt (non-interactive)', placeholder: '<text>' },
  { long: 'output-format', short: 'f', type: 'string', description: 'Output format for one-shot mode', values: ['text', 'json', 'stream-json'] },
  { long: 'quiet', short: 'q', type: 'boolean', description: 'Suppress progress output' },
  { long: 'resume', type: 'string', description: 'Resume a session by id, or the latest', placeholder: '[id]' },
  { long: 'max-turns', type: 'number', description: 'Stop after this many agent turns' },
  { long: 'verify', type: 'string', description: 'A command that must pass before the agent may stop (e.g. "npm test")' },
  { long: 'attempts', type: 'number', description: 'Parallel attempts for `jean arena` (default 3)' },
  { long: 'models', type: 'string', description: 'Comma-separated models to rotate through in `jean arena`' },
  { long: 'no-import', type: 'boolean', description: 'Do not read other agents’ config files' },
  { long: 'no-session', type: 'boolean', description: 'Do not write a session file' },
  { long: 'tui', type: 'boolean', description: 'Full-screen interface (default on a TTY)' },
  { long: 'no-tui', type: 'boolean', description: 'Line-based output instead of full screen' },
  { long: 'list', type: 'boolean', description: 'List items instead of acting (eval, skills)' },
  { long: 'verbose', type: 'boolean', description: 'Show detail that is normally summarized' },
  { long: 'keep', type: 'boolean', description: 'Keep the workspace of a failed eval case' },
  { long: 'debug', type: 'boolean', description: 'Verbose logging' },
  { long: 'version', short: 'v', type: 'boolean', description: 'Print the version' },
  { long: 'help', short: 'h', type: 'boolean', description: 'Show this help' },
]

export interface ParsedArgs {
  /** First non-flag argument: the subcommand, if any. */
  command?: string
  /** Remaining non-flag arguments. */
  positional: string[]
  flags: Record<string, string | boolean | number>
  /** Unrecognized flags, reported rather than ignored. */
  unknown: string[]
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean | number> = {}
  const positional: string[] = []
  const unknown: string[] = []

  const byLong = new Map(FLAGS.map((f) => [f.long, f]))
  const byShort = new Map(FLAGS.filter((f) => f.short).map((f) => [f.short!, f]))

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!

    if (arg === '--') {
      // Everything after `--` is positional, even if it looks like a flag.
      positional.push(...argv.slice(i + 1))
      break
    }

    if (!arg.startsWith('-')) {
      positional.push(arg)
      continue
    }

    // `--flag=value` and `--flag value` are both accepted.
    const isLong = arg.startsWith('--')
    const body = isLong ? arg.slice(2) : arg.slice(1)
    const eq = body.indexOf('=')
    const name = eq >= 0 ? body.slice(0, eq) : body
    const inline = eq >= 0 ? body.slice(eq + 1) : undefined

    const spec = isLong ? byLong.get(name) : byShort.get(name)
    if (!spec) {
      unknown.push(arg)
      continue
    }

    if (spec.type === 'boolean') {
      flags[spec.long] = inline === undefined ? true : inline !== 'false'
      continue
    }

    const value = inline ?? argv[++i]
    if (value === undefined) {
      unknown.push(`${arg} (missing value)`)
      continue
    }
    flags[spec.long] = spec.type === 'number' ? Number(value) : value
  }

  return {
    command: positional[0],
    positional: positional.slice(1),
    flags,
    unknown,
  }
}

/** Translates flags into a config layer. Invalid values are reported, not applied. */
export function flagsToConfig(
  flags: ParsedArgs['flags'],
): { config: PartialConfig; warnings: string[] } {
  const config: PartialConfig = {}
  const warnings: string[] = []

  const enumFlag = (name: string, apply: (value: string) => void) => {
    const value = flags[name]
    if (typeof value !== 'string') return
    const spec = FLAGS.find((f) => f.long === name)
    if (spec?.values && !spec.values.includes(value)) {
      warnings.push(`--${name} must be one of ${spec.values.join(', ')} — ignoring "${value}"`)
      return
    }
    apply(value)
  }

  if (typeof flags.model === 'string') {
    config.model = { modelId: flags.model }
  }
  enumFlag('permission-mode', (v) => {
    config.permissionMode = v as never
  })
  enumFlag('effort', (v) => {
    config.effort = v as never
  })
  enumFlag('execution', (v) => {
    config.execution = { backend: v as never }
  })
  enumFlag('teammate-mode', (v) => {
    config.teams = { teammateMode: v as never }
  })

  if (typeof flags['max-turns'] === 'number') {
    if (Number.isInteger(flags['max-turns']) && flags['max-turns'] > 0) {
      config.maxTurns = flags['max-turns']
    } else {
      warnings.push('--max-turns must be a positive integer — ignoring')
    }
  }
  if (flags.debug === true) config.debug = true

  return { config, warnings }
}

export const COMMANDS: { name: string; args?: string; description: string }[] = [
  { name: 'autonomous', args: '[prompt]', description: 'One agent that delegates when it helps (the default)' },
  { name: 'swarm', args: '<goal>', description: 'A team of agents on one ambitious task' },
  { name: 'resume', args: '[id]', description: 'Continue a previous session' },
  { name: 'sessions', description: 'List previous sessions' },
  { name: 'config', args: '[get|set|path] [key] [value]', description: 'Read or change settings' },
  { name: 'models', description: 'List available models and providers' },
  { name: 'memory', args: '[list|search|forget] [args]', description: 'Inspect stored memory' },
  { name: 'skills', description: 'List available skills' },
  { name: 'plugins', description: 'List installed plugins' },
  { name: 'search', args: '<query>', description: 'Search the web from the command line' },
  { name: 'index', description: 'Build the repository code map and summarize it' },
  { name: 'scan', args: '[path]', description: 'Scan for leaked secrets and unsafe patterns' },
  { name: 'eval', args: '[tag] [--list] [--verbose]', description: 'Run the evaluation suite against the model' },
  { name: 'schedule', args: '[list|add|remove|enable|disable|run]', description: 'Manage scheduled runs' },
  { name: 'gateway', args: '[start|link|status|unlink]', description: 'Reach this session from other platforms' },
  { name: 'serve', args: '[mcp|acp]', description: 'Expose Jean Code to another agent or editor' },
  { name: 'arena', args: '<task> [--attempts N] [--verify cmd]', description: 'Run several attempts in parallel and keep the best one' },
  { name: 'trust', description: 'Trust this project: enable its hooks, allow rules, and `!` commands' },
  { name: 'untrust', description: 'Stop trusting this project' },
  { name: 'doctor', description: 'Diagnose configuration and connectivity' },
  { name: 'native', args: '[status|build|test]', description: 'The Rust core: status, build it, or test every crate' },
  { name: 'lsp', args: '[status|servers|install|check]', description: 'Language servers: which are ready, install one, check files' },
  { name: 'debug', args: '[adapters|install]', description: 'Debug adapters: which are ready, install one' },
  { name: 'completions', args: '<bash|zsh|fish>', description: 'Print a shell completion script' },
  { name: 'version', description: 'Print the version' },
]

export function renderHelp(): string {
  const lines: string[] = [
    'jean — a coding agent that grows smarter every day.',
    '',
    'USAGE',
    '  jean [command] [options]',
    '  jean "fix the failing test in auth.test.ts"',
    '  jean -p "what does this service do?" -f json',
    '',
    'COMMANDS',
  ]

  for (const command of COMMANDS) {
    const label = `${command.name} ${command.args ?? ''}`.trim()
    lines.push(`  ${label.padEnd(34)} ${command.description}`)
  }

  lines.push('', 'OPTIONS')
  for (const flag of FLAGS) {
    const short = flag.short ? `-${flag.short}, ` : '    '
    const value = flag.type === 'boolean' ? '' : ` ${flag.placeholder ?? `<${flag.type}>`}`
    lines.push(`  ${short}--${flag.long}${value}`.padEnd(36) + ` ${flag.description}`)
  }

  lines.push(
    '',
    'ENVIRONMENT',
    '  OPENROUTER_API_KEY   Reaches every provider with one key (recommended)',
    '  ANTHROPIC_API_KEY    Anthropic direct',
    '  OPENAI_API_KEY       OpenAI direct',
    '  GOOGLE_API_KEY       Google Gemini direct',
    '  JEAN_HOME            Config and session directory (default ~/.jean)',
    '  JEAN_SHELL=native    Run bash commands in the embedded Rust shell',
    '  JEAN_NATIVE=0        Use the TypeScript fallbacks instead of the Rust core',
    '',
    'Run `jean doctor` if something is not working.',
  )

  return lines.join('\n')
}
