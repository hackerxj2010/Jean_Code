import type { JeanConfig, ModelRole } from '@jean/config'
import { splitModelRef } from '@jean/config'
import { estimateCost, modelInfo } from './catalog.ts'
import { createProvider } from './providers/index.ts'
import { applyStreamRules, type StreamRule } from './streaming.ts'
import type {
  CompletionRequest,
  CompletionResponse,
  Provider,
  StreamEvent,
} from './types.ts'
import { ProviderError } from './types.ts'

/**
 * The model client agents talk to.
 *
 * Agents ask for a *role* (`default`, `smol`, `advisor`, ...) and never name a
 * provider. The client resolves the role to a concrete provider/model pair,
 * runs the request, and falls through a chain of alternates if the primary
 * fails — all transparent to the caller.
 */

export interface ResolvedModel {
  role: ModelRole
  provider: string
  modelId: string
  maxTokens: number
  temperature?: number
  /** Alternates tried in order, at most three. */
  fallbacks: { provider: string; modelId: string }[]
}

export interface ClientOptions {
  config: JeanConfig
  /** Regex rules that inject a reminder mid-stream when output goes off-script. */
  streamRules?: StreamRule[]
  /** Called after every completed request. Local only — nothing leaves the machine. */
  onUsage?: (event: UsageEvent) => void
}

export interface UsageEvent {
  role: ModelRole
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
  costUsd: number
  latencyMs: number
  /** True when the primary model failed and an alternate served the request. */
  usedFallback: boolean
}

export class ModelClient {
  private readonly config: JeanConfig
  private readonly streamRules: StreamRule[]
  private readonly onUsage?: (event: UsageEvent) => void
  /** Providers are cached: each one holds its own connection keep-alive. */
  private readonly providers = new Map<string, Provider>()

  constructor(options: ClientOptions) {
    this.config = options.config
    this.streamRules = options.streamRules ?? []
    this.onUsage = options.onUsage
  }

  /** Resolves a role to the concrete model that will serve it. */
  resolve(role: ModelRole = 'default'): ResolvedModel {
    const agent = this.config.agents[role] ?? this.config.agents.default
    const ref = agent.model ?? this.config.model.modelId
    const split = splitModelRef(ref)
    const provider = split.provider ?? this.config.model.provider

    const fallbacks = (agent.fallbacks ?? []).slice(0, 3).map((entry) => {
      const parts = splitModelRef(entry)
      return { provider: parts.provider ?? provider, modelId: parts.modelId }
    })

    return {
      role,
      provider,
      modelId: split.modelId,
      maxTokens: agent.maxTokens ?? modelInfo(split.modelId, provider).maxOutput,
      temperature: agent.temperature ?? this.config.agents.default.temperature,
      fallbacks,
    }
  }

  private provider(name: string): Provider {
    const cached = this.providers.get(name)
    if (cached) return cached

    const override = this.config.providers[name] ?? {}
    const created = createProvider(name, {
      apiKey: override.apiKey ?? (name === this.config.model.provider ? this.config.model.apiKey : undefined),
      baseUrl: override.baseUrl ?? (name === this.config.model.provider ? this.config.model.baseUrl : undefined),
      headers: override.headers,
    })
    this.providers.set(name, created)
    return created
  }

  /** True when the role's provider has credentials. */
  isConfigured(role: ModelRole = 'default'): boolean {
    try {
      return this.provider(this.resolve(role).provider).isConfigured()
    } catch {
      return false
    }
  }

  /**
   * Runs a completion, falling through the chain on failure.
   *
   * Only *transport* failures trigger a fallback. A model that answers badly is
   * the agent's problem, not the client's.
   */
  async complete(
    request: CompletionRequest,
    role: ModelRole = 'default',
  ): Promise<CompletionResponse> {
    const resolved = this.resolve(role)
    const chain = [
      { provider: resolved.provider, modelId: resolved.modelId },
      ...resolved.fallbacks,
    ]
    const failures: string[] = []

    for (const [index, target] of chain.entries()) {
      try {
        const response = await this.provider(target.provider).complete(
          target.modelId,
          this.withDefaults(request, resolved),
        )
        this.report(resolved, response, index > 0)
        return response
      } catch (err) {
        if (!shouldFallThrough(err) || index === chain.length - 1) throw err
        failures.push(`${target.provider}/${target.modelId}: ${errMessage(err)}`)
      }
    }

    throw new ProviderError(
      `every model in the chain failed:\n  ${failures.join('\n  ')}`,
      resolved.provider,
    )
  }

  /**
   * Streams a completion, falling through the chain the same way.
   *
   * The fallback can only fire before the first token: once output has started
   * reaching the caller, switching models mid-answer would splice two different
   * responses together.
   */
  async *stream(
    request: CompletionRequest,
    role: ModelRole = 'default',
  ): AsyncGenerator<StreamEvent, void, void> {
    const resolved = this.resolve(role)
    const chain = [
      { provider: resolved.provider, modelId: resolved.modelId },
      ...resolved.fallbacks,
    ]
    const failures: string[] = []

    for (const [index, target] of chain.entries()) {
      let emitted = false
      try {
        const source = this.provider(target.provider).stream(
          target.modelId,
          this.withDefaults(request, resolved),
        )
        for await (const event of applyStreamRules(source, this.streamRules)) {
          emitted = true
          if (event.type === 'done') this.report(resolved, event.response, index > 0)
          yield event
        }
        return
      } catch (err) {
        if (emitted || !shouldFallThrough(err) || index === chain.length - 1) throw err
        failures.push(`${target.provider}/${target.modelId}: ${errMessage(err)}`)
      }
    }

    throw new ProviderError(
      `every model in the chain failed:\n  ${failures.join('\n  ')}`,
      resolved.provider,
    )
  }

  private withDefaults(request: CompletionRequest, resolved: ResolvedModel): CompletionRequest {
    return {
      ...request,
      maxTokens: request.maxTokens ?? resolved.maxTokens,
      temperature: request.temperature ?? resolved.temperature,
      effort: request.effort ?? this.config.effort,
    }
  }

  private report(resolved: ResolvedModel, response: CompletionResponse, usedFallback: boolean) {
    this.onUsage?.({
      role: resolved.role,
      provider: response.provider,
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cachedTokens: response.usage.cachedTokens,
      costUsd: estimateCost(response.model, response.usage.inputTokens, response.usage.outputTokens),
      latencyMs: response.latencyMs,
      usedFallback,
    })
  }
}

/**
 * Whether a failure justifies trying the next model.
 *
 * Auth failures do not: the next model probably shares the key, and silently
 * burning through a chain hides the real problem. Rate limits, outages, and
 * missing-model errors do.
 */
function shouldFallThrough(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return true
  if (err.status === 401 || err.status === 403) return false
  return true
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
