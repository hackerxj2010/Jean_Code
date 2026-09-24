/**
 * Page fetching and extraction (architecture §19.2, §8.1 URL targets).
 *
 * Turns a URL into readable text. The extraction is deliberately crude — strip
 * scripts, styles, and chrome, then collapse whitespace — because a real
 * readability implementation is a large dependency and the agent needs the
 * prose, not a faithful reproduction of the page.
 */

export interface FetchedPage {
  url: string
  title?: string
  text: string
  /** Set when the response was not HTML. */
  contentType?: string
  truncated: boolean
}

/** Elements whose contents are never prose. */
const STRIP_ELEMENTS = ['script', 'style', 'noscript', 'svg', 'nav', 'header', 'footer', 'iframe']

export async function fetchPage(
  url: string,
  options: { maxChars?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<FetchedPage> {
  const maxChars = options.maxChars ?? 40_000

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`not a valid URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // `file:` would turn a fetch tool into an arbitrary file read that bypasses
    // the workspace boundary and the credential-file refusal.
    throw new Error(`only http and https URLs can be fetched, not ${parsed.protocol}`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000)
  options.signal?.addEventListener('abort', () => controller.abort())

  let response: Response
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // A real user agent: many sites serve an error or a challenge to an
        // unidentified client, which reads as a broken tool rather than a block.
        'user-agent': 'Mozilla/5.0 (compatible; JeanCode/0.1; +https://jean-code.ai)',
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8',
      },
    })
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)

  const contentType = response.headers.get('content-type') ?? ''
  const raw = await response.text()

  if (contentType.includes('json')) {
    const pretty = (() => {
      try {
        return JSON.stringify(JSON.parse(raw), null, 2)
      } catch {
        return raw
      }
    })()
    return {
      url: response.url,
      text: pretty.slice(0, maxChars),
      contentType,
      truncated: pretty.length > maxChars,
    }
  }

  if (!contentType.includes('html')) {
    return {
      url: response.url,
      text: raw.slice(0, maxChars),
      contentType,
      truncated: raw.length > maxChars,
    }
  }

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim()
  const text = extractText(raw)

  return {
    url: response.url,
    title: title ? decodeEntities(title) : undefined,
    text: text.slice(0, maxChars),
    contentType,
    truncated: text.length > maxChars,
  }
}

/** Strips markup down to prose. */
export function extractText(html: string): string {
  let text = html

  for (const element of STRIP_ELEMENTS) {
    // The `s` flag rather than a `[\s\S]` class: inside a template literal
    // those escapes collapse to the character class `[sS]`, which matches
    // almost nothing and fails silently — the page keeps its CSS.
    text = text.replace(new RegExp(`<${element}\\b.*?</${element}>`, 'gis'), ' ')
  }
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')

  // Block elements become newlines so paragraph structure survives; without
  // this the whole page collapses into one unreadable line.
  text = text.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, '\n')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<li[^>]*>/gi, '\n- ')

  text = text.replace(/<[^>]+>/g, ' ')
  text = decodeEntities(text)

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, index, lines) => line || lines[index - 1])
    .join('\n')
    .trim()
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
}
