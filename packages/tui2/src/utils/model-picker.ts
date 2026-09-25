import { splitModelRef, type ProviderConfig } from '@jean/config'
import {
  favoriteModels,
  findModel,
  hasCredentials,
  listProviders,
  modelsOf,
  providerLabel,
  recentModels,
  reservedModel,
  type ModelInfo,
  type ProviderEntry,
} from '@jean/model'

/**
 * The rows of the `/models` and `/connect` pickers, built without React so
 * what they offer, in what order, and what a search finds can be tested.
 */

export interface PickerRow {
  /** `provider:model` for a model; the provider id for a provider; an action name. */
  id: string
  kind: 'model' | 'provider' | 'action'
  label: string
  icon: string
  /** Everything a search matches against. */
  secondary: string
  hideSecondary: true
  accent?: boolean
  provider?: string
}

function window(tokens: number): string {
  if (tokens <= 0) return ''
  return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1000)}K`
}

function price(model: ModelInfo): string {
  if (model.free) return 'free'
  if (model.inputCost === undefined) return ''
  return `$${model.inputCost}/$${model.outputCost}`
}

function pad(text: string, width: number): string {
  const chars = Array.from(text)
  if (chars.length > width) return `${chars.slice(0, width - 1).join('')}…`
  return text + ' '.repeat(width - chars.length)
}

function modelRow(provider: string, model: ModelInfo, icon: string, active: string): PickerRow {
  const ref = `${provider}:${model.id}`
  const label = `${pad(model.label, 32)} ${pad(providerLabel(provider), 18)} ${pad(window(model.contextWindow), 6)} ${pad(price(model), 13)}${model.supportsThinking ? ' reasoning' : ''}`
  return {
    id: ref,
    kind: 'model',
    label,
    icon: ref === active ? '→' : icon,
    secondary: `${ref} ${model.label} ${providerLabel(provider)} ${model.free ? 'free' : ''}`.toLowerCase(),
    hideSecondary: true,
    accent: ref === active,
    provider,
  }
}

/** A ref as a row, whether or not the catalog knows the model. */
function refRow(ref: string, icon: string, active: string): PickerRow | undefined {
  const split = splitModelRef(ref)
  if (!split.provider) return undefined
  const found = findModel(split.modelId, split.provider)
  // A model its provider keeps for another client: not worth offering again.
  if (reservedModel(split.provider, found ?? { id: split.modelId })) return undefined
  const known: ModelInfo = found ?? {
    id: split.modelId,
    provider: split.provider,
    label: split.modelId,
    contextWindow: 0,
    maxOutput: 0,
    supportsTools: true,
    supportsVision: false,
    supportsThinking: false,
  }
  return modelRow(split.provider, { ...known, id: split.modelId }, icon, active)
}

function allowed(provider: string, model: ModelInfo, providers: Record<string, ProviderConfig>): boolean {
  const whitelist = providers[provider]?.whitelist
  if (whitelist?.length && !whitelist.includes(model.id)) return false
  if (providers[provider]?.blacklist?.includes(model.id)) return false
  return model.status !== 'deprecated'
}

/**
 * The models to choose from: the one in use (→), favorites (★), the
 * recently picked (◷), then
 * every model of every provider that has a key — newest first within each
 * — then a way to connect another provider. A model appears once.
 *
 * `only` narrows it to one provider, as after connecting it.
 */
export function modelRows(providers: Record<string, ProviderConfig>, active: string, only?: string): PickerRow[] {
  const rows: PickerRow[] = []
  const seen = new Set<string>()
  const add = (row: PickerRow | undefined) => {
    if (!row || seen.has(row.id)) return
    seen.add(row.id)
    rows.push(row)
  }

  if (!only) {
    // The model in use first, so the picker opens on where things stand.
    if (active) add(refRow(active, '→', active))
    for (const ref of favoriteModels()) add(refRow(ref, '★', active))
    for (const ref of recentModels()) add(refRow(ref, '◷', active))
  }

  let sources: ProviderEntry[] = listProviders(providers).filter((entry) =>
    only ? entry.id === only : entry.api !== undefined && !entry.local && hasCredentials(entry.id, providers),
  )
  // Nothing connected: OpenRouter's list shows what one key reaches.
  if (sources.length === 0 && !only) sources = listProviders(providers).filter((entry) => entry.id === 'openrouter')

  for (const entry of sources) {
    const models = modelsOf(entry.id)
      .filter((model) => allowed(entry.id, model, providers))
      .sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '') || a.label.localeCompare(b.label))
    for (const model of models) add(modelRow(entry.id, model, ' ', active))
    for (const [id, custom] of Object.entries(providers[entry.id]?.models ?? {})) {
      add(
        modelRow(
          entry.id,
          {
            id,
            provider: entry.id,
            label: custom.name ?? id,
            contextWindow: custom.context ?? 128_000,
            maxOutput: custom.output ?? 8192,
            supportsTools: true,
            supportsVision: false,
            supportsThinking: false,
          },
          ' ',
          active,
        ),
      )
    }
  }

  rows.push({
    id: 'connect',
    kind: 'action',
    label: 'Connect a provider…  (OpenCode Zen, Anthropic, OpenAI, Google, 200+ more)',
    icon: '+',
    secondary: 'connect provider add key login',
    hideSecondary: true,
  })
  return rows
}

/** Every provider, the connected ones marked; the ones Jean cannot speak last. */
export function providerRows(providers: Record<string, ProviderConfig>): PickerRow[] {
  const entries = listProviders(providers)
  const usable = entries.filter((entry) => entry.api !== undefined)
  const unusable = entries.filter((entry) => entry.api === undefined)
  return [...usable, ...unusable].map((entry): PickerRow => {
    const ready = hasCredentials(entry.id, providers)
    const icon = entry.api === undefined ? '×' : entry.local ? '◇' : ready ? '●' : '○'
    const status = entry.api === undefined ? 'own sign-in' : entry.local ? 'local' : ready ? 'connected' : entry.keyEnv[0] ?? ''
    return {
      id: entry.id,
      kind: 'provider',
      label: `${pad(entry.label, 30)} ${pad(entry.id, 22)} ${pad(entry.models ? `${entry.models} models` : '', 11)} ${status}`,
      icon,
      secondary: `${entry.id} ${entry.label} ${entry.builtin ? 'builtin' : ''}`.toLowerCase(),
      hideSecondary: true,
      accent: ready && !entry.local,
      provider: entry.id,
    }
  })
}

/** Every word of the query appears somewhere in the row. */
export function matchesQuery(row: PickerRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return words.every((word) => row.secondary.includes(word) || row.label.toLowerCase().includes(word))
}
