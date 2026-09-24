/**
 * Search providers (architecture §19.1).
 *
 * Every provider reduces to the same shape: a request built from a query, and a
 * response parsed into results carrying their source URL. Keeping that uniform
 * is what makes the chain in `chain.ts` a loop rather than a switch statement.
 *
 * Providers that need no key come first in the default order, because a chain
 * whose first working link requires a paid account is not a chain — it is a
 * paid dependency with extra steps.
 */

import { decodeEntities } from './fetch.ts'

export interface SearchResult {
  title: string
  url: string
  /** The provider's excerpt. Never fabricated: the citation must be real. */
  snippet: string
  /** Full page text, when the provider returns it. */
  content?: string
  publishedAt?: string
}

export interface SearchResponse {
  provider: string
  query: string
  results: SearchResult[]
  /** A direct answer, where the provider produces one. */
  answer?: string
}

export type ProviderTier = 'primary' | 'secondary' | 'tertiary' | 'specialized'

export interface Provider {
  name: string
  tier: ProviderTier
  /** Environment variable holding the key. Absent means no key needed. */
  keyEnv?: string
  /** Restricts this provider to queries about its domain. */
  domain?: string
  search: (query: string, options: SearchOptions) => Promise<SearchResponse>
}

export interface SearchOptions {
  limit?: number
  key?: string
  signal?: AbortSignal
  timeoutMs?: number
}

async function request(url: string, init: RequestInit, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function fail(provider: string, detail: string): never {
  throw new Error(`${provider}: ${detail}`)
}

// ---- keyless providers ----------------------------------------------------

/**
 * DuckDuckGo's Instant Answer API.
 *
 * Keyless, which is why it leads the default chain. It answers definitional and
 * factual queries well and returns little for open-ended ones — so it is a good
 * first try and a poor only option.
 */
export const duckduckgo: Provider = {
  name: 'duckduckgo',
  tier: 'secondary',
  async search(query, options) {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
    const response = await request(url, {}, options.timeoutMs)
    if (!response.ok) fail('duckduckgo', `HTTP ${response.status}`)

    const body = (await response.json()) as {
      AbstractText?: string
      AbstractURL?: string
      Heading?: string
      RelatedTopics?: { Text?: string; FirstURL?: string }[]
    }

    const results: SearchResult[] = []
    if (body.AbstractText && body.AbstractURL) {
      results.push({
        title: body.Heading ?? query,
        url: body.AbstractURL,
        snippet: body.AbstractText,
      })
    }

    for (const topic of body.RelatedTopics ?? []) {
      if (!topic.Text || !topic.FirstURL) continue
      results.push({ title: topic.Text.split(' - ')[0] ?? topic.Text, url: topic.FirstURL, snippet: topic.Text })
      if (results.length >= (options.limit ?? 10)) break
    }

    if (results.length === 0) fail('duckduckgo', 'no results')
    return { provider: 'duckduckgo', query, results, answer: body.AbstractText }
  },
}

/** Wikipedia, for background on a named thing. */
export const wikipedia: Provider = {
  name: 'wikipedia',
  tier: 'specialized',
  domain: 'encyclopedic',
  async search(query, options) {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${options.limit ?? 5}&origin=*`
    const response = await request(url, {}, options.timeoutMs)
    if (!response.ok) fail('wikipedia', `HTTP ${response.status}`)

    const body = (await response.json()) as {
      query?: { search?: { title: string; snippet: string; timestamp?: string }[] }
    }

    const results = (body.query?.search ?? []).map((hit) => ({
      title: hit.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
      // The API returns HTML-highlighted snippets; the markup is noise here.
      snippet: decodeEntities(hit.snippet.replace(/<[^>]+>/g, '')),
      publishedAt: hit.timestamp,
    }))

    if (results.length === 0) fail('wikipedia', 'no results')
    return { provider: 'wikipedia', query, results }
  },
}

/** arXiv, for papers. */
export const arxiv: Provider = {
  name: 'arxiv',
  tier: 'specialized',
  domain: 'research',
  async search(query, options) {
    const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${options.limit ?? 5}`
    const response = await request(url, {}, options.timeoutMs)
    if (!response.ok) fail('arxiv', `HTTP ${response.status}`)

    // Atom XML rather than JSON; the fields needed are simple enough to extract
    // without a parser, and adding one for four tags is not worth it.
    const text = await response.text()
    const entries = text.split('<entry>').slice(1)

    const results = entries.map((entry) => ({
      title: extractTag(entry, 'title').replace(/\s+/g, ' ').trim(),
      url: extractTag(entry, 'id').trim(),
      snippet: extractTag(entry, 'summary').replace(/\s+/g, ' ').trim().slice(0, 500),
      publishedAt: extractTag(entry, 'published').trim(),
    }))

    if (results.length === 0) fail('arxiv', 'no results')
    return { provider: 'arxiv', query, results }
  },
}

/** GitHub code and repository search. */
export const github: Provider = {
  name: 'github',
  tier: 'specialized',
  domain: 'code',
  keyEnv: 'GITHUB_TOKEN',
  async search(query, options) {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${options.limit ?? 5}`
    const response = await request(
      url,
      {
        headers: {
          accept: 'application/vnd.github+json',
          // Unauthenticated requests are allowed but rate-limited to 10/minute.
          ...(options.key ? { authorization: `Bearer ${options.key}` } : {}),
        },
      },
      options.timeoutMs,
    )
    if (!response.ok) fail('github', `HTTP ${response.status}`)

    const body = (await response.json()) as {
      items?: { full_name: string; html_url: string; description?: string; pushed_at?: string }[]
    }

    const results = (body.items ?? []).map((item) => ({
      title: item.full_name,
      url: item.html_url,
      snippet: item.description ?? '',
      publishedAt: item.pushed_at,
    }))

    if (results.length === 0) fail('github', 'no results')
    return { provider: 'github', query, results }
  },
}

/** Stack Overflow, via the Stack Exchange API. */
export const stackoverflow: Provider = {
  name: 'stackoverflow',
  tier: 'specialized',
  domain: 'programming',
  async search(query, options) {
    const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&filter=withbody&pagesize=${options.limit ?? 5}`
    const response = await request(url, {}, options.timeoutMs)
    if (!response.ok) fail('stackoverflow', `HTTP ${response.status}`)

    const body = (await response.json()) as {
      items?: { title: string; link: string; body?: string; creation_date?: number; score: number }[]
    }

    const results = (body.items ?? []).map((item) => ({
      title: item.title,
      url: item.link,
      snippet: decodeEntities((item.body ?? '').replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400),
      publishedAt: item.creation_date
        ? new Date(item.creation_date * 1000).toISOString()
        : undefined,
    }))

    if (results.length === 0) fail('stackoverflow', 'no results')
    return { provider: 'stackoverflow', query, results }
  },
}

// ---- key-requiring providers ----------------------------------------------

export const tavily: Provider = {
  name: 'tavily',
  tier: 'primary',
  keyEnv: 'TAVILY_API_KEY',
  async search(query, options) {
    const response = await request(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: options.key,
          query,
          max_results: options.limit ?? 5,
          include_answer: true,
        }),
      },
      options.timeoutMs,
    )
    if (!response.ok) fail('tavily', `HTTP ${response.status}`)

    const body = (await response.json()) as {
      answer?: string
      results?: { title: string; url: string; content: string }[]
    }

    const results = (body.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }))

    if (results.length === 0) fail('tavily', 'no results')
    return { provider: 'tavily', query, results, answer: body.answer }
  },
}

