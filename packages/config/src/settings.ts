import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { defaultConfig, globalConfigPath, jeanHome } from './defaults.ts'
import { configFromEnv, parseDotenv, providerKeyFromEnv } from './env.ts'
import { importForeignConfig } from './import/index.ts'
import { expandEnv, merge, parseJsonc, resolveRoles, splitModelRef, validate } from './parser.ts'
import type { ConfigSource, JeanConfig, LoadedConfig, PartialConfig } from './types.ts'

/**
 * Settings management: resolve the effective config from every layer, and write
 * changes back to the right file.
 *
 * Precedence, lowest to highest:
 *   defaults -> imported foreign config -> ~/.jean/config.json -> .jean.json
 *   -> environment -> command-line flags
 */

export interface LoadOptions {
  /** Project root. Defaults to `process.cwd()`. */
  cwd?: string
  /** Explicit config file, from `--config`. Replaces the global file. */
  configPath?: string
  /** Values from command-line flags — the highest-precedence layer. */
  flags?: PartialConfig
  /** Skip reading other agents' config (`--no-import`). */
  skipImport?: boolean
  env?: NodeJS.ProcessEnv
}

export function loadConfig(options: LoadOptions = {}): LoadedConfig {
  const cwd = options.cwd ?? process.cwd()
  const warnings: string[] = []
  const sources: ConfigSource[] = [{ path: '<defaults>', kind: 'defaults' }]

  // `.env` in the project root is read but never allowed to shadow a variable
  // the user actually exported — an exported key is the more deliberate signal.
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) }
  const dotenvPath = join(cwd, '.env')
  if (existsSync(dotenvPath)) {
    try {
      for (const [k, v] of Object.entries(parseDotenv(readFileSync(dotenvPath, 'utf8')))) {
        if (env[k] === undefined) env[k] = v
      }
    } catch (err) {
      warnings.push(`could not read ${dotenvPath}: ${errMessage(err)}`)
    }
  }

  let config = defaultConfig()
  const extraInstructions: string[] = []

  if (!options.skipImport) {
    const imported = importForeignConfig(cwd)
    if (imported.sources.length > 0) {
      config = merge(config, imported.config)
      extraInstructions.push(...imported.instructionFiles)
      sources.push({ path: imported.sources.join(', '), kind: 'imported' })
    }
  }

  const explicitConfig = options.configPath !== undefined
  const globalPath = explicitConfig
    ? resolve(cwd, options.configPath!)
    : globalConfigPath(env)
  const globalLayer = readConfigFile(globalPath)
  if (globalLayer) {
    config = merge(config, globalLayer.value)
    warnings.push(...globalLayer.warnings)
    sources.push({ path: globalPath, kind: 'global' })
  } else if (explicitConfig) {
    warnings.push(`--config ${options.configPath} does not exist`)
  }

  // An explicit `--config` is authoritative: it replaces the global file *and*
  // suppresses the project file. Otherwise the flag would be unreliable for the
  // case it exists for — pinning a configuration in a test or CI run, where a
  // stray `.jean.json` silently winning is a genuine trap.
  if (!explicitConfig) {
    const projectPath = join(cwd, '.jean.json')
    const projectLayer = readConfigFile(projectPath)
    if (projectLayer) {
      config = merge(config, projectLayer.value)
      warnings.push(...projectLayer.warnings)
      sources.push({ path: projectPath, kind: 'project' })
    }
  }

  const envLayer = configFromEnv(env)
  if (Object.keys(envLayer.config).length > 0) {
    config = merge(config, envLayer.config)
    sources.push({ path: '<environment>', kind: 'env' })
  }
  warnings.push(...envLayer.warnings)

  if (options.flags && Object.keys(options.flags).length > 0) {
    config = merge(config, options.flags)
    sources.push({ path: '<flags>', kind: 'flags' })
  }

  // `${VAR}` expansion happens after merging so a project file can reference a
  // variable a global file set up.
  const missing: string[] = []
  config = expandEnv(config, env, missing)
  for (const name of new Set(missing)) {
    warnings.push(`config references \${${name}} but it is not set — expanded to empty`)
  }

  // A `provider:model` reference in any role sets that role's provider.
  const split = splitModelRef(config.model.modelId)
  if (split.provider) {
    config.model = { ...config.model, provider: split.provider, modelId: split.modelId }
  }

  if (!config.model.apiKey) {
    const key = providerKeyFromEnv(config.model.provider, env)
    if (key) config.model = { ...config.model, apiKey: key }
  }

  config.instructionFiles = [...config.instructionFiles, ...extraInstructions]
  config.telemetry = false
  config = resolveRoles(config)

  return { config, sources, warnings }
}

function readConfigFile(path: string): { value: PartialConfig; warnings: string[] } | null {
  if (!existsSync(path)) return null
  try {
    const parsed = parseJsonc(readFileSync(path, 'utf8'), path)
    return validate(parsed, path)
  } catch (err) {
    return { value: {}, warnings: [`could not read ${path}: ${errMessage(err)}`] }
  }
}

/**
 * Writes a setting into a config file, creating it if needed.
 *
 * `key` is a dotted path (`agents.default.model`). Only the named leaf is
 * touched: everything else in the file, including comments-stripped formatting,
 * is rewritten from the parsed object, so this is a lossy-for-comments but
 * safe-for-values operation.
 */
export function setSetting(
  key: string,
  value: unknown,
  scope: 'global' | 'project' = 'global',
  cwd = process.cwd(),
): string {
  const path = scope === 'global' ? globalConfigPath() : join(cwd, '.jean.json')

  let current: Record<string, unknown> = {}
  if (existsSync(path)) {
    const parsed = parseJsonc(readFileSync(path, 'utf8'), path)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>
    }
  }

  const parts = key.split('.')
  let cursor = current
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!
    const next = cursor[part]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cursor[part] = {}
    }
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[parts[parts.length - 1]!] = value

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  return path
}

/** Reads a dotted path out of a resolved config. */
export function getSetting(config: JeanConfig, key: string): unknown {
  let cursor: unknown = config
  for (const part of key.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

/** Config keys whose values are secrets and must never be printed. */
const SECRET_KEYS = /^(apikey|api_key|token|secret|password|authorization)$/i

/**
 * Replaces secret values with a masked form, keeping enough to identify which
 * key is in use.
 *
 * Applied to everything the CLI prints. `jean config get model` is something
 * people run in a shared terminal, paste into an issue, and pipe into logs —
 * printing a live API key there is a credential leak, not a display detail.
 */
export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v)) as unknown as T
  if (value === null || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.test(key) && typeof inner === 'string' && inner) {
      out[key] = maskSecret(inner)
    } else {
      out[key] = redactSecrets(inner)
    }
  }
  return out as T
}

/** `sk-ant-a...w9q2` — enough to tell which key is in use, not enough to use it. */
export function maskSecret(secret: string): string {
  if (secret.length <= 12) return '***'
  return `${secret.slice(0, 8)}...${secret.slice(-4)}`
}

/** Ensures `~/.jean` and its subdirectories exist. Idempotent. */
export function ensureJeanHome(): string {
  const home = jeanHome()
  for (const dir of [home, join(home, 'sessions'), join(home, 'skills'), join(home, 'logs')]) {
    mkdirSync(dir, { recursive: true })
  }
  return home
}

/** Resolves a possibly-relative path against the project root. */
export function resolvePath(path: string, cwd = process.cwd()): string {
  if (path.startsWith('~')) return join(process.env.HOME ?? process.env.USERPROFILE ?? '', path.slice(1))
  return isAbsolute(path) ? path : resolve(cwd, path)
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
