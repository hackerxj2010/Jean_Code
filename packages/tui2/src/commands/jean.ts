import { getCodebuffClient } from '../utils/codebuff-client'
import { getSystemMessage, getUserMessage } from '../utils/message-history'

import type { CommandDefinition, RouterParams } from './command-registry'

/**
 * Jean's own session commands in the full-screen interface.
 *
 * The same verbs as the line-based CLI — `/goal`, `/rewind`, `/arena`,
 * `/hooks`, `/mcp` — so moving between the two costs nothing. Each is a thin
 * call into the orchestrator; the behaviour lives there, once.
 *
 * Built as plain definitions rather than through `defineCommand`, whose module
 * imports this one: the type-only import keeps that from becoming a cycle.
 */

type Handler = (params: RouterParams, args: string) => Promise<string | void> | string | void

function command(name: string, handler: Handler, options: { args?: boolean; aliases?: string[] } = {}): CommandDefinition {
  return {
    name,
    aliases: options.aliases ?? [],
    acceptsArgs: options.args ?? false,
    handler: async (params, args) => {
      const input = params.inputValue.trim()
      params.saveToHistory(input)
      params.setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
      let reply: string | void
      try {
        reply = await handler(params, args ?? '')
      } catch (error) {
        reply = `✗ ${error instanceof Error ? error.message : String(error)}`
      }
      if (reply) {
        params.setMessages((prev) => [...prev, getUserMessage(input), getSystemMessage(reply)])
      }
      setTimeout(() => params.scrollToLatest(), 0)
    },
  }
}

async function orchestrator() {
  const client = await getCodebuffClient()
  if (!client) throw new Error('The agent is not available.')
  return client.agent()
}

export const JEAN_COMMANDS: CommandDefinition[] = [
  command(
    'goal',
    async (_, args) => {
      const agent = await orchestrator()
      const value = args.trim()
      if (!value) {
        const current = agent.verifyGoal()
        return current ? `Goal: \`${current}\` must pass before the agent stops.` : 'No goal set. Set one with a command that must pass, e.g. `/goal npm test`.'
      }
      if (value === 'off') {
        agent.setVerify(undefined)
        return 'Goal cleared.'
      }
      agent.setVerify(value)
      return `✓ The agent now keeps working until \`${value}\` passes.`
    },
    { args: true },
  ),

  command(
    'rewind',
    async (_, args) => {
      const agent = await orchestrator()
      const steps = Number(args.trim() || 1)
      const result = agent.rewind(Number.isFinite(steps) && steps > 0 ? steps : 1)
      if (!result) return 'Nothing to rewind yet.'
      const files = [...result.restored.map((p) => `restored ${p}`), ...result.removed.map((p) => `removed ${p}`)]
      return [
        `✓ Rewound ${result.turns} turn${result.turns === 1 ? '' : 's'} — the agent no longer remembers them.`,
        ...files.map((f) => `  ${f}`),
        `Rewound prompt: ${result.prompt.slice(0, 200)}`,
        'Changes made by shell commands are not tracked — check `git status`.',
      ].join('\n')
    },
    { args: true, aliases: ['undo'] },
  ),

  command(
    'arena',
    async (params, args) => {
      const agent = await orchestrator()
      const parts = args.trim().split(/\s+/)
      const attempts = /^\d+$/.test(parts[0] ?? '') ? Number(parts.shift()) : 3
      const task = parts.join(' ').trim()
      if (!task) return 'Usage: `/arena 3 fix the failing auth test` — set a `/goal` first so attempts can be judged.'
      params.setMessages((prev) => [
        ...prev,
        getSystemMessage(`Arena: ${attempts} attempts in parallel${agent.verifyGoal() ? `, judged by \`${agent.verifyGoal()}\`` : ''}…`),
      ])
      const result = await agent.arena(task, { attempts })
      const rows = result.entries.map((e, i) => {
        const mark = i === result.winner ? '★' : e.passed === false ? '✗' : '·'
        const check = e.passed === undefined ? '' : e.passed ? ' pass' : ' fail'
        return `  ${mark} #${e.attempt} ${e.model}${check} — ${e.lines} lines, ${e.turns} turns, ${Math.round(e.durationMs / 1000)}s`
      })
      return [...rows, '', result.merged ? `✓ ${result.message}` : `⚠ ${result.message}`].join('\n')
    },
    { args: true },
  ),

  command('hooks', async () => {
    const agent = await orchestrator()
    const lines: string[] = []
    const hooks = agent.hooks.list()
    lines.push(hooks.length === 0 ? 'No hooks.' : 'Hooks:')
    for (const { event, hook } of hooks) {
      lines.push(`  ${event}${hook.matcher ? ` (${hook.matcher})` : ''} — ${hook.command}  [${hook.source}]`)
    }
    const rules = agent.policy.policy.rules
    lines.push('', rules.length === 0 ? 'No permission rules.' : 'Permission rules:')
    for (const rule of rules) lines.push(`  ${rule.decision.padEnd(5)} ${rule.raw}`)
    if (agent.policy.ignored.length > 0) {
      lines.push('', `⚠ ${agent.policy.ignored.length} project entries ignored — this project is not trusted. /trust to enable.`)
    }
    return lines.join('\n')
  }),

  command('mcp', async () => {
    const agent = await orchestrator()
    const servers = await agent.mcpServers()
    return servers.length === 0
      ? 'No MCP servers connected. Add them under "mcpServers" in .jean.json, ~/.jean/config.json, or .mcp.json.'
      : ['MCP servers:', ...servers.map((s) => `  ${s}`)].join('\n')
  }),

  command(
    'lsp',
    async (_, args) => {
      const agent = await orchestrator()
      return agent.languageReport('lsp', args.trim() || undefined)
    },
    { args: true },
  ),

  command(
    'debug',
    async (_, args) => {
      const agent = await orchestrator()
      return agent.languageReport('debug', args.trim() || undefined)
    },
    { args: true },
  ),

  command('agents', async () => {
    const agent = await orchestrator()
    return [
      'Agents `spawn` can start:',
      ...agent.agents().map((a) => `  ${a.name} — ${a.purpose.slice(0, 100)}${a.source ? ` [${a.source.split(':')[0]}]` : ''}`),
      '',
      'Add one at `.jean/agents/your-agent.md` (front matter: name, description, tools, model).',
    ].join('\n')
  }),

  command('commands', async () => {
    const agent = await orchestrator()
    const commands = agent.commands()
    if (commands.length === 0) {
      return 'No custom commands. Add one at `.jean/commands/your-command.md` — the body is the prompt; `$ARGUMENTS` is what follows the command.'
    }
    return ['Custom commands:', ...commands.map((c) => `  /${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''} — ${c.description}`)].join('\n')
  }),

  command('trust', async () => {
    const { trustProject } = await import('@jean/hooks')
    const agent = await orchestrator()
    const cwd = agent.store.all()[0]?.type === 'session_start' ? (agent.store.all()[0] as { cwd: string }).cwd : process.cwd()
    trustProject(cwd)
    return `✓ Trusted ${cwd}. Its hooks, allow rules, MCP servers, and \`!\` commands apply from the next session.`
  }),
]

/** Whether `/name` is a custom command, which goes to the agent to be expanded. */
export async function isCustomCommand(name: string): Promise<boolean> {
  try {
    const agent = await orchestrator()
    return agent.commands().some((c) => c.name === name)
  } catch {
    return false
  }
}
