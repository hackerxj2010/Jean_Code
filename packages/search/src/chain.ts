import { PROVIDERS, type Provider, type SearchOptions, type SearchResponse, type SearchResult } from './providers.ts'

/**
 * The provider chain (architecture §19.1).
 *
 * Tries providers in order until one returns results. The ordering rule that
 * matters: a provider is skipped when its key is absent rather than attempted
 * and failed, so an unconfigured chain costs no requests and no latency.
 */

export interface ChainOptions extends SearchOptions {
  /** Restricts the chain to these provider names. */
  only?: string[]
  /** Environment to read keys from. */
  env?: NodeJS.ProcessEnv
  onAttempt?: (provider: string, outcome: 'skipped' | 'failed' | 'succeeded', detail?: string) => void
}

export interface ChainResult extends SearchResponse {
  /** Providers tried before this one succeeded. */
  attempted: string[]
}

export class SearchChain {
  private readonly providers: Provider[]

  constructor(providers: Provider[] = PROVIDERS) {
    this.providers = providers
  }

  /** Providers that could run right now, with their key status. */
  available(env: NodeJS.ProcessEnv = process.env): { name: string; tier: string; ready: boolean }[] {
    return this.providers.map((provider) => ({
      name: provider.name,
      tier: provider.tier,
      ready: !provider.keyEnv || Boolean(env[provider.keyEnv]),
    }))
  }

  /**
   * Searches, falling through the chain until something answers.
   *
   * A provider that returns zero results counts as a failure and the chain
   * continues: "no results" from one engine rarely means the answer does not
   * exist, and reporting it as final would be wrong more often than not.
   */
  async search(query: string, options: ChainOptions = {}): Promise<ChainResult> {
    const env = options.env ?? process.env
    const attempted: string[] = []
    const failures: string[] = []

    const candidates = options.only
      ? this.providers.filter((p) => options.only!.includes(p.name))
      : this.providers

    if (candidates.length === 0) {
      throw new Error('no search providers match the requested filter')
    }

    for (const provider of candidates) {
      const key = provider.keyEnv ? env[provider.keyEnv] : undefined

      if (provider.keyEnv && !key) {
        // Skipped, not attempted: a request that cannot possibly succeed is
        // latency spent for nothing.
        options.onAttempt?.(provider.name, 'skipped', `${provider.keyEnv} is not set`)
        continue
      }

      attempted.push(provider.name)

      try {
        const response = await provider.search(query, {
          ...options,
          key,
          limit: options.limit ?? 5,
        })

        if (response.results.length > 0) {
          options.onAttempt?.(provider.name, 'succeeded')
          return { ...response, attempted }
        }
        failures.push(`${provider.name}: no results`)
        options.onAttempt?.(provider.name, 'failed', 'no results')
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        failures.push(detail)
        options.onAttempt?.(provider.name, 'failed', detail)
      }
    }

    const configured = candidates.filter((p) => !p.keyEnv || env[p.keyEnv])
    if (configured.length === 0) {
      throw new Error(
        `No search provider is configured. Set one of: ${candidates
          .map((p) => p.keyEnv)
          .filter(Boolean)
          .join(', ')} — or rely on the keyless providers (duckduckgo, wikipedia, stackoverflow, github, arxiv), which appear to be unreachable.`,
      )
    }

    throw new Error(`Every provider failed:\n${failures.map((f) => `  ${f}`).join('\n')}`)
  }

  /**
   * Searches several providers at once and merges the results.
   *
   * For research questions where breadth beats latency. Deduplicated by URL,
   * because the same page ranking on three engines is one source, not three.
   */
  async searchAll(query: string, options: ChainOptions = {}): Promise<ChainResult> {
    const env = options.env ?? process.env
    const candidates = (options.only
      ? this.providers.filter((p) => options.only!.includes(p.name))
      : this.providers
    ).filter((p) => !p.keyEnv || env[p.keyEnv])

    if (candidates.length === 0) throw new Error('no configured search providers')

    const settled = await Promise.allSettled(
      candidates.map((provider) =>
        provider.search(query, {
          ...options,
          key: provider.keyEnv ? env[provider.keyEnv] : undefined,
          limit: options.limit ?? 5,
        }),
      ),
    )

    const seen = new Set<string>()
    const merged: SearchResult[] = []
    const attempted: string[] = []
    let answer: string | undefined

    for (const [index, outcome] of settled.entries()) {
      const name = candidates[index]!.name
      attempted.push(name)
      if (outcome.status !== 'fulfilled') continue

      answer ??= outcome.value.answer
      for (const result of outcome.value.results) {
        const key = normalizeUrl(result.url)
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(result)
      }
    }

    if (merged.length === 0) throw new Error('every provider failed or returned nothing')
    return { provider: 'merged', query, results: merged, answer, attempted }
  }
}

/** Normalizes a URL for deduplication. */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    // Tracking parameters make the same page look like several.
    for (const parameter of [...parsed.searchParams.keys()]) {
      if (/^(utm_|ref|source|fbclid|gclid)/.test(parameter)) parsed.searchParams.delete(parameter)
    }
    return `${parsed.host}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`.toLowerCase()
  } catch {
    return url.toLowerCase()
  }
}

/**
 * Renders results as markdown with intact citations (architecture §19.2).
 *
 * Every claim carries the URL it came from. That is the point of the format:
 * an agent that summarizes search results without sources produces text nobody
 * can check, which is worse than no answer.
 */
export function renderResults(response: ChainResult, options: { includeContent?: boolean } = {}): string {
  const sections: string[] = [`## ${response.query}`, '']

  if (response.answer) {
    sections.push(response.answer.trim(), '')
  }

  for (const result of response.results) {
    sections.push(`### ${result.title}`)
    const body = options.includeContent && result.content ? result.content : result.snippet
    if (body) sections.push(body.trim())
    if (result.publishedAt) sections.push(`*${result.publishedAt}*`)
    sections.push(`[Source: ${result.url}](${result.url})`, '')
  }

  sections.push(`*via ${response.provider}*`)
  return sections.join('\n')
}
