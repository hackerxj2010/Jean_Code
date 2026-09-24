/**
 * The retrieval index: BM25 over chunks, with the boosts that make it work on
 * code rather than prose.
 *
 * BM25 ranks by how distinctive a term is. That is the right instinct for code
 * search — a query mentioning `hashline` should not be diluted by the word
 * `the` — but plain BM25 misses on two things a codebase makes constant:
 * identifiers are compound words, and not all files matter equally.
 */

import type { Chunk } from './chunk.ts'

/** Term-frequency saturation. Repetition stops helping past this. */
const K1 = 1.2

/** Length normalisation. 0.75 is the standard value. */
const B = 0.75

export interface IndexedChunk extends Chunk {
  /** Terms, cached so scoring does not re-tokenize. */
  terms: string[]
  /** File modification time, for the recency boost. Epoch milliseconds. */
  modified?: number
}

export interface ScoredChunk {
  chunk: IndexedChunk
  score: number
  /** Which query terms actually matched, for explaining a result. */
  matched: string[]
}

/**
 * Words carrying no retrieval signal.
 *
 * Includes the code-specific ones — `const`, `function`, `return` — that appear
 * in nearly every chunk of a TypeScript repository and would otherwise make
 * every chunk look equally relevant to a query containing them.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'of', 'to', 'in', 'on', 'at', 'by',
  'for', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these',
  'those', 'as', 'from', 'not', 'no', 'do', 'does', 'did', 'so', 'we', 'i', 'you', 'my', 'me',
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'default', 'new', 'class',
  'public', 'private', 'static', 'void', 'null', 'undefined', 'true', 'false', 'type',
])

/** Splits text into indexable terms. */
export function tokenize(text: string): string[] {
  const terms: string[] = []

  for (const raw of text.split(/[^A-Za-z0-9_$]+/)) {
    if (raw === '') continue

    const lower = raw.toLowerCase()
    if (lower.length < 2) continue

    if (!STOP_WORDS.has(lower)) terms.push(stem(lower))

    // The parts as well as the whole: a query for "agent loop" must find
    // `runAgentLoop`, and a query for the full name must still find it too.
    for (const part of splitIdentifier(raw)) {
      const lowered = part.toLowerCase()
      if (lowered.length >= 3 && lowered !== lower && !STOP_WORDS.has(lowered)) {
        terms.push(stem(lowered))
      }
    }
  }

  return terms
}

/** Splits `camelCase`, `PascalCase`, `snake_case`, and `SCREAMING_CASE`. */
export function splitIdentifier(word: string): string[] {
  const parts: string[] = []

  for (const chunk of word.split(/[_$-]+/)) {
    if (chunk === '') continue

    // A capital starts a new part, except in a run of capitals — `HTTPServer`
    // is `HTTP` and `Server`, not `H`, `T`, `T`, `P`, `Server`.
    let current = ''
    for (let index = 0; index < chunk.length; index++) {
      const character = chunk[index]!
      const previous = chunk[index - 1]
      const next = chunk[index + 1]

      const startsWord =
        current !== '' &&
        ((/[A-Z]/.test(character) && previous !== undefined && /[a-z0-9]/.test(previous)) ||
          (/[A-Z]/.test(character) &&
            previous !== undefined &&
            /[A-Z]/.test(previous) &&
            next !== undefined &&
            /[a-z]/.test(next)))

      if (startsWord) {
        parts.push(current)
        current = ''
      }
      current += character
    }
    if (current !== '') parts.push(current)
  }

  return parts
}

/**
 * A conservative suffix stemmer.
 *
 * Full Porter stemming turns "operating" into "oper" and hurts as often as it
 * helps. This collapses only the endings that reliably mean the same word.
 */
