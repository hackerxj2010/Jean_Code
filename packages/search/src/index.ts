/**
 * `@jean/search` — the web search chain (architecture §19).
 *
 * Ten providers tried in order until one answers, with keyless providers first
 * so an unconfigured install still works. Every result carries the URL it came
 * from: an agent that summarizes search results without sources produces text
 * nobody can check, which is worse than no answer.
 */

export {
  arxiv,
  brave,
  duckduckgo,
  exa,
  github,
  PROVIDERS,
  searxng,
  serper,
  stackoverflow,
  tavily,
  wikipedia,
  type Provider,
  type ProviderTier,
  type SearchOptions,
  type SearchResponse,
  type SearchResult,
} from './providers.ts'

export {
  renderResults,
  SearchChain,
  type ChainOptions,
  type ChainResult,
} from './chain.ts'

export { decodeEntities, extractText, fetchPage, type FetchedPage } from './fetch.ts'
export { createSearchTools, createUrlReadSource } from './tools.ts'
