import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { jeanHome } from '@jean/config'
import type { ModelApi, ModelInfo } from './types.ts'

/**
 * The live model catalog, from models.dev.
 *
 * models.dev is the open catalog OpenCode and others read: every provider
 * (220 and counting), every model it serves, with context windows, prices,
 * and what each can do. Jean reads the same file, so a model released this
 * morning is choosable this afternoon without a new version of Jean.
 *
 * It is fetched once a day in the background and kept, compacted, in
 * `~/.jean/cache/models.json`. Nothing waits on the network: a missing or
 * stale cache is used as it is (or the bundled catalog in `catalog.ts`)
 * while the refresh runs. `JEAN_CATALOG=off` keeps to the bundled one, and
 * `JEAN_MODELS_URL` points at a mirror.
 */

export const MODELS_URL = 'https://models.dev/api.json'
const CACHE_VERSION = 1
const MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface CatalogProvider {
  id: string
  name: string
  /** Env vars that hold the key, in the order they are tried. */
  env: string[]
  /** Base URL, when the provider publishes one. */
  api?: string
  /** The AI SDK package OpenCode drives it with — how it is spoken to. */
  npm?: string
  doc?: string
  models: Record<string, ModelInfo>
}

export interface Catalog {
  version: number
  fetchedAt: number
  source: string
  providers: Record<string, CatalogProvider>
}

interface RawModel {
  id?: string
  name?: string
  attachment?: boolean
  reasoning?: boolean
  reasoning_options?: { type?: string; values?: string[] }[]
  tool_call?: boolean
  release_date?: string
  status?: string
  modalities?: { input?: string[] }
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  provider?: { npm?: string }
}

interface RawProvider {
  id?: string
  name?: string
  env?: string[]
  api?: string
  npm?: string
  doc?: string
  models?: Record<string, RawModel>
}

/**
 * The wire format an AI SDK package speaks. `undefined` for the packages
 * with their own authentication — Bedrock's request signing, Vertex's
 * service accounts, Azure's deployments — which Jean does not speak.
 */
export function apiOfPackage(npm: string | undefined): ModelApi | undefined {
  if (!npm) return 'chat'
  if (npm === '@ai-sdk/anthropic') return 'anthropic'
  if (npm === '@ai-sdk/google') return 'google'
  if (npm === '@ai-sdk/openai') return 'responses'
  if (UNSPOKEN.some((prefix) => npm.startsWith(prefix))) return undefined
  // Every other package is a thin layer over Chat Completions.
  return 'chat'
}

const UNSPOKEN = [
  '@ai-sdk/amazon-bedrock',
  '@ai-sdk/azure',
  '@ai-sdk/google-vertex',
  'gitlab-ai-provider',
  '@jerome-benoit/sap-ai-provider',
  'watsonx-ai-provider',
  'ai-gateway-provider',
]

/**
 * Base URLs of the providers whose package knows its own address, so
 * models.dev gives none. The rest publish theirs.
 */
export const KNOWN_BASE_URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  groq: 'https://api.groq.com/openai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  xai: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  togetherai: 'https://api.together.xyz/v1',
  perplexity: 'https://api.perplexity.ai',
  cohere: 'https://api.cohere.ai/compatibility/v1',
  venice: 'https://api.venice.ai/api/v1',
  aihubmix: 'https://aihubmix.com/v1',
  vercel: 'https://ai-gateway.vercel.sh/v1',
  v0: 'https://api.v0.dev/v1',
}

/** Jean's names for providers the catalog calls otherwise. */
const CATALOG_IDS: Record<string, string> = {
  together: 'togetherai',
  fireworks: 'fireworks-ai',
}

/** The models.dev id for one of Jean's provider names. */
export function catalogIdOf(name: string): string {
  return CATALOG_IDS[name] ?? name
}

/** models.dev's JSON, compacted to what Jean reads. */
export function catalogFromModelsDev(raw: unknown, source = MODELS_URL, fetchedAt = Date.now()): Catalog {
  const providers: Record<string, CatalogProvider> = {}
  if (!raw || typeof raw !== 'object') return { version: CACHE_VERSION, fetchedAt, source, providers }

  for (const [key, value] of Object.entries(raw as Record<string, RawProvider>)) {
    if (!value || typeof value !== 'object') continue
    const id = value.id ?? key
    const models: Record<string, ModelInfo> = {}
    const providerApi = apiOfPackage(value.npm)
    for (const [modelKey, model] of Object.entries(value.models ?? {})) {
      if (!model || typeof model !== 'object') continue
      const info = modelFromRaw(id, model.id ?? modelKey, model, providerApi)
      if (info) models[info.id] = info
    }
    providers[id] = {
      id,
      name: value.name ?? id,
      env: Array.isArray(value.env) ? value.env.filter((name) => typeof name === 'string') : [],
      api: typeof value.api === 'string' ? value.api : undefined,
      npm: value.npm,
      doc: value.doc,
      models,
    }
  }
  return { version: CACHE_VERSION, fetchedAt, source, providers }
}

