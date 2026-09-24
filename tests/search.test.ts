import { describe, expect, test } from 'bun:test'
import {
  decodeEntities,
  extractText,
  fetchPage,
  PROVIDERS,
  renderResults,
  SearchChain,
  type Provider,
} from '../packages/search/src/index.ts'

/**
 * The chain is tested against stub providers rather than the network, so the
 * ordering and fallback rules are asserted deterministically. Extraction is
 * tested against real HTML, because that is where the bugs actually live.
 */

function stub(
  name: string,
  behaviour: 'ok' | 'empty' | 'throw',
  options: { keyEnv?: string; results?: number } = {},
): Provider {
  return {
    name,
    tier: 'secondary',
    keyEnv: options.keyEnv,
    async search(query) {
      if (behaviour === 'throw') throw new Error(`${name} is down`)
      const count = behaviour === 'empty' ? 0 : (options.results ?? 2)
      return {
        provider: name,
        query,
        results: Array.from({ length: count }, (_, i) => ({
          title: `${name} result ${i}`,
          url: `https://${name}.example/${i}`,
          snippet: `snippet from ${name}`,
        })),
      }
    },
  }
}

describe('the provider chain', () => {
  test('returns the first provider that answers', async () => {
    const chain = new SearchChain([stub('first', 'ok')])
    const response = await chain.search('anything', { env: {} })
    expect(response.provider).toBe('first')
    expect(response.results).toHaveLength(2)
  })

  test('falls through a provider that throws', async () => {
    const chain = new SearchChain([stub('broken', 'throw'), stub('working', 'ok')])
    const response = await chain.search('anything', { env: {} })
    expect(response.provider).toBe('working')
    expect(response.attempted).toEqual(['broken', 'working'])
  })

  test('treats an empty result as a failure and keeps going', async () => {
    // "No results" from one engine rarely means the answer does not exist.
    const chain = new SearchChain([stub('quiet', 'empty'), stub('working', 'ok')])
    expect((await chain.search('x', { env: {} })).provider).toBe('working')
  })

  test('skips a provider with no key instead of attempting it', async () => {
    const attempts: { name: string; outcome: string }[] = []
    const chain = new SearchChain([
      stub('paid', 'ok', { keyEnv: 'SOME_KEY' }),
      stub('free', 'ok'),
    ])

    const response = await chain.search('x', {
      env: {},
      onAttempt: (name, outcome) => attempts.push({ name, outcome }),
    })

    // A request that cannot succeed is latency spent for nothing.
    expect(attempts).toContainEqual({ name: 'paid', outcome: 'skipped' })
    expect(response.attempted).toEqual(['free'])
  })

  test('uses a keyed provider once its key is present', async () => {
    const chain = new SearchChain([stub('paid', 'ok', { keyEnv: 'SOME_KEY' }), stub('free', 'ok')])
    const response = await chain.search('x', { env: { SOME_KEY: 'value' } })
    expect(response.provider).toBe('paid')
  })

  test('reports every failure when nothing answers', async () => {
    const chain = new SearchChain([stub('a', 'throw'), stub('b', 'throw')])
    await expect(chain.search('x', { env: {} })).rejects.toThrow(/a is down[\s\S]*b is down/)
  })

  test('explains what to configure when every provider needs a key', async () => {
    const chain = new SearchChain([stub('paid', 'ok', { keyEnv: 'MISSING_KEY' })])
    await expect(chain.search('x', { env: {} })).rejects.toThrow(/MISSING_KEY/)
  })

  test('restricts to one provider on request', async () => {
    const chain = new SearchChain([stub('a', 'ok'), stub('b', 'ok')])
    expect((await chain.search('x', { env: {}, only: ['b'] })).provider).toBe('b')
  })

  test('reports which providers are usable', () => {
    const chain = new SearchChain([stub('free', 'ok'), stub('paid', 'ok', { keyEnv: 'K' })])
    const available = chain.available({ K: 'set' })
    expect(available.find((p) => p.name === 'free')!.ready).toBe(true)
    expect(available.find((p) => p.name === 'paid')!.ready).toBe(true)
    expect(chain.available({}).find((p) => p.name === 'paid')!.ready).toBe(false)
  })
})