export const brave: Provider = {
  name: 'brave',
  tier: 'secondary',
  keyEnv: 'BRAVE_API_KEY',
  async search(query, options) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${options.limit ?? 5}`
    const response = await request(
      url,
      { headers: { accept: 'application/json', 'x-subscription-token': options.key ?? '' } },
      options.timeoutMs,
    )
    if (!response.ok) fail('brave', `HTTP ${response.status}`)

    const body = (await response.json()) as {
      web?: { results?: { title: string; url: string; description: string; age?: string }[] }
    }

    const results = (body.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: decodeEntities(r.description.replace(/<[^>]+>/g, '')),
      publishedAt: r.age,
    }))

    if (results.length === 0) fail('brave', 'no results')
    return { provider: 'brave', query, results }
  },
}

export const serper: Provider = {
  name: 'serper',
  tier: 'secondary',
  keyEnv: 'SERPER_API_KEY',
  async search(query, options) {
    const response = await request(
      'https://google.serper.dev/search',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': options.key ?? '' },
        body: JSON.stringify({ q: query, num: options.limit ?? 5 }),
      },
      options.timeoutMs,
    )
    if (!response.ok) fail('serper', `HTTP ${response.status}`)

    const body = (await response.json()) as {
      answerBox?: { answer?: string; snippet?: string }
      organic?: { title: string; link: string; snippet: string; date?: string }[]
    }

    const results = (body.organic ?? []).map((r) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
      publishedAt: r.date,
    }))

    if (results.length === 0) fail('serper', 'no results')
    return {
      provider: 'serper',
      query,
      results,
      answer: body.answerBox?.answer ?? body.answerBox?.snippet,
    }
  },
}

export const exa: Provider = {
  name: 'exa',
  tier: 'primary',
  keyEnv: 'EXA_API_KEY',
  async search(query, options) {
    const response = await request(
      'https://api.exa.ai/search',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': options.key ?? '' },
        body: JSON.stringify({
          query,
          numResults: options.limit ?? 5,
          contents: { text: { maxCharacters: 2000 } },
        }),
      },
      options.timeoutMs,
    )
    if (!response.ok) fail('exa', `HTTP ${response.status}`)

    const body = (await response.json()) as {
      results?: { title: string; url: string; text?: string; publishedDate?: string }[]
    }

    const results = (body.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: (r.text ?? '').slice(0, 400),
      content: r.text,
      publishedAt: r.publishedDate,
    }))

    if (results.length === 0) fail('exa', 'no results')
    return { provider: 'exa', query, results }
  },
}

export const searxng: Provider = {
  name: 'searxng',
  tier: 'secondary',
  // A self-hosted instance: the URL is the credential.
  keyEnv: 'SEARXNG_URL',
  async search(query, options) {
    const base = (options.key ?? '').replace(/\/+$/, '')
    if (!base) fail('searxng', 'no instance URL configured')

    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`
    const response = await request(url, {}, options.timeoutMs)
    if (!response.ok) fail('searxng', `HTTP ${response.status}`)

    const body = (await response.json()) as {
      results?: { title: string; url: string; content?: string }[]
    }

    const results = (body.results ?? []).slice(0, options.limit ?? 5).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content ?? '',
    }))

    if (results.length === 0) fail('searxng', 'no results')
    return { provider: 'searxng', query, results }
  },
}

function extractTag(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml)
  return match?.[1] ?? ''
}

/**
 * The default chain order.
 *
 * Keyless providers lead. A chain whose first working link needs a paid account
 * is not a fallback chain — it is a paid dependency with extra steps.
 */
export const PROVIDERS: Provider[] = [
  tavily,
  exa,
  serper,
  brave,
  searxng,
  duckduckgo,
  stackoverflow,
  github,
  wikipedia,
  arxiv,
]
