import { savedKey, type ProviderConfig } from '@jean/config'
import { findModel } from '../catalog.ts'
import { apiOfPackage, catalogIdOf, KNOWN_BASE_URLS, liveCatalog } from '../models-dev.ts'
import { AnthropicProvider } from './anthropic.ts'
import { GoogleProvider } from './google.ts'
import { OpenAICompatibleProvider } from './openai-compatible.ts'
import { OpenAIResponsesProvider } from './openai-responses.ts'
import type { CompletionRequest, CompletionResponse, ModelApi, Provider, ProviderOptions, StreamEvent } from '../types.ts'

/**
 * Provider registry.
 *
 * Three sources, in order of precedence:
 *
 * 1. The built-in providers below — preconfigured, known to work, and
 *    available offline. OpenCode Zen is one of them.
 * 2. Every provider in the models.dev catalog (`models-dev.ts`) whose wire
 *    format Jean speaks: 200 and more, most over Chat Completions.
 * 3. A provider of your own in the config: `providers.<id>.baseUrl`, with
 *    `api` naming its format when it is not Chat Completions.
 *
 * A provider that serves models in several formats — OpenCode Zen speaks
 * Anthropic's for Claude, OpenAI's Responses for GPT, Google's for Gemini,
 * and Chat Completions for the rest — is a [`RoutedProvider`], which picks
 * the adapter per model from what the catalog says about it.
 */

export interface ProviderDescriptor {
  name: string
  label: string
  baseUrl: string
  keyEnv: string[]
  extraHeaders?: Record<string, string>
  supportsTemperature?: boolean
  effortField?: 'reasoning_effort' | 'reasoning'
  /** Local runtimes need no key and are always considered available. */
  local?: boolean
  /** Forward cache breakpoints for Anthropic models (see the adapter). */
  cacheBreakpoints?: boolean
  /** Serves models in more than one wire format; routed per model. */
  routed?: boolean
  /** Where its keys are made. */
  doc?: string
}

export const OPENAI_COMPATIBLE: ProviderDescriptor[] = [
  {
    name: 'opencode',
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    keyEnv: ['OPENCODE_API_KEY'],
    routed: true,
    cacheBreakpoints: true,
    doc: 'https://opencode.ai/auth',
  },
  {
    name: 'opencode-go',
    label: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    keyEnv: ['OPENCODE_API_KEY'],
    routed: true,
    doc: 'https://opencode.ai/auth',
  },
  {
    name: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: ['OPENROUTER_API_KEY'],
    // OpenRouter uses these for the public app leaderboard; they are not
    // telemetry and carry nothing about the user or their code.
    extraHeaders: {
      'http-referer': 'https://jean-code.ai',
      'x-title': 'Jean Code',
    },
    effortField: 'reasoning_effort',
    cacheBreakpoints: true,
    doc: 'https://openrouter.ai/keys',
  },
  {
    name: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: ['OPENAI_API_KEY'],
    effortField: 'reasoning_effort',
    doc: 'https://platform.openai.com/api-keys',
  },
  {
    name: 'xai',
    label: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    keyEnv: ['XAI_API_KEY'],
    doc: 'https://console.x.ai',
  },
  {
    name: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyEnv: ['DEEPSEEK_API_KEY'],
    doc: 'https://platform.deepseek.com/api_keys',
  },
  {
    name: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyEnv: ['MISTRAL_API_KEY'],
    doc: 'https://console.mistral.ai/api-keys',
  },
  {
    name: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: ['GROQ_API_KEY'],
    doc: 'https://console.groq.com/keys',
  },
  {
    name: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyEnv: ['CEREBRAS_API_KEY'],
  },
  {
    name: 'fireworks',
    label: 'Fireworks',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    keyEnv: ['FIREWORKS_API_KEY'],
  },
  {
    name: 'together',
    label: 'Together',
    baseUrl: 'https://api.together.xyz/v1',
    keyEnv: ['TOGETHER_API_KEY'],
  },
  {
    name: 'nebius',
    label: 'Nebius',
    baseUrl: 'https://api.tokenfactory.nebius.com/v1',
    keyEnv: ['NEBIUS_API_KEY'],
  },
  {
    name: 'siliconflow',
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.com/v1',
    keyEnv: ['SILICONFLOW_API_KEY'],
  },
  {
    name: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    keyEnv: [],
    local: true,
  },
  {
    name: 'lmstudio',
    label: 'LM Studio (local)',
    baseUrl: 'http://127.0.0.1:1234/v1',
    keyEnv: [],
    local: true,
  },
  {
    name: 'vllm',
    label: 'vLLM (local)',
    baseUrl: 'http://localhost:8000/v1',
    keyEnv: [],
    local: true,
  },
  {
    name: 'llamacpp',
    label: 'llama.cpp (local)',
    baseUrl: 'http://localhost:8080/v1',
    keyEnv: [],
    local: true,
  },
]

