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

  command('redo', async () => {
    const agent = await orchestrator()
    const result = agent.redo()
    if (!result) return 'Nothing to redo — `/undo` first; a new prompt clears what could be redone.'
    const files = [...result.restored.map((p) => `restored ${p}`), ...result.removed.map((p) => `removed ${p}`)]
    return [
      `✓ Redid ${result.turns} turn${result.turns === 1 ? '' : 's'} — the agent remembers them again.`,
      ...files.map((f) => `  ${f}`),
      `Redone prompt: ${result.prompt.slice(0, 200)}`,
    ].join('\n')
  }),

  command(
    'compact',
    async (params) => {
      params.setMessages((prev) => [...prev, getSystemMessage('Summarizing the conversation so far…')])
      const agent = await orchestrator()
      const result = await agent.compactNow()
      if (!result) return 'Not enough history to compact yet.'
      return `✓ Compacted ${result.tokensBefore.toLocaleString()} → ${result.tokensAfter.toLocaleString()} tokens${result.modelGenerated ? '' : ' (without a model call)'}.`
    },
    { aliases: ['summarize'] },
  ),

  command(
    'export',
    async (_, args) => {
      const agent = await orchestrator()
      const sanitize = /\bsanitize\b/.test(args)
      const doc = agent.exportTranscript({ sanitize })
      if (!doc) return 'Nothing to export yet — send a prompt first.'
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      const { sessionMarkdown } = await import('@jean/core')
      const dir = join(doc.meta.cwd || process.cwd(), '.jean', 'exports')
      mkdirSync(dir, { recursive: true })
      const base = join(dir, `${doc.id}${sanitize ? '.sanitized' : ''}`)
      writeFileSync(`${base}.md`, sessionMarkdown(doc))
      writeFileSync(`${base}.json`, `${JSON.stringify(doc, null, 2)}\n`)
      return [
        `✓ Exported this session${sanitize ? ' without secrets, file contents, or tool output' : ''}:`,
        `  ${base}.md`,
        `  ${base}.json   (\`jean import\` continues it anywhere)`,
        sanitize ? '' : '`/export sanitize` makes a copy safe to share.',
      ]
        .filter(Boolean)
        .join('\n')
    },
    { args: true },
  ),

  command(
    'stats',
    async () => {
      const agent = await orchestrator()
      const { estimateCost, findModel } = await import('@jean/model')
      const usage = agent.store.usage()
      const { provider, modelId } = agent.config.model
      const cost = estimateCost(modelId, usage.inputTokens, usage.outputTokens, provider, usage.cacheReadTokens ?? 0)
      const info = findModel(modelId, provider)
      return [
        `**This session** — ${provider}:${modelId}`,
        '',
        '| Turns | Tokens in | Tokens out | From cache | Cost |',
        '|------:|----------:|-----------:|-----------:|-----:|',
        `| ${usage.turns} | ${usage.inputTokens.toLocaleString()} | ${usage.outputTokens.toLocaleString()} | ${(usage.cacheReadTokens ?? 0).toLocaleString()} | ${info?.free ? 'free' : `~$${cost.toFixed(4)}`} |`,
        '',
        '`jean stats` adds up every session: by model, by tool, by day.',
      ].join('\n')
    },
    { aliases: ['cost', 'usage'] },
  ),

  command(
    'effort',
    async (_, args) => {
      const agent = await orchestrator()
      const levels = ['fast', 'normal', 'high', 'xhigh'] as const
      const wanted = args.trim().toLowerCase()
      const current = agent.config.effort
      const next = wanted
        ? levels.find((level) => level === wanted)
        : levels[(levels.indexOf(current as (typeof levels)[number]) + 1) % levels.length]
      if (!next) return `Unknown effort "${wanted}". One of: ${levels.join(', ')}.`
      agent.config.effort = next
      return `✓ Reasoning effort: **${next}** (was ${current}). \`/effort\` alone cycles fast → normal → high → xhigh.`
    },
    { args: true, aliases: ['variant'] },
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
