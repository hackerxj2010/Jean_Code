import type { Mode } from '@jean/config'
import { compact, listSessions } from '@jean/core'
import { describeKeywords, type Orchestrator } from '@jean/agent'
import { describeCommands } from '@jean/commands'
import { trustProject } from '@jean/hooks'
import { allModels, estimateCost, type ModelClient } from '@jean/model'
import { nativeReady } from '@jean/native'
import { color, line, symbols } from '../ui.ts'
import { printNativeReport } from './native.ts'

/**
 * Slash commands (architecture §26).
 *
 * These run locally and never reach the model. Anything the user wants to do
 * *to* the session — change modes, inspect state, clear context — belongs here
 * rather than as a tool, because the agent should not be able to do it to
 * itself without being asked.
 */

export interface SlashContext {
  orchestrator: Orchestrator
  client: ModelClient
  cwd: string
  sessionId: string
  /** Set to true to end the session. */
  exit: () => void
}

export interface SlashCommand {
  name: string
  args?: string
  description: string
  run: (args: string[], context: SlashContext) => Promise<void> | void
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    description: 'Show these commands',
    run() {
      line()
      line(color.bold('Commands'))
      for (const command of SLASH_COMMANDS) {
        const label = `/${command.name}${command.args ? ` ${command.args}` : ''}`
        line(`  ${color.cyan(label.padEnd(22))} ${command.description}`)
      }
      line()
      line(color.bold('Keywords') + color.dim(' — use inline in any prompt'))
      line(describeKeywords())
      line()
      line(color.dim('  Ctrl+C interrupts a run. Ctrl+D or /exit ends the session.'))
      line()
    },
  },
  {
    name: 'autonomous',
    description: 'Switch to autonomous mode (one agent, delegates when it helps)',
    run: (_, context) => setMode(context, 'autonomous'),
  },
  {
    name: 'swarm',
    description: 'Switch to swarm mode (agent team)',
    run: (_, context) => setMode(context, 'swarm'),
  },
  {
    name: 'model',
    args: '[model]',
    description: 'Show or change the model for this session',
    run(args, context) {
      const resolved = context.client.resolve('default')
      if (args.length === 0) {
        line(`  ${color.cyan(resolved.modelId)} via ${resolved.provider}`)
        if (resolved.fallbacks.length > 0) {
          line(color.dim(`  fallbacks: ${resolved.fallbacks.map((f) => f.modelId).join(', ')}`))
        }
        return
      }
      // Session-scoped: the config file is not rewritten by a slash command.
      context.orchestrator.config.agents.default.model = args[0]
      context.orchestrator.config.model.modelId = args[0]!
      line(`${symbols.check} Model set to ${color.cyan(args[0]!)} for this session.`)
      line(color.dim('  Use `jean config set agents.default.model <id>` to make it permanent.'))
    },
  },
  {
    name: 'models',
    description: 'List models in the catalog',
    run() {
      line()
      for (const model of allModels()) {
        const window = `${Math.round(model.contextWindow / 1000)}k`
        const price =
          model.inputCost !== undefined ? `$${model.inputCost}/$${model.outputCost} per Mtok` : ''
        line(
          `  ${color.cyan(model.id.padEnd(34))} ${window.padStart(6)} ${color.dim(price)}`,
        )
      }
      line()
    },
  },
  {
    name: 'effort',
    args: '<fast|normal|high|xhigh>',
    description: 'Set reasoning depth',
    run(args, context) {
      const level = args[0]
      if (!level || !['fast', 'normal', 'high', 'xhigh'].includes(level)) {
        line(`  Current: ${color.cyan(context.orchestrator.config.effort)}`)
        line(color.dim('  Usage: /effort <fast|normal|high|xhigh>'))
        return
      }
      context.orchestrator.config.effort = level as never
      line(`${symbols.check} Effort set to ${color.cyan(level)}.`)
    },
  },
  {
    name: 'permissions',
    args: '<auto|ask|plan|full>',
    description: 'Change permission gating',
    run(args, context) {
      const mode = args[0]
      if (!mode || !['auto', 'ask', 'plan', 'full'].includes(mode)) {
        line(`  Current: ${color.cyan(context.orchestrator.config.permissionMode)}`)
        line(color.dim('  auto — confirm destructive only | ask — confirm every change'))
        line(color.dim('  plan — read-only            | full — never confirm'))
        return
      }
      context.orchestrator.config.permissionMode = mode as never
      line(`${symbols.check} Permission mode set to ${color.cyan(mode)}.`)
    },
  },
  {
    name: 'context',
    description: 'Show context usage and session stats',
    run(_, context) {
      const usage = context.orchestrator.store.usage()
      const resolved = context.client.resolve('default')
      const spent = estimateCost(resolved.modelId, usage.inputTokens, usage.outputTokens)
      const files = context.orchestrator.store.touchedFiles()

      line()
      line(`  Turns        ${usage.turns}`)
      line(`  Tokens in    ${usage.inputTokens.toLocaleString()}`)
      line(`  Tokens out   ${usage.outputTokens.toLocaleString()}`)
      if (spent > 0) line(`  Cost         ~$${spent.toFixed(3)}`)
      line(`  Events       ${context.orchestrator.store.length}`)
      if (files.length > 0) {
        line(`  Files        ${files.length}`)
        for (const file of files.slice(0, 10)) line(color.dim(`    ${file}`))
        if (files.length > 10) line(color.dim(`    ... and ${files.length - 10} more`))
      }
      line()
    },
  },
  {
    name: 'compact',
    description: 'Summarize the conversation so far and continue',
    async run(_, context) {
      line(color.dim('  compacting...'))
      const result = await compact(context.orchestrator.store, context.client, {
        reason: 'manual',
      })
      if (!result) {
        line('  Not enough history to compact yet.')
        return
      }
      context.orchestrator.persist()
      line(
        `${symbols.check} Compacted ${result.tokensBefore.toLocaleString()} → ${result.tokensAfter.toLocaleString()} tokens${result.modelGenerated ? '' : color.dim(' (without a model call)')}.`,
      )
    },
  },
  {
    name: 'clear',
    description: 'Start a fresh context, keeping the session file',
    run(_, context) {
      // Rewind to just after `session_start`: the session file keeps the full
      // history, the model sees an empty conversation.
      context.orchestrator.store.rewind(1)
      context.orchestrator.persist()
      line(`${symbols.check} Context cleared.`)
    },
  },
  {
    name: 'sessions',
    description: 'List recent sessions in this directory',
    run(_, context) {
      const sessions = listSessions(context.cwd, 10)
      if (sessions.length === 0) {
        line('  No previous sessions here.')
        return
      }
      line()
      for (const session of sessions) {
        const when = new Date(session.updatedAt).toLocaleString()
        const current = session.id === context.sessionId ? color.green(' (current)') : ''
        line(`  ${color.cyan(session.id)}${current}`)
        line(color.dim(`    ${when} · ${session.events} events · ${session.title}`))
      }
      line()
      line(color.dim('  Resume with `jean resume <id>`.'))
      line()
    },
  },
  {
    name: 'tools',
    description: 'List the tools available to the agent',
    run(_, context) {
      const registry = context.orchestrator.registry
      const mode = context.orchestrator.config.permissionMode
      const visible = new Set(registry.schemas(mode).map((s) => s.name))
      line()
      for (const name of registry.names()) {
        const tool = registry.get(name)!
        const mark = visible.has(name) ? color.green(symbols.check) : color.dim(symbols.cross)
        const risk = color.dim(`[${tool.risk}]`.padEnd(10))
        line(`  ${mark} ${color.cyan(name.padEnd(14))} ${risk} ${tool.description.split('\n')[0]}`)
      }
      if (mode === 'plan') line(color.dim(`\n  Plan mode hides every tool that can change things.`))
      line()
    },
  },
  {
    name: 'commands',
    description: 'List custom commands from .jean/commands and .claude/commands',
    run(_, context) {
      line()
      line(describeCommands(context.orchestrator.commands()))
      line()
    },
  },
  {
    name: 'agents',
    description: 'List the agents `spawn` can start, built-in and custom',
    run(_, context) {
      line()
      for (const agent of context.orchestrator.agents()) {
        const where = agent.source ? color.dim(` [${agent.source.split(':')[0]}]`) : color.dim(' [built-in]')
        line(`  ${color.cyan(agent.name.padEnd(22))} ${agent.purpose.slice(0, 90)}${where}`)
      }
      line(color.dim('\n  Add one at .jean/agents/<name>.md — front matter: name, description, tools, model.'))
      line()
    },
  },
  {
    name: 'mcp',
    description: 'List connected MCP servers and their tools',
    async run(_, context) {
      const servers = await context.orchestrator.mcpServers()
      line()
      if (servers.length === 0) {
        line(color.dim('  No MCP servers connected. Add them under "mcpServers" in .jean.json or ~/.jean/config.json,'))
        line(color.dim('  or in .mcp.json — stdio ({"command": ...}) and remote ({"url": ..., "headers": ...}) both work.'))
      }
      for (const server of servers) line(`  ${color.cyan(server)}`)
      line()
    },
  },
  {
    name: 'hooks',
    description: 'List active hooks and permission rules',
    run(_, context) {
      const { hooks, policy } = context.orchestrator
      line()
      const listed = hooks.list()
      if (listed.length === 0) line(color.dim('  No hooks.'))
      for (const { event, hook } of listed) {
        const matcher = hook.matcher ? color.dim(` (${hook.matcher})`) : ''
        line(`  ${color.cyan(event.padEnd(17))}${matcher} ${hook.command.slice(0, 80)}`)
        line(color.dim(`  ${''.padEnd(17)} from ${hook.source}`))
      }
      line()
      if (policy.policy.rules.length === 0) line(color.dim('  No permission rules.'))
      for (const rule of policy.policy.rules) {
        const tag = rule.decision === 'deny' ? color.red('deny ') : rule.decision === 'ask' ? color.yellow('ask  ') : color.green('allow')
        line(`  ${tag} ${rule.raw}`)
      }
      if (policy.ignored.length > 0) {
        line()
        line(color.yellow(`  ${policy.ignored.length} project entr${policy.ignored.length === 1 ? 'y' : 'ies'} ignored — this project is not trusted. /trust to enable.`))
      }
      line()
    },
  },
  {
    name: 'goal',
    args: '[command | off]',
    description: 'Require a command (e.g. npm test) to pass before the agent may stop',
    run(args, context) {
      const command = args.join(' ').trim()
      if (!command) {
        const current = context.orchestrator.verifyGoal()
        line(current ? `  Goal: ${color.cyan(current)} must pass.` : color.dim('  No goal set. /goal <command> sets one.'))
        return
      }
      if (command === 'off') {
        context.orchestrator.setVerify(undefined)
        line(`${symbols.check} Goal cleared.`)
        return
      }
      context.orchestrator.setVerify(command)
      line(`${symbols.check} The agent now keeps working until ${color.cyan(command)} passes.`)
    },
  },
  {
    name: 'rewind',
    args: '[turns]',
    description: 'Undo the last turn(s): restore edited files and forget the conversation since',
    run(args, context) {
      const steps = Number(args[0] ?? 1)
      const available = context.orchestrator.rewindable()
      if (available.length === 0) {
        line(color.dim('  Nothing to rewind yet.'))
        return
      }
      const result = context.orchestrator.rewind(Number.isFinite(steps) && steps > 0 ? steps : 1)
      if (!result) return
      const files = result.restored.length + result.removed.length
      line(
        `${symbols.check} Rewound ${result.turns} turn${result.turns === 1 ? '' : 's'}: ${files} file${files === 1 ? '' : 's'} restored.`,
      )
      for (const path of result.restored) line(color.dim(`  restored ${path}`))
      for (const path of result.removed) line(color.dim(`  removed  ${path}`))
      line(color.dim(`  The rewound prompt was: ${result.prompt.slice(0, 120)}`))
      line(color.dim('  Changes made by shell commands are not tracked — check `git status`.'))
    },
  },
  {
    name: 'arena',
    args: '[attempts] <task>',
    description: 'Run several attempts in parallel and keep the best (judged by /goal)',
    async run(args, context) {
      const attempts = /^\d+$/.test(args[0] ?? '') ? Number(args.shift()) : 3
      const task = args.join(' ').trim()
      if (!task) {
        line(color.dim('  /arena [attempts] <task> — set a /goal first so attempts can be judged.'))
        return
      }
      try {
        const result = await context.orchestrator.arena(task, { attempts })
        for (const entry of result.entries) {
          const check = entry.passed === undefined ? '' : entry.passed ? color.green(' pass') : color.red(' fail')
          line(`  #${entry.attempt}${check} ${entry.lines} lines, ${entry.turns} turns`)
        }
        line(result.merged ? `${symbols.check} ${result.message}` : color.yellow(`${symbols.warn} ${result.message}`))
      } catch (err) {
        line(color.red(`${symbols.cross} ${err instanceof Error ? err.message : String(err)}`))
      }
    },
  },
  {
    name: 'undo',
    description: 'Same as /rewind 1',
    run(_, context) {
      return SLASH_COMMANDS.find((c) => c.name === 'rewind')!.run([], context)
    },
  },
  {
    name: 'trust',
    description: "Trust this project: allow its own hooks, allow rules, and `!` commands",
    run(_, context) {
      trustProject(context.cwd)
      line(`${symbols.check} Trusted ${color.cyan(context.cwd)}.`)
      line(color.dim('  Project hooks and allow rules apply from the next session. `jean untrust` reverses this.'))
    },
  },
  {
    name: 'copy',
    args: '[n]',
    description: 'Copy the last (or nth-last) response to the clipboard',
    async run(args, context) {
      const back = Math.max(1, Number.parseInt(args[0] ?? '1', 10) || 1)
      const responses = context.orchestrator.store
        .ofType('assistant_message')
        .map((event) =>
          event.content
            .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
            .map((block) => block.text)
            .join('')
            .trim(),
        )
        .filter((text) => text !== '')
      const text = responses[responses.length - back]
      if (!text) {
        line('  No response to copy yet.')
        return
      }
      // `pi-sys` picks the platform's clipboard (Win32, pbcopy, wl-copy,
      // xclip, xsel) and answers with the one it used.
      const native = await nativeReady()
      if (!native) {
        line(color.red(`${symbols.cross} The clipboard goes through the native bridge, which is not built.`))
        line(color.dim('  Run `jean native build`.'))
        return
      }
      try {
        const backend = await native.copy(text)
        line(`${symbols.check} Copied ${text.length.toLocaleString()} characters ${color.dim(`(${backend})`)}.`)
      } catch (err) {
        line(color.red(`${symbols.cross} ${err instanceof Error ? err.message : String(err)}`))
      }
    },
  },
  {
    name: 'lsp',
    args: '[file]',
    description: 'Language servers: running, available, and what each has been saying',
    async run(args, context) {
      line()
      line(await context.orchestrator.languageReport('lsp', args[0]))
      line()
    },
  },
  {
    name: 'debug',
    args: '[file]',
    description: 'Debug sessions and the adapters available',
    async run(args, context) {
      line()
      line(await context.orchestrator.languageReport('debug', args[0]))
      line()
    },
  },
  {
    name: 'native',
    description: 'Show the Rust core: build, methods, and calls made this session',
    async run() {
      await printNativeReport()
    },
  },
  {
    name: 'exit',
    description: 'End the session',
    run(_, context) {
      context.exit()
    },
  },
]

