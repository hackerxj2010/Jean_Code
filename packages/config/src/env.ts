import type { PartialConfig } from './types.ts'

/**
 * Environment variable handling (architecture §24.3).
 *
 * Two jobs: map `JEAN_*` variables onto config fields, and map the well-known
 * provider key variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...) onto
 * provider credentials so a bare `export OPENROUTER_API_KEY=...` is enough to
 * start.
 */

/** Environment variable that carries each provider's key, in probe order. */
export const PROVIDER_KEY_ENV: Record<string, string[]> = {
  openrouter: ['OPENROUTER_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  xai: ['XAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  ollama: [],
  vllm: [],
  llamacpp: [],
}

/** Reads a provider's API key from the environment, if present. */
export function providerKeyFromEnv(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of PROVIDER_KEY_ENV[provider] ?? []) {
    const value = env[name]
    if (value && value.trim()) return value.trim()
  }
  return undefined
}

/** Every provider that currently has usable credentials in the environment. */
export function configuredProviders(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(PROVIDER_KEY_ENV).filter((p) => {
    // Local runtimes need an endpoint, not a key.
    if (PROVIDER_KEY_ENV[p]!.length === 0) return Boolean(env.LOCAL_ENDPOINT)
    return providerKeyFromEnv(p, env) !== undefined
  })
}

/**
 * Builds a config fragment from `JEAN_*` environment variables. These sit above
 * config files and below command-line flags.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): {
  config: PartialConfig
  warnings: string[]
} {
  const config: PartialConfig = {}
  const warnings: string[] = []

  if (env.JEAN_MODEL) {
    config.model = { modelId: env.JEAN_MODEL }
  }
  if (env.JEAN_EXECUTION) {
    const backend = env.JEAN_EXECUTION
    const valid = ['local', 'docker', 'ssh', 'daytona', 'modal', 'singularity']
    if (valid.includes(backend)) {
      config.execution = { backend: backend as never }
    } else {
      warnings.push(`JEAN_EXECUTION="${backend}" is not a known backend — ignoring`)
    }
  }
  if (env.JEAN_PERMISSION_MODE) {
    const mode = env.JEAN_PERMISSION_MODE
    if (['auto', 'ask', 'plan', 'full'].includes(mode)) {
      config.permissionMode = mode as never
    } else {
      warnings.push(`JEAN_PERMISSION_MODE="${mode}" is not a known mode — ignoring`)
    }
  }
  if (env.JEAN_EFFORT) {
    const effort = env.JEAN_EFFORT
    if (['fast', 'normal', 'high', 'xhigh'].includes(effort)) {
      config.effort = effort as never
    } else {
      warnings.push(`JEAN_EFFORT="${effort}" is not a known effort level — ignoring`)
    }
  }
  if (env.JEAN_DEBUG && env.JEAN_DEBUG !== '0' && env.JEAN_DEBUG !== 'false') {
    config.debug = true
  }
  if (env.SHELL) {
    config.shell = { path: env.SHELL }
  }
  if (env.JEAN_SHELL === 'native' || env.JEAN_SHELL === 'system') {
    config.shell = { ...config.shell, backend: env.JEAN_SHELL }
  }
  if (env.LOCAL_ENDPOINT) {
    config.providers = {
      ...config.providers,
      ollama: { baseUrl: env.LOCAL_ENDPOINT },
    }
  }

  return { config, warnings }
}

/**
 * Loads `.env` files into a plain object without mutating `process.env`.
 * Supports `KEY=value`, quoting, `export ` prefixes, and `#` comments.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
    const eq = withoutExport.indexOf('=')
    if (eq <= 0) continue
    const key = withoutExport.slice(0, eq).trim()
    let value = withoutExport.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    } else {
      // Unquoted values end at an inline comment.
      const hash = value.indexOf(' #')
      if (hash >= 0) value = value.slice(0, hash).trim()
    }
    if (key) out[key] = value
  }
  return out
}
