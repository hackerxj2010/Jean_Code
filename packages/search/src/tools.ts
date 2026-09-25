import { ToolError, type ReadSource, type Tool, type ToolResult } from '@jean/tools'
import { renderResults, SearchChain } from './chain.ts'
import { fetchPage } from './fetch.ts'

/**
 * Search and fetch tools (architecture §19).
 *
 * Both refuse to guess. `web_search` reports which providers were tried when
 * everything fails, and `web_fetch` returns the page rather than a summary of
 * it — summarizing here would put a paraphrase in the transcript with the
 * source's authority attached to it.
 */

export function createSearchTools(chain: SearchChain = new SearchChain()): Tool[] {
  const searchTool: Tool<{ query: string; limit?: number; provider?: string; broad?: boolean }> = {
    name: 'web_search',
    risk: 'read',
    description: [
      'Search the web. Results come back with their source URLs.',
      '',
      'Use this for anything outside the repository and outside your training —',
      'a library released since, an error message you do not recognize, current',
      'API documentation. Cite the URL when you use what it returns.',
      '',
      'Set `broad: true` to query every configured provider at once and merge the',
      'results, for research questions where coverage matters more than latency.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        limit: { type: 'integer', description: 'Results per provider. Default 5.' },
        provider: { type: 'string', description: 'Force one provider by name.' },
        broad: { type: 'boolean', description: 'Query every provider and merge.' },
      },
      required: ['query'],
    },
    summarize: (args) => `search ${args.query.slice(0, 60)}`,

    async execute(args, context): Promise<ToolResult> {
      const options = {
        limit: args.limit ?? 5,
        only: args.provider ? [args.provider] : undefined,
        signal: context.signal,
      }

      try {
        const response = args.broad
          ? await chain.searchAll(args.query, options)
          : await chain.search(args.query, options)

        return {
          output: renderResults(response),
          display: { kind: 'search', provider: response.provider, count: response.results.length },
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        const ready = chain
          .available()
          .filter((p) => p.ready)
          .map((p) => p.name)

        throw new ToolError(
          `The search failed: ${detail}`,
          ready.length > 0
            ? `Providers that appeared usable: ${ready.join(', ')}. The network may be unavailable.`
            : 'No provider is configured. Set TAVILY_API_KEY, BRAVE_API_KEY, or SERPER_API_KEY — or check that the keyless providers are reachable.',
        )
      }
    },
  }

  const fetchTool: Tool<{ url: string; maxChars?: number }> = {
    name: 'web_fetch',
    risk: 'read',
    description: [
      'Fetch a URL and return its readable text.',
      '',
      'Use after `web_search` to read a promising result in full, or directly when',
      'you already have the URL. HTML is stripped to prose; JSON is returned',
      'formatted.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http or https URL to fetch.' },
        maxChars: { type: 'integer', description: 'Character budget. Default 40000.' },
      },
      required: ['url'],
    },
    summarize: (args) => `fetch ${args.url.slice(0, 70)}`,

    async execute(args, context): Promise<ToolResult> {
      try {
        const page = await fetchPage(args.url, {
          maxChars: args.maxChars ?? 40_000,
          signal: context.signal,
        })

        const header = page.title ? `# ${page.title}\n${page.url}\n` : `${page.url}\n`
        const footer = page.truncated ? '\n\n[truncated — raise maxChars to read more]' : ''

        return {
          output: `${header}\n${page.text}${footer}`,
          display: { kind: 'fetch', url: page.url, bytes: page.text.length },
        }
      } catch (err) {
        throw new ToolError(
          `Could not fetch ${args.url}: ${err instanceof Error ? err.message : String(err)}`,
          'The site may be unreachable, may require authentication, or may block automated clients.',
        )
      }
    },
  }

  const providersTool: Tool<Record<string, never>> = {
    name: 'web_providers',
    risk: 'read',
    description: 'List the search providers and which are usable in this session.',
    parameters: { type: 'object', properties: {} },
    summarize: () => 'search providers',

    async execute(): Promise<ToolResult> {
      const available = chain.available()
      const lines = available.map(
        (p) => `  ${p.ready ? 'ready' : '  -  '}  ${p.name.padEnd(16)} ${p.tier}`,
      )
      const ready = available.filter((p) => p.ready).length

      return {
        output: `${ready} of ${available.length} providers usable:\n${lines.join('\n')}`,
      }
    },
  }

  return [searchTool as Tool, fetchTool as Tool, providersTool as Tool]
}

/** `read https://…` — a web page as text, the way `web_fetch` reads it. */
export function createUrlReadSource(): ReadSource {
  return {
    name: 'url',
    matches: (path) => /^https?:\/\//i.test(path),
    async read(path, _args, context) {
      try {
        const page = await fetchPage(path, { maxChars: 60_000, signal: context.signal })
        const header = page.title ? `# ${page.title}\n${page.url}\n` : `${page.url}\n`
        return {
          output: `${header}\n${page.text}${page.truncated ? '\n\n[truncated — use `web_fetch` with a larger maxChars]' : ''}`,
          display: { kind: 'fetch', url: page.url, bytes: page.text.length },
        }
      } catch (err) {
        throw new ToolError(`Could not fetch ${path}: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}