function modelFromRaw(provider: string, id: string, raw: RawModel, providerApi: ModelApi | undefined): ModelInfo | undefined {
  const context = raw.limit?.context
  if (!context || context <= 0) return undefined
  const input = raw.modalities?.input ?? []
  const effort = raw.reasoning_options?.find((option) => option.type === 'effort')?.values
  const api = raw.provider?.npm ? apiOfPackage(raw.provider.npm) : undefined
  const info: ModelInfo = {
    id,
    provider,
    label: raw.name ?? id,
    contextWindow: context,
    maxOutput: raw.limit?.output && raw.limit.output > 0 ? raw.limit.output : Math.min(32_000, context),
    inputCost: raw.cost?.input,
    outputCost: raw.cost?.output,
    cacheReadCost: raw.cost?.cache_read,
    cacheWriteCost: raw.cost?.cache_write,
    supportsTools: raw.tool_call !== false,
    supportsVision: raw.attachment === true || input.includes('image'),
    supportsThinking: raw.reasoning === true,
  }
  if (raw.cost && (raw.cost.input ?? 0) === 0 && (raw.cost.output ?? 0) === 0) info.free = true
  if (effort?.length) info.reasoningLevels = effort
  if (raw.status) info.status = raw.status
  if (raw.release_date) info.releaseDate = raw.release_date
  if (api && api !== providerApi) info.api = api
  return info
}

export function catalogPath(): string {
  return join(jeanHome(), 'cache', 'models.json')
}

let loaded: Catalog | undefined
let tried = false

function disabled(): boolean {
  return process.env.JEAN_CATALOG === 'off' || process.env.JEAN_CATALOG === 'bundled'
}

/**
 * The live catalog, read from the cache the first time it is asked for.
 * `undefined` when there is none yet, or it is turned off.
 *
 * Under `bun test` the cache in the real home is not read, so a test sees
 * the bundled catalog unless it installs one with [`setCatalog`].
 */
export function liveCatalog(): Catalog | undefined {
  if (disabled()) return undefined
  if (tried) return loaded
  tried = true
  if (process.env.NODE_ENV === 'test' && !process.env.JEAN_CATALOG_FILE) return undefined
  const path = process.env.JEAN_CATALOG_FILE ?? catalogPath()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Catalog
    if (parsed?.version === CACHE_VERSION && parsed.providers) loaded = parsed
  } catch {
    loaded = undefined
  }
  return loaded
}

/** Installs a catalog for this process — after a refresh, or in a test. */
export function setCatalog(catalog: Catalog | undefined): void {
  loaded = catalog
  tried = true
}

/** How old the cached catalog is, in milliseconds, or `undefined` without one. */
export function catalogAge(): number | undefined {
  const catalog = liveCatalog()
  return catalog ? Date.now() - catalog.fetchedAt : undefined
}

/**
 * Fetches the catalog now, caches it, and installs it.
 *
 * Throws when the fetch fails; the cache already on disk is left alone.
 */
export async function refreshCatalog(options: { url?: string; timeoutMs?: number } = {}): Promise<Catalog> {
  const url = options.url ?? process.env.JEAN_MODELS_URL ?? MODELS_URL
  const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 20_000) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const catalog = catalogFromModelsDev(await response.json(), url)
  if (Object.keys(catalog.providers).length === 0) throw new Error(`${url}: no providers in the catalog`)

  const path = process.env.JEAN_CATALOG_FILE ?? catalogPath()
  mkdirSync(dirname(path), { recursive: true })
  // Written aside and renamed, so a reader never sees half a file.
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(catalog))
  renameSync(temporary, path)
  setCatalog(catalog)
  return catalog
}

let refreshing: Promise<unknown> | undefined

/**
 * Refreshes the catalog in the background when it is missing or a day old.
 * Never throws, never delays the caller; off under tests, offline
 * (`JEAN_OFFLINE`), and with `JEAN_CATALOG=off`.
 */
export function refreshCatalogInBackground(): void {
  if (refreshing || disabled() || process.env.JEAN_OFFLINE) return
  if (process.env.NODE_ENV === 'test' && !process.env.JEAN_MODELS_URL) return
  const path = process.env.JEAN_CATALOG_FILE ?? catalogPath()
  try {
    if (existsSync(path) && Date.now() - statSync(path).mtimeMs < MAX_AGE_MS) return
  } catch {
    // Unreadable: refresh.
  }
  refreshing = refreshCatalog({ timeoutMs: 15_000 })
    .catch(() => undefined)
    .finally(() => {
      refreshing = undefined
    })
}
