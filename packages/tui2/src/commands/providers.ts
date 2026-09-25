/**
 * `/connect` and `/models` — providers and models, on Jean's own model layer.
 *
 * Without arguments each opens the picker in place of the prompt: `/models`
 * lists favorites, recent picks, and every connected provider's models;
 * `/connect` lists every provider Jean reaches and asks for the key of the
 * one chosen. With arguments they act at once, as in the line-based CLI:
 * `/models opencode:claude-sonnet-5`, `/connect opencode <key>`.
 */

import { maskSecret, saveKey } from '@jean/config'
import { findModel, hasCredentials, providerEntry, providerLabel } from '@jean/model'

import { usePickerStore, type PickerView } from '../state/picker-store'
import { getCodebuffClient } from '../utils/codebuff-client'
import { getSystemMessage, getUserMessage } from '../utils/message-history'

import type { CommandResult, RouterParams } from './command-registry'

async function orchestrator() {
  const client = await getCodebuffClient()
  if (!client) throw new Error('The agent is not available.')
  return client.agent()
}

function clearInput(params: RouterParams): string {
  const input = params.inputValue.trim()
  params.saveToHistory(input)
  params.setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
  return input
}

function reply(params: RouterParams, input: string, text: string): void {
  params.setMessages((prev) => [...prev, getUserMessage(input), getSystemMessage(text)])
  setTimeout(() => params.scrollToLatest(), 0)
}

/** Opens a picker view; what it ends with is posted to the conversation. */
function openPicker(params: RouterParams, input: string, view: PickerView): void {
  usePickerStore.getState().open(view, (text) => reply(params, input, text))
}

/**
 * `/connect` — the provider picker; `/connect <provider>` — its key, or its
 * models when it has one; `/connect <provider> <key>` — save the key.
 */
export async function handleConnectCommand(params: RouterParams, args: string): Promise<CommandResult> {
  const input = clearInput(params)
  const [name, key] = args.trim().split(/\s+/).filter(Boolean)

  if (!name) {
    openPicker(params, input, { kind: 'providers' })
    return
  }

  const agent = await orchestrator().catch(() => undefined)
  const providers = agent?.config.providers ?? {}
  const provider = name.toLowerCase()
  const entry = providerEntry(provider, providers)
  if (!entry) {
    reply(params, input, `Unknown provider \`${provider}\`. \`/connect\` lists every one Jean reaches.`)
    return
  }
  if (entry.api === undefined) {
    reply(params, input, `**${entry.label}** needs its own sign-in, which Jean does not speak yet.`)
    return
  }

  if (!key) {
    openPicker(params, input, entry.local || hasCredentials(provider, providers) ? { kind: 'models', only: provider } : { kind: 'key', provider })
    return
  }

  // Saved beside the config rather than in it, and used from the next request.
  const path = saveKey(provider, key)
  agent?.useProviderKey(provider, key)
  reply(params, input, `✓ **${entry.label}** connected with \`${maskSecret(key)}\`, saved in \`${path}\`. \`/models\` lists its models.`)
}

/** `/models` — the model picker; `/models <provider:model>` — use that model now. */
export async function handleModelsCommand(params: RouterParams, args: string): Promise<CommandResult> {
  const input = clearInput(params)
  const wanted = args.trim()

  if (!wanted) {
    openPicker(params, input, { kind: 'models' })
    return
  }

  const agent = await orchestrator()
  // A provider's name alone lists its models.
  if (!wanted.includes(':') && !wanted.includes('/') && providerEntry(wanted, agent.config.providers)) {
    openPicker(params, input, { kind: 'models', only: wanted })
    return
  }

  // Session-scoped, as in the line-based CLI: the config file is not rewritten.
  const chosen = agent.setModel(wanted)
  const known = findModel(chosen.modelId, chosen.provider)
  const ref = `${chosen.provider}:${chosen.modelId}`
  reply(
    params,
    input,
    known
      ? `✓ Using \`${ref}\` (${known.label}, ${providerLabel(chosen.provider)}) for this session.`
      : `✓ Using \`${ref}\` for this session. It is not in the catalog, so its context window and prices are guesses.`,
  )
}