function setMode(context: SlashContext, mode: Mode): void {
  context.orchestrator.setMode(mode)
  line(`${symbols.check} Mode: ${color.cyan(mode)}`)
}

/**
 * Parses and runs a slash command.
 *
 * Returns false if the input is not a command, true if a built-in handled it,
 * or `{ send }` when it named a custom command — whose expansion is a prompt
 * for the agent rather than something to run locally.
 */
export async function runSlashCommand(
  input: string,
  context: SlashContext,
): Promise<boolean | { send: string }> {
  if (!input.startsWith('/')) return false

  const [name, ...args] = input.slice(1).trim().split(/\s+/)
  const command = SLASH_COMMANDS.find((c) => c.name === name)

  if (!command) {
    const custom = await context.orchestrator.expandSlash(input)
    if (custom) {
      for (const note of custom.notes) line(color.yellow(`${symbols.warn} ${note}`))
      line(color.dim(`  /${custom.command.name} — ${custom.command.description}`))
      return { send: custom.prompt }
    }
    line(color.red(`Unknown command /${name}.`) + color.dim(' Try /help or /commands.'))
    return true
  }

  await command.run(args, context)
  return true
}

export function slashCommandNames(orchestrator?: Orchestrator): string[] {
  return [
    ...SLASH_COMMANDS.map((c) => `/${c.name}`),
    ...(orchestrator?.commands().map((c) => `/${c.name}`) ?? []),
  ]
}