describe('broad search', () => {
  test('merges results from every provider', async () => {
    const chain = new SearchChain([stub('a', 'ok'), stub('b', 'ok')])
    const response = await chain.searchAll('x', { env: {} })
    expect(response.results).toHaveLength(4)
    expect(response.attempted).toEqual(['a', 'b'])
  })

  test('deduplicates the same page across providers', async () => {
    const same = (name: string): Provider => ({
      name,
      tier: 'secondary',
      async search(query) {
        return {
          provider: name,
          query,
          // The same page ranking on three engines is one source, not three.
          results: [{ title: 'shared', url: 'https://shared.example/page', snippet: 's' }],
        }
      },
    })

    const chain = new SearchChain([same('a'), same('b'), same('c')])
    expect((await chain.searchAll('x', { env: {} })).results).toHaveLength(1)
  })

  test('ignores tracking parameters when deduplicating', async () => {
    const withParams = (name: string, url: string): Provider => ({
      name,
      tier: 'secondary',
      async search(query) {
        return { provider: name, query, results: [{ title: 't', url, snippet: 's' }] }
      },
    })

    const chain = new SearchChain([
      withParams('a', 'https://x.example/page?utm_source=one'),
      withParams('b', 'https://x.example/page?utm_source=two'),
    ])
    expect((await chain.searchAll('x', { env: {} })).results).toHaveLength(1)
  })

  test('survives a provider that throws', async () => {
    const chain = new SearchChain([stub('broken', 'throw'), stub('working', 'ok')])
    expect((await chain.searchAll('x', { env: {} })).results).toHaveLength(2)
  })
})

describe('result rendering', () => {
  test('every result carries its source URL', () => {
    const rendered = renderResults({
      provider: 'test',
      query: 'rate limiting',
      attempted: ['test'],
      results: [
        { title: 'Token Bucket', url: 'https://docs.example/tb', snippet: 'The algorithm...' },
      ],
    })

    // An agent that summarizes search results without sources produces text
    // nobody can check.
    expect(rendered).toContain('## rate limiting')
    expect(rendered).toContain('### Token Bucket')
    expect(rendered).toContain('[Source: https://docs.example/tb]')
  })

  test('includes a direct answer when the provider gave one', () => {
    const rendered = renderResults({
      provider: 'test',
      query: 'q',
      attempted: [],
      answer: 'The direct answer.',
      results: [],
    })
    expect(rendered).toContain('The direct answer.')
  })
})

describe('HTML extraction', () => {
  test('strips scripts and styles', () => {
    const html =
      '<html><head><style>body{background:#eee}</style><script>alert(1)</script></head><body><p>Real prose</p></body></html>'
    const text = extractText(html)

    // A `[\s\S]` class inside a template literal collapses to `[sS]` and
    // silently matches nothing, leaving the page's CSS in the output.
    expect(text).toBe('Real prose')
    expect(text).not.toContain('background')
    expect(text).not.toContain('alert')
  })

  test('preserves paragraph structure', () => {
    const text = extractText('<p>First</p><p>Second</p>')
    // Without block-to-newline conversion the page collapses into one line.
    expect(text.split('\n').filter(Boolean)).toEqual(['First', 'Second'])
  })

  test('renders list items', () => {
    expect(extractText('<ul><li>one</li><li>two</li></ul>')).toContain('- one')
  })

  test('strips comments and navigation chrome', () => {
    const text = extractText('<!-- hidden --><nav>Menu</nav><p>Content</p>')
    expect(text).toBe('Content')
  })

  test('decodes entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42;')).toBe('a & b <c> A B')
    expect(decodeEntities('&nbsp;')).toBe(' ')
  })
})

describe('fetching', () => {
  test('refuses a non-http scheme', async () => {
    // `file:` would turn this into an arbitrary file read that bypasses the
    // workspace boundary and the credential-file refusal.
    await expect(fetchPage('file:///etc/passwd')).rejects.toThrow(/only http and https/)
    await expect(fetchPage('data:text/html,hi')).rejects.toThrow(/only http and https/)
  })

  test('rejects a malformed URL', async () => {
    await expect(fetchPage('not a url')).rejects.toThrow(/not a valid URL/)
  })
})

describe('the bundled providers', () => {
  test('are well formed', () => {
    for (const provider of PROVIDERS) {
      expect(provider.name).toMatch(/^[a-z0-9-]+$/)
      expect(['primary', 'secondary', 'tertiary', 'specialized']).toContain(provider.tier)
      expect(typeof provider.search).toBe('function')
    }
  })

  test('have unique names', () => {
    const names = PROVIDERS.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('include keyless providers, so an unconfigured install still works', () => {
    const keyless = PROVIDERS.filter((p) => !p.keyEnv).map((p) => p.name)
    expect(keyless).toContain('duckduckgo')
    expect(keyless).toContain('wikipedia')
    expect(keyless.length).toBeGreaterThanOrEqual(4)
  })
})