const ANTHROPIC_ENV = ['ANTHROPIC_API_KEY']
const GOOGLE_ENV = ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']

/** The built-in providers, by name — what `providerNames()` has always listed. */
export function providerNames(): string[] {
  return ['anthropic', 'google', ...OPENAI_COMPATIBLE.map((p) => p.name)]
}

function builtin(name: string): ProviderDescriptor | undefined {
  return OPENAI_COMPATIBLE.find((p) => p.name === name)
}

/** A provider as the pickers and `jean providers` show it. */
export interface ProviderEntry {
  id: string
  label: string
  /** Env vars that hold its key. Empty for a local runtime. */
  keyEnv: string[]
  baseUrl?: string
  /** Its default wire format; `undefined` when Jean cannot speak to it. */
  api?: ModelApi
  local: boolean
  /** Preconfigured in Jean, not only listed by the catalog. */
  builtin: boolean
  /** Defined in the config by the user. */
  custom: boolean
  /** Where its keys are made, or its documentation. */
  doc?: string
  /** Models the catalog lists for it. */
  models: number
}

/**
 * Every provider Jean can reach: built-in ones first, in the order they are
 * most often wanted, then the catalog's, then the config's own.
 */
export function listProviders(providers: Record<string, ProviderConfig> = {}): ProviderEntry[] {
  const catalog = liveCatalog()?.providers ?? {}
  const entries: ProviderEntry[] = []
  const seen = new Set<string>()
  const count = (name: string) => Object.keys(catalog[catalogIdOf(name)]?.models ?? {}).length

  const push = (entry: ProviderEntry) => {
    if (seen.has(entry.id)) return
    seen.add(entry.id)
    // The catalog's name for a built-in catalog id, so `togetherai` is not
    // listed a second time next to `together`.
    seen.add(catalogIdOf(entry.id))
    entries.push(entry)
  }

  push({ id: 'anthropic', label: 'Anthropic', keyEnv: ANTHROPIC_ENV, baseUrl: KNOWN_BASE_URLS.anthropic, api: 'anthropic', local: false, builtin: true, custom: false, doc: 'https://console.anthropic.com/settings/keys', models: count('anthropic') })
  push({ id: 'google', label: 'Google Gemini', keyEnv: GOOGLE_ENV, baseUrl: KNOWN_BASE_URLS.google, api: 'google', local: false, builtin: true, custom: false, doc: 'https://aistudio.google.com/apikey', models: count('google') })
  for (const descriptor of OPENAI_COMPATIBLE) {
    push({
      id: descriptor.name,
      label: descriptor.label,
      keyEnv: descriptor.keyEnv,
      baseUrl: descriptor.baseUrl,
      api: 'chat',
      local: descriptor.local === true,
      builtin: true,
      custom: false,
      doc: descriptor.doc,
      models: count(descriptor.name),
    })
  }
  // Built-in ones first in the order above, with OpenCode Zen leading.
  const order = ['opencode', 'anthropic', 'openai', 'google', 'openrouter']
  entries.sort((a, b) => rank(order, a.id) - rank(order, b.id))

  const fromCatalog = Object.values(catalog)
    .filter((provider) => !seen.has(provider.id))
    .map((provider): ProviderEntry => {
      const api = apiOfPackage(provider.npm)
      const baseUrl = provider.api ?? KNOWN_BASE_URLS[provider.id]
      return {
        id: provider.id,
        label: provider.name,
        keyEnv: provider.env,
        baseUrl,
        api: baseUrl ? api : undefined,
        local: /^https?:\/\/(localhost|127\.0\.0\.1)/.test(baseUrl ?? ''),
        builtin: false,
        custom: false,
        doc: provider.doc,
        models: Object.keys(provider.models).length,
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
  for (const entry of fromCatalog) push(entry)

  for (const [id, config] of Object.entries(providers)) {
    if (seen.has(id) || !config.baseUrl) continue
    push({
      id,
      label: config.name ?? id,
      keyEnv: config.keyEnv ?? [],
      baseUrl: config.baseUrl,
      api: config.api ?? 'chat',
      // A proxy on this machine may still want a key (LiteLLM's master
      // key): only one that names no key variable is taken as keyless.
      local: /^https?:\/\/(localhost|127\.0\.0\.1)/.test(config.baseUrl) && !config.keyEnv?.length,
      builtin: false,
      custom: true,
      models: Object.keys(config.models ?? {}).length,
    })
  }
  return entries
}

function rank(order: string[], id: string): number {
  const index = order.indexOf(id)
  return index === -1 ? order.length : index
}

/** One provider's entry, or `undefined` when Jean knows no such provider. */
export function providerEntry(name: string, providers: Record<string, ProviderConfig> = {}): ProviderEntry | undefined {
  return listProviders(providers).find((entry) => entry.id === name)
}

/** Human-readable label for a provider name. */
export function providerLabel(name: string): string {
  if (name === 'anthropic') return 'Anthropic'
  if (name === 'google') return 'Google Gemini'
  return builtin(name)?.label ?? liveCatalog()?.providers[name]?.name ?? name
}

/** The env vars a provider's key is read from. */
export function providerEnv(name: string, providers: Record<string, ProviderConfig> = {}): string[] {
  if (name === 'anthropic') return ANTHROPIC_ENV
  if (name === 'google') return GOOGLE_ENV
  return builtin(name)?.keyEnv ?? providers[name]?.keyEnv ?? liveCatalog()?.providers[name]?.env ?? []
}

/**
 * Whether a provider can be used as things stand: a local runtime, a key in
 * the config, a saved key, or one of its env vars set.
 */
export function hasCredentials(name: string, providers: Record<string, ProviderConfig> = {}): boolean {
  const entry = providerEntry(name, providers)
  if (entry?.local) return true
  if (providers[name]?.apiKey?.trim()) return true
  if (savedKey(name)) return true
  const env = providerEnv(name, providers)
  if (env.length === 0 && entry?.custom) return true
  return env.some((variable) => Boolean(process.env[variable]?.trim()))
}

/** The providers that have credentials, in `listProviders` order. */
export function connectedProviders(providers: Record<string, ProviderConfig> = {}): ProviderEntry[] {
  return listProviders(providers).filter((entry) => !entry.local && entry.api !== undefined && hasCredentials(entry.id, providers))
}

export interface CreateOptions extends ProviderOptions {
  /** The wire format, overriding the provider's own. */
  api?: ModelApi
}

/**
 * Builds a provider adapter.
 *
 * `options.baseUrl` overrides the descriptor's default, which is how a
 * self-hosted gateway or a corporate proxy is pointed at; with an unknown
 * name, a base URL makes it a provider of your own.
 */
export function createProvider(name: string, options: CreateOptions = {}): Provider {
  if (name === 'anthropic' && (!options.api || options.api === 'anthropic')) return new AnthropicProvider(options)
  if (name === 'google' && (!options.api || options.api === 'google')) return new GoogleProvider(options)

  const descriptor = builtin(name)
  if (descriptor) {
    const common: AdapterOptions = {
      ...options,
      name: descriptor.name,
      label: descriptor.label,
      baseUrl: options.baseUrl ?? descriptor.baseUrl,
      keyEnv: descriptor.keyEnv,
      extraHeaders: descriptor.extraHeaders,
      supportsTemperature: descriptor.supportsTemperature,
      effortField: descriptor.effortField,
      cacheBreakpoints: descriptor.cacheBreakpoints,
    }
    if (descriptor.routed) return new RoutedProvider(common, options.api ?? 'chat')
    return adapter(options.api ?? 'chat', common)
  }

  const listed = liveCatalog()?.providers[name]
  if (listed) {
    const api = options.api ?? apiOfPackage(listed.npm)
    const baseUrl = options.baseUrl ?? listed.api ?? KNOWN_BASE_URLS[name]
    if (!api || !baseUrl) {
      throw new Error(
        `${listed.name} (${name}) needs its own sign-in (${listed.npm ?? 'a custom SDK'}), which Jean does not speak. ` +
          `Point \`providers.${name}.baseUrl\` at an OpenAI-compatible endpoint for it, or pick another provider.`,
      )
    }
    return new RoutedProvider(
      { ...options, name, label: listed.name, baseUrl, keyEnv: options.keyEnv ?? listed.env },
      api,
    )
  }

  if (options.baseUrl) {
    return adapter(options.api ?? 'chat', {
      ...options,
      name,
      label: options.label ?? name,
      baseUrl: options.baseUrl,
      keyEnv: options.keyEnv ?? [],
    })
  }

  throw new Error(
    `unknown provider "${name}" — see \`jean providers\` for the ones Jean knows, ` +
      `or give it a \`providers.${name}.baseUrl\` to add your own`,
  )
}

interface AdapterOptions extends ProviderOptions {
  name: string
  label: string
  baseUrl: string
  keyEnv: string[]
  extraHeaders?: Record<string, string>
  supportsTemperature?: boolean
  effortField?: 'reasoning_effort' | 'reasoning'
  cacheBreakpoints?: boolean
}

function adapter(api: ModelApi, options: AdapterOptions): Provider {
  switch (api) {
    case 'anthropic':
      return new AnthropicProvider(options)
    case 'google':
      return new GoogleProvider(options)
    case 'responses':
      return new OpenAIResponsesProvider(options)
    case 'chat':
      return new OpenAICompatibleProvider(options)
  }
}

/**
 * The wire format a routed provider's model is served in when the catalog
 * has not been fetched yet — how OpenCode Zen splits its models.
 */
export function guessApi(model: string): ModelApi | undefined {
  const id = model.toLowerCase()
  if (id.startsWith('claude-') || /^qwen[\d.]*-flash/.test(id)) return 'anthropic'
  if (id.startsWith('gpt-') || id.startsWith('grok-') || id.startsWith('muse-spark')) return 'responses'
  if (id.startsWith('gemini-')) return 'google'
  return undefined
}

/**
 * A provider whose models are not all spoken to the same way. Each request
 * goes to the adapter for its model's format, all sharing one name, one
 * base URL, and one key.
 */
export class RoutedProvider implements Provider {
  readonly name: string
  readonly label: string
  private readonly adapters = new Map<ModelApi, Provider>()

  constructor(
    private readonly options: AdapterOptions,
    private readonly fallback: ModelApi,
  ) {
    this.name = options.name
    this.label = options.label
  }

  /** The format `model` is served in. */
  apiFor(model: string): ModelApi {
    const known = findModel(model, this.name)
    if (known && known.provider === catalogIdOf(this.name)) return known.api ?? this.fallback
    return (this.fallback === 'chat' ? guessApi(model) : undefined) ?? this.fallback
  }

  private adapterFor(model: string): Provider {
    const api = this.apiFor(model)
    let existing = this.adapters.get(api)
    if (!existing) {
      existing = adapter(api, this.options)
      this.adapters.set(api, existing)
    }
    return existing
  }

  isConfigured(): boolean {
    return this.adapterFor('').isConfigured()
  }

  complete(model: string, request: CompletionRequest): Promise<CompletionResponse> {
    return this.adapterFor(model).complete(model, request)
  }

  stream(model: string, request: CompletionRequest): AsyncGenerator<StreamEvent, void, void> {
    return this.adapterFor(model).stream(model, request)
  }
}

export { catalogIdOf }
export { AnthropicProvider, GoogleProvider, OpenAICompatibleProvider, OpenAIResponsesProvider }
export type { OpenAICompatibleConfig } from './openai-compatible.ts'
