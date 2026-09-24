/**
 * `/connect` and `/models` — providers and models, on Jean's own model layer.
 *
 * `/connect` shows which providers have credentials and saves a key given to
 * it; `/models` lists the catalog and switches the session's model, as
 * `/model` does in the line-based CLI.
 */

import { configuredProviders, maskSecret, PROVIDER_KEY_ENV, setSetting } from '@jean/config'
import { allModels, findModel, providerLabel, providerNames } from '@jean/model'

import { getCodebuffClient } from '../utils/codebuff-client'
import { getSystemMessage, getUserMessage } from '../utils/message-history'

import type { CommandResult, RouterParams } from './command-registry'

async function orchestrator() {
  const client = await getCodebuffClient()
  if (!client) throw new Error('The agent is not available.')
  return client.agent()
}

function reply(params: RouterParams, text: string): void {
  const input = params.inputValue.trim()
  params.saveToHistory(input)
  params.setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
  params.setMessages((prev) => [...prev, getUserMessage(input), getSystemMessage(text)])
  setTimeout(() => params.scrollToLatest(), 0)
}

/** Providers with credentials: from the environment, or from config. */
async function connected(): Promise<Set<string>> {
  const names = new Set(configuredProviders())
  const agent = await orchestrator().catch(() => undefined)
  for (const [name, provider] of Object.entries(agent?.config.providers ?? {})) {
    if (provider.apiKey) names.add(name)
  }
  return names
}

function statusTable(ready: Set<string>): string {
  const rows = providerNames().map((name) => {
    const env = PROVIDER_KEY_ENV[name] ?? []
    const how = env.length === 0 ? 'local endpoint' : `\`${env[0]}\``
    return `| \`${name}\` | ${providerLabel(name)} | ${ready.has(name) ? '✅ ready' : '— not set'} | ${how} |`
  })
  return ['| Id | Provider | Status | Credential |', '|----|----------|--------|------------|', ...rows].join('\n')
}

/**
 * `/connect` — status; `/connect <provider>` — how to connect it;
 * `/connect <provider> <key>` — save the key and use it now.
 */
export async function handleConnectCommand(params: RouterParams, args: string): Promise<CommandResult> {
  const [name, key] = args.trim().split(/\s+/).filter(Boolean)
  const ready = await connected()

  if (!name || name === 'status') {
    reply(params, `## Providers\n\n${statusTable(ready)}\n\n\`/connect <id> <api-key>\` saves a key; \`/models\` lists what each offers.`)
    return
  }

  const provider = name.toLowerCase()
  if (!providerNames().includes(provider)) {
    reply(params, `Unknown provider \`${provider}\`. Known: ${providerNames().map((p) => `\`${p}\``).join(', ')}.`)
    return
  }

  const env = PROVIDER_KEY_ENV[provider] ?? []
  if (!key) {
    reply(
      params,
      env.length === 0
        ? `**${providerLabel(provider)}** runs locally: set \`LOCAL_ENDPOINT\` (or \`providers.${provider}.baseUrl\`) to its address.`
        : `**${providerLabel(provider)}** is ${ready.has(provider) ? 'ready' : 'not set up'}.\n\nRun \`/connect ${provider} <api-key>\`, or set \`${env[0]}\` and restart.`,
    )
    return
  }

  // Saved like `jean config set`, and put in the environment so the provider
  // picks it up in this session without a restart.
  const path = setSetting(`providers.${provider}.apiKey`, key, 'global')
  if (env[0]) process.env[env[0]] = key
  const agent = await orchestrator().catch(() => undefined)
  if (agent) agent.config.providers[provider] = { ...agent.config.providers[provider], apiKey: key }
  reply(params, `✓ **${providerLabel(provider)}** connected with \`${maskSecret(key)}\`, saved in \`${path}\`.`)
}

/** `/models` — the catalog; `/models <id>` — use that model for this session. */
export async function handleModelsCommand(params: RouterParams, args: string): Promise<CommandResult> {
  const wanted = args.trim()
  const agent = await orchestrator()

  if (!wanted) {
    const ready = await connected()
    const active = agent.config.agents.default.model ?? agent.config.model.modelId
    const byProvider = new Map<string, ReturnType<typeof allModels>>()
    for (const model of allModels()) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model])
    const sections = [...byProvider].map(([provider, models]) => {
      const lines = models.map((m) => {
        const window = m.contextWindow >= 1_000_000 ? `${Math.round(m.contextWindow / 1_000_000)}M` : `${Math.round(m.contextWindow / 1000)}K`
        const price = m.inputCost === undefined ? '' : ` · $${m.inputCost}/$${m.outputCost} per Mtok`
        return `${m.id === active ? '→' : ' '} \`${m.id}\` — ${m.label} · ${window}${price}`
      })
      return `### ${providerLabel(provider)}${ready.has(provider) ? ' ✅' : ''}\n\n${lines.join('\n')}`
    })
    reply(params, [`## Models\n\n**Active:** \`${active}\``, ...sections, '`/models <id>` switches this session.'].join('\n\n'))
    return
  }

  // Session-scoped, as in the line-based CLI: the config file is not rewritten.
  agent.config.agents.default.model = wanted
  agent.config.model.modelId = wanted
  const known = findModel(wanted)
  reply(
    params,
    known
      ? `✓ Using \`${wanted}\` (${known.label}) for this session.`
      : `✓ Using \`${wanted}\` for this session. It is not in the catalog, so its context window and prices are guesses.`,
  )
}
