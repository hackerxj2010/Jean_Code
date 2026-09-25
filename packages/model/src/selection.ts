import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultConfig, jeanHome, splitModelRef, type JeanConfig, type ModelRole } from '@jean/config'
import { findModel, modelsOf, reservedModel } from './catalog.ts'
import { connectedProviders, hasCredentials, providerLabel } from './providers/index.ts'
import type { ModelInfo } from './types.ts'

/**
 * Which model a session starts on, and the models chosen before.
 *
 * The order OpenCode uses, which is the one people expect: the `--model`
 * flag, then the config, then the model last picked, then the first
 * provider that has a key. The last two only apply when neither flag nor
 * config named a model — so a fresh install with only an OpenCode Zen key,
 * or only an Anthropic one, starts on that provider instead of failing on
 * the OpenRouter default it has no key for.
 */

interface ModelState {
  recent: string[]
  favorites: string[]
  updatedAt?: string
}

const MAX_RECENT = 10

function statePath(): string {
  return process.env.JEAN_MODEL_STATE ?? join(jeanHome(), 'state', 'models.json')
}

function readState(): ModelState {
  const path = statePath()
  if (!existsSync(path)) return { recent: [], favorites: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ModelState>
    return {
      recent: Array.isArray(parsed.recent) ? parsed.recent.filter((ref) => typeof ref === 'string') : [],
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites.filter((ref) => typeof ref === 'string') : [],
    }
  } catch {
    return { recent: [], favorites: [] }
  }
}

function writeState(state: ModelState): void {
  const path = statePath()
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`)
  renameSync(temporary, path)
}

/** Models picked before, most recent first, as `provider:model`. */
export function recentModels(): string[] {
  return readState().recent
}

export function favoriteModels(): string[] {
  return readState().favorites
}

/** Records a model as just picked. */
export function rememberModel(ref: string): void {
  const state = readState()
  state.recent = [ref, ...state.recent.filter((entry) => entry !== ref)].slice(0, MAX_RECENT)
  writeState(state)
}

/** Adds or removes a favorite; returns whether it is one now. */
export function toggleFavorite(ref: string): boolean {
  const state = readState()
  const has = state.favorites.includes(ref)
  state.favorites = has ? state.favorites.filter((entry) => entry !== ref) : [ref, ...state.favorites]
  writeState(state)
  return !has
}

/** A model reference as the config writes it: `provider:model`. */
export function modelRef(provider: string, model: string): string {
  return `${provider}:${model}`
}

export type ModelTier = 'small' | 'standard' | 'large'

/** What each tier is best served by, most wanted first, across providers. */
const PREFERRED: Record<ModelTier, string[]> = {
  standard: ['claude-sonnet-5', 'gpt-5.5', 'gemini-3.8-flash', 'kimi-k3', 'glm-5.3', 'deepseek-v4-pro', 'grok-4.7', 'qwen3.8-max', 'minimax-m3'],
  small: ['claude-haiku-4.5', 'gpt-5.4-nano', 'gpt-5.6-luna', 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'deepseek-v4-flash', 'glm-5.3-flash', 'qwen3.8-flash'],
  large: ['claude-opus-5.5', 'claude-fable-5.1', 'gpt-5.6-sol', 'gpt-5.5', 'gemini-3.1-pro', 'kimi-k3', 'deepseek-v4-pro', 'grok-4.7'],
}

/** `anthropic/claude-opus-5.5` and `claude-opus-5-5` compare equal. */
function normalize(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1).toLowerCase().replace(/\./g, '-')
}

/**
 * The model to use on a provider for a tier: the first of the preferred
 * ones it serves, else its newest model that can use tools.
 */
export function recommendedModel(provider: string, tier: ModelTier = 'standard'): ModelInfo | undefined {
  const models = modelsOf(provider).filter((model) => model.supportsTools && model.status !== 'deprecated')
  if (models.length === 0) return undefined
  const byName = new Map(models.map((model) => [normalize(model.id), model]))
  for (const wanted of PREFERRED[tier]) {
    const hit = byName.get(normalize(wanted))
    if (hit) return hit
  }
  const paid = models.filter((model) => !model.free)
  const pool = paid.length > 0 ? paid : models
  return [...pool].sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))[0]
}

/** Roles served by a small model, and those by the largest. */
const SMALL_ROLES: ModelRole[] = ['smol', 'commit', 'task', 'tiny']
const LARGE_ROLES: ModelRole[] = ['slow', 'advisor']

export interface ModelChoice {
  config: JeanConfig
  /** Why the model is not the configured default; shown once at startup. */
  note?: string
}

/**
 * The config with a model the session can actually use.
 *
 * Leaves it alone when a model was chosen (flag, config, env) or when the
 * default provider has a key. Otherwise: the last model picked whose
 * provider has a key, then the recommended model of the first connected
 * provider — with the roles still on their defaults moved along with it.
 */
export function chooseModel(config: JeanConfig, modelChosen: boolean, defaults: JeanConfig = defaultConfig()): ModelChoice {
  if (modelChosen || hasCredentials(config.model.provider, config.providers)) return { config }

  for (const ref of recentModels()) {
    const split = splitModelRef(ref)
    if (split.provider && reservedModel(split.provider, findModel(split.modelId, split.provider) ?? { id: split.modelId })) continue
    if (split.provider && hasCredentials(split.provider, config.providers)) {
      return { config: repoint(config, defaults, split.provider, () => split.modelId), note: `Using ${ref}, the model picked last.` }
    }
  }

  for (const provider of connectedProviders(config.providers)) {
    const standard = recommendedModel(provider.id, 'standard')
    if (!standard) continue
    const pick = (tier: ModelTier) => recommendedModel(provider.id, tier)?.id ?? standard.id
    return {
      config: repoint(config, defaults, provider.id, pick),
      note: `No ${providerLabel(config.model.provider)} key; using ${providerLabel(provider.id)} (${standard.id}).`,
    }
  }
  return { config }
}

function repoint(config: JeanConfig, defaults: JeanConfig, provider: string, pick: (tier: ModelTier) => string): JeanConfig {
  const previous = config.model.modelId
  const agents = { ...config.agents }
  for (const [role, agent] of Object.entries(agents) as [ModelRole, JeanConfig['agents'][ModelRole]][]) {
    if (!agent) continue
    const original = defaults.agents[role]?.model ?? defaults.model.modelId
    // Only a role still on its default follows; one set by hand stays.
    if (agent.model !== undefined && agent.model !== original && agent.model !== previous) continue
    const tier: ModelTier = SMALL_ROLES.includes(role) ? 'small' : LARGE_ROLES.includes(role) ? 'large' : 'standard'
    agents[role] = { ...agent, model: modelRef(provider, pick(tier)) }
  }
  return {
    ...config,
    model: { provider, modelId: pick('standard') },
    agents: agents as JeanConfig['agents'],
  }
}
