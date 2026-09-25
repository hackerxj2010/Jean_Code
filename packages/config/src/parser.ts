import type {
  DeepPartial,
  Effort,
  JeanConfig,
  Mode,
  PartialConfig,
  PermissionMode,
} from './types.ts'
import { MODEL_ROLES } from './types.ts'

/**
 * Config parsing and validation.
 *
 * No schema library: the shape is small and fixed, and a hand-written validator
 * gives better messages ("`permissionMode` must be one of ...") than a generic
 * one, with no dependency and no startup cost.
 */

export interface ParseResult {
  value: PartialConfig
  warnings: string[]
}

const MODES: Mode[] = ['autonomous', 'swarm']
const PERMISSION_MODES: PermissionMode[] = ['auto', 'ask', 'plan', 'full']
const EFFORTS: Effort[] = ['fast', 'normal', 'high', 'xhigh']

/** Parses JSON with comments and trailing commas (JSONC), as editors write it. */
export function parseJsonc(text: string, path = '<config>'): unknown {
  const stripped = stripJsonComments(text)
  try {
    return JSON.parse(stripped)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`${path}: invalid JSON — ${message}`)
  }
}

/**
 * Removes `//` and block comments and trailing commas, without touching
 * anything inside string literals.
 */
export function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    const next = text[i + 1]

    if (inLine) {
      if (ch === '\n') {
        inLine = false
        out += ch
      }
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      inLine = true
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      inBlock = true
      i++
      continue
    }
    out += ch
  }

  // Trailing commas before } or ], outside strings (already handled above).
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/**
 * Validates a parsed config object, dropping unknown/invalid fields and
 * reporting them as warnings rather than failing the whole load. A typo in one
 * key should not stop the agent from starting.
 */
export function validate(raw: unknown, path = '<config>'): ParseResult {
  const warnings: string[] = []
  const out: Record<string, unknown> = {}

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { value: {}, warnings: [`${path}: expected a JSON object`] }
  }
  const obj = raw as Record<string, unknown>

  const enumField = <T extends string>(key: string, allowed: T[]): void => {
    const v = obj[key]
    if (v === undefined) return
    if (typeof v === 'string' && (allowed as string[]).includes(v)) {
      out[key] = v
    } else {
      warnings.push(
        `${path}: \`${key}\` must be one of ${allowed.map((a) => `"${a}"`).join(', ')} — ignoring ${JSON.stringify(v)}`,
      )
    }
  }

  const typedField = (key: string, type: 'string' | 'boolean' | 'number'): void => {
    const v = obj[key]
    if (v === undefined) return
    if (typeof v === type) out[key] = v
    else warnings.push(`${path}: \`${key}\` must be a ${type} — ignoring ${JSON.stringify(v)}`)
  }

  const objectField = (key: string): void => {
    const v = obj[key]
    if (v === undefined) return
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out[key] = v
    else warnings.push(`${path}: \`${key}\` must be an object — ignoring`)
  }

  const stringArrayField = (key: string): void => {
    const v = obj[key]
    if (v === undefined) return
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[key] = v
    else warnings.push(`${path}: \`${key}\` must be an array of strings — ignoring`)
  }

  enumField('mode', MODES)
  enumField('permissionMode', PERMISSION_MODES)
  enumField('effort', EFFORTS)

  if (obj.ui !== undefined) {
    const value = obj.ui
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const ui: Record<string, unknown> = {}
      const raw = value as Record<string, unknown>

      if (typeof raw.theme === 'string') {
        // The name is not checked against the bundled list here: the config
        // layer must not depend on the TUI, and an unknown name falls back to
        // the default at render time with a message naming what is available.
        ui.theme = raw.theme
      } else if (raw.theme !== undefined) {
        warnings.push(`${path}: \`ui.theme\` must be a string — ignoring`)
      }

      if (typeof raw.banner === 'boolean') ui.banner = raw.banner
      else if (raw.banner !== undefined) {
        warnings.push(`${path}: \`ui.banner\` must be a boolean — ignoring`)
      }

      if (Object.keys(ui).length > 0) out.ui = ui as PartialConfig['ui']
    } else {
      warnings.push(`${path}: \`ui\` must be an object — ignoring`)
    }
  }
  typedField('autoCompact', 'boolean')
  typedField('keepAwake', 'boolean')
  typedField('debug', 'boolean')

  if (obj.compactThreshold !== undefined) {
    const v = obj.compactThreshold
    if (typeof v === 'number' && v > 0 && v <= 1) out.compactThreshold = v
    else warnings.push(`${path}: \`compactThreshold\` must be a number in (0, 1] — ignoring`)
  }
  if (obj.maxTurns !== undefined) {
    const v = obj.maxTurns
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) out.maxTurns = v
    else warnings.push(`${path}: \`maxTurns\` must be a positive integer — ignoring`)
  }

  objectField('model')
  objectField('providers')
  objectField('shell')
  objectField('lsp')
  objectField('debuggers')
  objectField('languageTools')
  objectField('plugins')
  objectField('gateway')
  objectField('mcpServers')
  objectField('memory')
  objectField('execution')
  objectField('advisor')
  objectField('teams')
  // Read per layer by `@jean/hooks`, which needs to know which file each came
  // from to apply project trust; validated there rather than here.
  objectField('hooks')
  objectField('permissions')
  stringArrayField('instructionFiles')
  stringArrayField('confirmPatterns')
  stringArrayField('denyPatterns')

  // `agents` is keyed by role; unknown roles are a common typo worth naming.
  if (obj.agents !== undefined) {
    if (obj.agents !== null && typeof obj.agents === 'object' && !Array.isArray(obj.agents)) {
      const agents: Record<string, unknown> = {}
      for (const [role, cfg] of Object.entries(obj.agents as Record<string, unknown>)) {
        if (!(MODEL_ROLES as readonly string[]).includes(role)) {
          warnings.push(
            `${path}: unknown model role \`agents.${role}\` — valid roles are ${MODEL_ROLES.join(', ')}`,
          )
          continue
        }
        if (cfg !== null && typeof cfg === 'object' && !Array.isArray(cfg)) agents[role] = cfg
        else warnings.push(`${path}: \`agents.${role}\` must be an object — ignoring`)
      }
      out.agents = agents
    } else {
      warnings.push(`${path}: \`agents\` must be an object — ignoring`)
    }
  }

  // The architecture doc writes these at the top level; the resolved config
  // groups them under `teams`. Accept both spellings rather than making the
  // documented example wrong.
  const teams = (out.teams ?? {}) as Record<string, unknown>
  if (typeof obj.teammateMode === 'string') {
    if (['auto', 'in-process', 'tmux', 'iterm2'].includes(obj.teammateMode)) {
      teams.teammateMode = obj.teammateMode
    } else {
      warnings.push(
        `${path}: \`teammateMode\` must be one of "auto", "in-process", "tmux", "iterm2" — ignoring`,
      )
    }
  }
  if (typeof obj.defaultTeammateModel === 'string') {
    teams.defaultTeammateModel = obj.defaultTeammateModel
  }
  if (Object.keys(teams).length > 0) out.teams = teams

  const known = new Set([
    'mode',
    'ui',
    'model',
    'agents',
    'providers',
    'permissionMode',
    'autoCompact',
    'keepAwake',
    'compactThreshold',
    'maxTurns',
    'effort',
    'shell',
    'lsp',
    'debuggers',
    'languageTools',
    'plugins',
    'gateway',
    'mcpServers',
    'memory',
    'execution',
    'advisor',
    'teams',
    'instructionFiles',
    'confirmPatterns',
    'denyPatterns',
    'debug',
    'hooks',
    'permissions',
    // Top-level spellings folded into `teams` above.
    'teammateMode',
    'defaultTeammateModel',
    // Accepted and ignored: present in configs imported from other agents.
    '$schema',
    'telemetry',
  ])
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) warnings.push(`${path}: unknown setting \`${key}\` — ignoring`)
  }
  if (obj.telemetry !== undefined && obj.telemetry !== false) {
    warnings.push(`${path}: telemetry is always off in Jean Code; \`telemetry\` is ignored`)
  }

  return { value: out as PartialConfig, warnings }
}

