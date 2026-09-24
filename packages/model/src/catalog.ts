import type { ModelInfo } from './types.ts'

/**
 * Bundled model catalog.
 *
 * Context windows and capability flags drive real decisions — when to compact,
 * whether tools can be offered, whether images can be attached — so the catalog
 * ships with the binary rather than being fetched at startup. An id that is not
 * listed still works; it just falls back to conservative defaults.
 */

const CATALOG: ModelInfo[] = [
  // Current generation (September 2026). Context windows and output limits
  // are what OpenRouter reports for the model's best provider; a wrong window
  // here makes compaction fire far too early or far too late.
  m('anthropic/claude-opus-5.5', 'anthropic', 'Claude Opus 5.5', 1_000_000, 128_000, 4, 20, true),
  m('anthropic/claude-fable-5.1', 'anthropic', 'Claude Fable 5.1', 1_000_000, 128_000, 10, 50, true),
  m('anthropic/claude-opus-5', 'anthropic', 'Claude Opus 5', 1_000_000, 128_000, 5, 25, true),
  m('anthropic/claude-sonnet-5', 'anthropic', 'Claude Sonnet 5', 1_000_000, 128_000, 2, 10, true),
  m('openai/gpt-5.5', 'openai', 'GPT-5.5', 1_050_000, 128_000, 5, 30, true),
  m('openai/gpt-5.6-sol', 'openai', 'GPT-5.6 Sol', 1_050_000, 128_000, 2, 10, true),
  m('openai/gpt-5.6-terra', 'openai', 'GPT-5.6 Terra', 1_050_000, 128_000, 2, 12, true),
  m('openai/gpt-5.6-luna', 'openai', 'GPT-5.6 Luna', 1_050_000, 128_000, 0.2, 1.2, true),
  m('openai/gpt-5.4-nano', 'openai', 'GPT-5.4 Nano', 400_000, 128_000, 0.2, 1.25, true),
  m('google/gemini-3.8-flash', 'google', 'Gemini 3.8 Flash', 1_048_576, 65_536, 0.75, 3.75, true),
  m('deepseek/deepseek-v4-pro', 'deepseek', 'DeepSeek V4 Pro', 1_048_576, 384_000, 0.95, 1.91, true, false),
  m('deepseek/deepseek-v4-flash', 'deepseek', 'DeepSeek V4 Flash', 1_048_576, 384_000, 0.08, 0.17, true, false),
  m('x-ai/grok-4.7', 'xai', 'Grok 4.7', 500_000, 450_000, 1.6, 4.8, true),
  m('moonshotai/kimi-k3', 'openrouter', 'Kimi K3', 1_048_576, 943_718, 3, 15, true),
  m('moonshotai/kimi-k2.7-code', 'openrouter', 'Kimi K2.7 Code', 262_144, 235_929, 0.71, 3.3, true),
  m('z-ai/glm-5.3', 'openrouter', 'GLM 5.3', 1_310_720, 131_072, 0.84, 2.64, true, false),
  m('minimax/minimax-m3', 'openrouter', 'MiniMax M3', 1_048_576, 512_000, 0.3, 1.2, true),
  m('poolside/laguna-s-2.1', 'openrouter', 'Laguna S 2.1', 1_048_576, 131_072, 0.09, 0.18, true, false),
  // Anthropic
  m('anthropic/claude-opus-4.1', 'anthropic', 'Claude Opus 4.1', 200_000, 32_000, 15, 75, true),
  m('anthropic/claude-sonnet-4.5', 'anthropic', 'Claude Sonnet 4.5', 200_000, 64_000, 3, 15, true),
  m('anthropic/claude-haiku-4.5', 'anthropic', 'Claude Haiku 4.5', 200_000, 32_000, 1, 5, true),
  // OpenAI
  m('openai/gpt-4o', 'openai', 'GPT-4o', 128_000, 16_384, 2.5, 10, false, true),
  m('openai/gpt-4o-mini', 'openai', 'GPT-4o mini', 128_000, 16_384, 0.15, 0.6, false, true),
  m('openai/o3', 'openai', 'o3', 200_000, 100_000, 2, 8, true, true),
  m('openai/o4-mini', 'openai', 'o4-mini', 200_000, 100_000, 1.1, 4.4, true, true),
  // Google
  m('google/gemini-2.5-pro', 'google', 'Gemini 2.5 Pro', 1_048_576, 65_536, 1.25, 10, true),
  m('google/gemini-2.5-flash', 'google', 'Gemini 2.5 Flash', 1_048_576, 65_536, 0.3, 2.5, true),
  // Others
  m('deepseek/deepseek-chat', 'deepseek', 'DeepSeek V3', 64_000, 8_192, 0.27, 1.1, false, false),
  m('deepseek/deepseek-reasoner', 'deepseek', 'DeepSeek R1', 64_000, 8_192, 0.55, 2.19, true, false),
  m('x-ai/grok-4', 'xai', 'Grok 4', 256_000, 32_000, 3, 15, true),
  m('mistralai/mistral-large', 'mistral', 'Mistral Large', 128_000, 8_192, 2, 6, false, false),
  m('qwen/qwen3-coder', 'openrouter', 'Qwen3 Coder', 262_144, 32_000, 0.3, 1.2, false, false),
  m('moonshotai/kimi-k2', 'openrouter', 'Kimi K2', 200_000, 32_000, 0.6, 2.5, false, false),
]