export function stem(word: string): string {
  if (word.length <= 3) return word

  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`
  if (/(?:ss|sh|ch|x|z)es$/.test(word)) return word.slice(0, -2)

  for (const suffix of ['ing', 'ed']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      const root = word.slice(0, -suffix.length)
      // `running` → `run`, not `runn`.
      if (root.length >= 2 && root[root.length - 1] === root[root.length - 2]) {
        return root.slice(0, -1)
      }
      return root
    }
  }

  // `s` last, and never after another `s` — `class` must not become `clas`.
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && word.length > 3) {
    return word.slice(0, -1)
  }

  return word
}

export class Index {
  /** term → chunk id → count */
  private postings = new Map<string, Map<string, number>>()
  private chunks = new Map<string, IndexedChunk>()
  private totalTerms = 0

  get size(): number {
    return this.chunks.size
  }

  /** Every path that has chunks indexed. */
  paths(): string[] {
    return [...new Set([...this.chunks.values()].map((chunk) => chunk.path))].sort()
  }

  add(chunk: Chunk, modified?: number): void {
    // Re-adding replaces: an unchanged chunk id re-indexes to the same entry
    // rather than double-counting its terms.
    this.remove(chunk.id)

    // The context line is indexed too, and weighted by repetition: the symbol a
    // chunk sits under is one of the strongest signals it has.
    const material = chunk.context
      ? `${chunk.path} ${chunk.context} ${chunk.context} ${chunk.text}`
      : `${chunk.path} ${chunk.text}`

    const terms = tokenize(material)
    const indexed: IndexedChunk = { ...chunk, terms, modified }

    for (const term of terms) {
      let documents = this.postings.get(term)
      if (!documents) {
        documents = new Map()
        this.postings.set(term, documents)
      }
      documents.set(chunk.id, (documents.get(chunk.id) ?? 0) + 1)
    }

    this.chunks.set(chunk.id, indexed)
    this.totalTerms += terms.length
  }

  remove(id: string): void {
    const existing = this.chunks.get(id)
    if (!existing) return

    for (const term of new Set(existing.terms)) {
      const documents = this.postings.get(term)
      if (!documents) continue
      documents.delete(id)
      // Empty postings are pruned, or the index grows forever across reindexes.
      if (documents.size === 0) this.postings.delete(term)
    }

    this.chunks.delete(id)
    this.totalTerms -= existing.terms.length
  }

  /** Removes every chunk from a path. */
  removePath(path: string): number {
    const ids = [...this.chunks.values()].filter((chunk) => chunk.path === path).map((c) => c.id)
    for (const id of ids) this.remove(id)
    return ids.length
  }

  get(id: string): IndexedChunk | undefined {
    return this.chunks.get(id)
  }

  /** Ranks chunks against a query. */
  search(query: string, limit = 10, now = Date.now()): ScoredChunk[] {
    if (this.chunks.size === 0) return []

    const queryTerms = tokenize(query)
    if (queryTerms.length === 0) return []

    const averageLength = this.totalTerms / this.chunks.size
    const count = this.chunks.size

    const scores = new Map<string, number>()
    const matched = new Map<string, Set<string>>()

    for (const term of new Set(queryTerms)) {
      const documents = this.postings.get(term)
      if (!documents) continue

      // Inverse document frequency: a term in every chunk contributes nothing.
      const appearances = documents.size
      const idf = Math.log((count - appearances + 0.5) / (appearances + 0.5) + 1)

      for (const [id, frequency] of documents) {
        const chunk = this.chunks.get(id)
        if (!chunk) continue

        const length = chunk.terms.length
        const saturated =
          (frequency * (K1 + 1)) / (frequency + K1 * (1 - B + (B * length) / Math.max(averageLength, 1)))

        scores.set(id, (scores.get(id) ?? 0) + idf * saturated)

        let seen = matched.get(id)
        if (!seen) {
          seen = new Set()
          matched.set(id, seen)
        }
        seen.add(term)
      }
    }

    const ranked: ScoredChunk[] = []
    for (const [id, base] of scores) {
      const chunk = this.chunks.get(id)
      if (!chunk) continue

      const boosted = base * pathBoost(chunk.path) * recencyBoost(chunk.modified, now) *
        coverageBoost(matched.get(id)?.size ?? 0, new Set(queryTerms).size)

      ranked.push({ chunk, score: boosted, matched: [...(matched.get(id) ?? [])] })
    }

    // Ties break by id so two runs of the same query agree.
    ranked.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
    return ranked.slice(0, limit)
  }

  /** Chunks containing every query term, for an exact lookup. */
  searchAllTerms(query: string): IndexedChunk[] {
    const terms = [...new Set(tokenize(query))]
    if (terms.length === 0) return []

    let candidates: Set<string> | undefined
    for (const term of terms) {
      const documents = this.postings.get(term)
      if (!documents) return []

      const ids = new Set(documents.keys())
      candidates = candidates ? new Set([...candidates].filter((id) => ids.has(id))) : ids
    }

    return [...(candidates ?? [])]
      .map((id) => this.chunks.get(id))
      .filter((chunk): chunk is IndexedChunk => chunk !== undefined)
      .sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine)
  }
}

/**
 * How much a path's location should count.
 *
 * A match in `src/` is nearly always more useful than one in a test fixture or
 * a vendored dependency, and without this the fixtures win — they are often
 * short, which BM25's length normalisation rewards.
 */
export function pathBoost(path: string): number {
  const lower = path.toLowerCase()

  if (/(?:^|\/)(?:node_modules|vendor|third_party|dist|build|target)\//.test(lower)) return 0.2
  if (/(?:^|\/)(?:fixtures?|__fixtures__|testdata|mocks?|snapshots?)\//.test(lower)) return 0.3
  if (/\.(?:min\.js|lock|map)$/.test(lower)) return 0.15
  if (/(?:^|\/)(?:tests?|spec|__tests__)\//.test(lower) || /\.(?:test|spec)\.[jt]sx?$/.test(lower)) {
    return 0.6
  }

  // Documentation ranks slightly above ordinary source for a "how does this
  // work" query, which is the query a knowledge base is asked most.
  if (/(?:^|\/)(?:readme|docs?|documentation)/.test(lower)) return 1.3
  if (/(?:^|\/)src\//.test(lower)) return 1.2

  return 1
}

/**
 * How much a file's age should count.
 *
 * Recency matters in a codebase in a way it does not in a document corpus: code
 * edited last week is more likely to be what someone is asking about than code
 * untouched for three years. The effect is deliberately mild — a factor of 1.3
 * at most — because an old, stable file is often exactly the right answer.
 */
export function recencyBoost(modified: number | undefined, now: number): number {
  if (modified === undefined) return 1

  const days = (now - modified) / 86_400_000
  if (days < 0) return 1
  if (days < 7) return 1.3
  if (days < 30) return 1.15
  if (days < 180) return 1
  return 0.9
}

/**
 * How much of the query a chunk matched.
 *
 * A chunk hitting three of three query terms is usually a better answer than
 * one hitting a single rare term nine times, and plain BM25 prefers the latter.
 */
export function coverageBoost(matchedTerms: number, queryTerms: number): number {
  if (queryTerms <= 1) return 1
  return 0.7 + 0.6 * (matchedTerms / queryTerms)
}
