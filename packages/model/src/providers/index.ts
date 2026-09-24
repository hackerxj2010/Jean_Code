import { AnthropicProvider } from './anthropic.ts'
import { GoogleProvider } from './google.ts'
import { OpenAICompatibleProvider } from './openai-compatible.ts'
import type { Provider, ProviderOptions } from '../types.ts'

/**
 * Provider registry.
 *
 * Most of the ecosystem speaks the OpenAI Chat Completions shape, so most
 * entries here are one descriptor rather than one implementation. Anthropic and
 * Google have their own adapters because their wire formats genuinely differ.
 *
 * Adding a provider that speaks the common shape is a single entry in
 * [`OPENAI_COMPATIBLE`] — no new file, no new code path.
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
}

export const OPENAI_COMPATIBLE: ProviderDescriptor[] = [
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
  },
  {
    name: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: ['OPENAI_API_KEY'],
    effortField: 'reasoning_effort',
  },
  {
    name: 'xai',
    label: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    keyEnv: ['XAI_API_KEY'],
  },
  {
    name: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyEnv: ['DEEPSEEK_API_KEY'],
  },
  {
    name: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyEnv: ['MISTRAL_API_KEY'],
  },
  {
    name: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: ['GROQ_API_KEY'],
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
    baseUrl: 'https://api.studio.nebius.ai/v1',
    keyEnv: ['NEBIUS_API_KEY'],
  },
  {
    name: 'siliconflow',
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
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

/** Every provider Jean Code can address, by name. */
export function providerNames(): string[] {
  return ['anthropic', 'google', ...OPENAI_COMPATIBLE.map((p) => p.name)]
}

/** Human-readable label for a provider name. */
export function providerLabel(name: string): string {
  if (name === 'anthropic') return 'Anthropic'
  if (name === 'google') return 'Google Gemini'
  return OPENAI_COMPATIBLE.find((p) => p.name === name)?.label ?? name
}

/**
 * Builds a provider adapter.
 *
 * `options.baseUrl` overrides the descriptor's default, which is how a
 * self-hosted gateway or a corporate proxy is pointed at.
 */
export function createProvider(name: string, options: ProviderOptions = {}): Provider {
  if (name === 'anthropic') return new AnthropicProvider(options)
  if (name === 'google') return new GoogleProvider(options)

  const descriptor = OPENAI_COMPATIBLE.find((p) => p.name === name)
  if (!descriptor) {
    throw new Error(
      `unknown provider "${name}" — known providers: ${providerNames().join(', ')}`,
    )
  }

  return new OpenAICompatibleProvider({
    name: descriptor.name,
    label: descriptor.label,
    baseUrl: options.baseUrl ?? descriptor.baseUrl,
    keyEnv: descriptor.keyEnv,
    extraHeaders: descriptor.extraHeaders,
    supportsTemperature: descriptor.supportsTemperature,
    effortField: descriptor.effortField,
    cacheBreakpoints: descriptor.cacheBreakpoints,
    apiKey: options.apiKey,
    headers: options.headers,
    maxRetries: options.maxRetries,
  })
}

export { AnthropicProvider, GoogleProvider, OpenAICompatibleProvider }
export type { OpenAICompatibleConfig } from './openai-compatible.ts'