function m(
  id: string,
  provider: string,
  label: string,
  contextWindow: number,
  maxOutput: number,
  inputCost?: number,
  outputCost?: number,
  supportsThinking = false,
  supportsVision = true,
): ModelInfo {
  return {
    id,
    provider,
    label,
    contextWindow,
    maxOutput,
    inputCost,
    outputCost,
    supportsTools: true,
    supportsVision,
    supportsThinking,
  }
}

/** Conservative defaults for a model the catalog has never heard of. */
const UNKNOWN_DEFAULTS = {
  contextWindow: 128_000,
  maxOutput: 8_192,
  supportsTools: true,
  supportsVision: false,
  supportsThinking: false,
}

/** Everything in the catalog. */
export function allModels(): ModelInfo[] {
  return [...CATALOG]
}

/**
 * Looks up a model id.
 *
 * Ids are matched loosely: `claude-sonnet-4.5` finds `anthropic/claude-sonnet-4.5`,
 * because OpenRouter-style vendor prefixes are noise when the user is typing.
 */
export function findModel(id: string): ModelInfo | undefined {
  const needle = id.toLowerCase()
  const exact = CATALOG.find((entry) => entry.id.toLowerCase() === needle)
  if (exact) return exact
  const bare = needle.includes('/') ? needle.slice(needle.lastIndexOf('/') + 1) : needle
  return CATALOG.find((entry) => {
    const entryBare = entry.id.slice(entry.id.lastIndexOf('/') + 1).toLowerCase()
    return entryBare === bare
  })
}

/** Model metadata, filled with safe defaults when the id is unknown. */
export function modelInfo(id: string, provider = 'openrouter'): ModelInfo {
  const known = findModel(id)
  if (known) return known
  return {
    id,
    provider,
    label: id,
    ...UNKNOWN_DEFAULTS,
  }
}

/** Context window for a model id — the number auto-compaction is measured against. */
export function contextWindow(id: string): number {
  return modelInfo(id).contextWindow
}

/** Estimated USD cost of a completed request. */
export function estimateCost(id: string, inputTokens: number, outputTokens: number): number {
  const info = findModel(id)
  if (!info?.inputCost || !info.outputCost) return 0
  return (inputTokens * info.inputCost + outputTokens * info.outputCost) / 1_000_000
}

/**
 * Approximate token count.
 *
 * Deliberately an estimate: exact BPE counting needs the tables in
 * `crates/pi-natives`, and every caller here is deciding *when to compact*,
 * where being 10% off costs nothing. ~3.6 chars/token tracks code better than
 * the usual 4, which is tuned for prose.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 3.6)
}

/** Models that can be offered tools — everything current, but checked anyway. */
export function supportsTools(id: string): boolean {
  return modelInfo(id).supportsTools
}

export function supportsVision(id: string): boolean {
  return modelInfo(id).supportsVision
}

export function supportsThinking(id: string): boolean {
  return modelInfo(id).supportsThinking
}