/**
 * Deep-merges `patch` onto `base`. Objects merge key-by-key; arrays and scalars
 * replace wholesale, so a project config can shorten `instructionFiles` rather
 * than only ever appending to it.
 */
export function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined || patch === null) return base
  if (Array.isArray(patch)) return patch as unknown as T
  if (typeof patch !== 'object' || typeof base !== 'object' || base === null || Array.isArray(base))
    return patch as unknown as T

  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue
    const prev = out[key]
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      prev !== null &&
      typeof prev === 'object' &&
      !Array.isArray(prev)
    ) {
      out[key] = merge(prev, value as DeepPartial<unknown>)
    } else {
      out[key] = value
    }
  }
  return out as T
}

/**
 * Expands `${VAR}` references against the environment. Applied to string values
 * anywhere in the config, which is how `"apiKey": "${ANTHROPIC_API_KEY}"` works.
 * An unset variable expands to empty and is reported.
 */
export function expandEnv<T>(value: T, env: NodeJS.ProcessEnv, missing: string[] = []): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const resolved = env[name]
      if (resolved === undefined) {
        missing.push(name)
        return ''
      }
      return resolved
    }) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEnv(v, env, missing)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnv(v, env, missing)
    }
    return out as T
  }
  return value
}

/** Normalizes a `provider:model` string into its parts. */
export function splitModelRef(ref: string): { provider?: string; modelId: string } {
  // OpenRouter ids are `vendor/model` and contain no colon; `provider:vendor/model`
  // is the explicit form. Only treat a colon before the first slash as a split.
  const colon = ref.indexOf(':')
  const slash = ref.indexOf('/')
  if (colon > 0 && (slash === -1 || colon < slash)) {
    return { provider: ref.slice(0, colon), modelId: ref.slice(colon + 1) }
  }
  return { modelId: ref }
}

/** Applies role-model defaults so every role resolves to something runnable. */
export function resolveRoles(config: JeanConfig): JeanConfig {
  const fallback = config.agents.default.model ?? config.model.modelId
  const agents = { ...config.agents }
  for (const role of MODEL_ROLES) {
    const existing = agents[role] ?? {}
    agents[role] = { ...existing, model: existing.model ?? fallback }
  }
  return { ...config, agents: agents as JeanConfig['agents'] }
}
