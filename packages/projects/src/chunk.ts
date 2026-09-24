/**
 * Splitting a file into retrievable chunks.
 *
 * The naive approach — every N lines, or every N characters — is what makes
 * retrieval-augmented generation disappointing. A chunk that starts three lines
 * into a function and ends halfway through the next one retrieves as noise: the
 * embedding is of a fragment nobody wrote, and the model reading it cannot tell
 * what it belongs to.
 *
 * So chunks follow structure. Code splits at declaration boundaries, Markdown
 * splits at headings, and everything carries the context needed to make sense
 * standing alone — the file it came from, and the heading or symbol it sits
 * under.
 */

export interface Chunk {
  /** Stable across runs, so an unchanged file re-indexes to the same ids. */
  id: string
  path: string
  /** 1-based, inclusive. */
  startLine: number
  endLine: number
  text: string
  /** The symbol or heading this chunk sits under, for context. */
  context?: string
  kind: ChunkKind
}

export type ChunkKind = 'code' | 'prose' | 'config' | 'data'

export interface ChunkOptions {
  /** Target size in characters. Chunks may exceed it to avoid splitting a unit. */
  targetSize?: number
  /**
   * Hard ceiling. A single declaration longer than this is split, because one
   * 40 KB chunk crowds out everything else retrieved alongside it.
   */
  maxSize?: number
  /**
   * Lines repeated at the start of the next chunk.
   *
   * Overlap costs storage and buys recall: a fact stated at a boundary is
   * otherwise in neither chunk in a usable form.
   */
  overlapLines?: number
}

const DEFAULTS: Required<ChunkOptions> = {
  targetSize: 1200,
  maxSize: 4000,
  overlapLines: 2,
}

/** File extensions treated as prose. */
const PROSE = new Set(['md', 'mdx', 'markdown', 'rst', 'txt', 'adoc'])
const CONFIG = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'env', 'properties'])
const DATA = new Set(['csv', 'tsv', 'sql', 'graphql', 'proto'])

export function kindFor(path: string): ChunkKind {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  if (PROSE.has(extension)) return 'prose'
  if (CONFIG.has(extension)) return 'config'
  if (DATA.has(extension)) return 'data'
  return 'code'
}

/** Splits a file into chunks. */
export function chunkFile(path: string, source: string, options: ChunkOptions = {}): Chunk[] {
  const settings = { ...DEFAULTS, ...options }
  const kind = kindFor(path)

  if (source.trim() === '') return []

  const chunks = kind === 'prose' ? chunkProse(path, source, settings) : chunkCode(path, source, settings, kind)

  // A chunk that is only whitespace or a closing brace retrieves as noise and
  // dilutes every ranking it appears in.
  return chunks.filter((chunk) => hasSubstance(chunk.text))
}

function hasSubstance(text: string): boolean {
  const stripped = text.replace(/[\s{}()[\];,]/g, '')
  return stripped.length >= 12
}

/**
 * Splits prose at headings, then at paragraphs when a section is too long.
 *
 * The heading path is carried into every chunk beneath it: "Installation" alone
 * is ambiguous across a hundred repositories, and "Deployment > Rollback >
 * Installation" is not.
 */
function chunkProse(path: string, source: string, settings: Required<ChunkOptions>): Chunk[] {
  const lines = source.split('\n')
  const chunks: Chunk[] = []

  // Each entry is the heading text at that depth, so the path can be rebuilt.
  const headings: string[] = []
  let current: string[] = []
  let startLine = 1
  let context = ''

  const flush = (endLine: number) => {
    const text = current.join('\n').trim()
    if (text !== '') {
      chunks.push(...splitOversized(path, text, startLine, endLine, context, 'prose', settings))
    }
    current = []
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)

    if (heading) {
      flush(index)

      const depth = heading[1]!.length
      const title = heading[2]!.trim()
      // Truncating to the new depth is what keeps the path correct when a
      // document goes from an h3 back to an h2.
      headings.length = Math.min(headings.length, depth - 1)
      headings[depth - 1] = title

      context = headings.filter(Boolean).join(' > ')
      startLine = index + 1
      current.push(line)
      continue
    }

    current.push(line)

    // A section longer than the target splits at a blank line, which in prose
    // is a paragraph boundary.
    const size = current.join('\n').length
    if (size >= settings.targetSize && line.trim() === '') {
      flush(index + 1)
      startLine = index + 2
    }
  }

  flush(lines.length)
  return chunks
}

/**
 * Splits code at top-level declaration boundaries.
 *
 * Detected by indentation rather than by parsing: a line at column zero that
 * looks like a declaration starts a new unit. That is language-agnostic, works
 * on a file that does not compile, and is right often enough that the failure
 * mode is a slightly larger chunk rather than a wrong one.
 */
function chunkCode(
  path: string,
  source: string,
  settings: Required<ChunkOptions>,
  kind: ChunkKind,
): Chunk[] {
  const lines = source.split('\n')
  const chunks: Chunk[] = []

  let current: string[] = []
  let startLine = 1
  let context = ''

  const flush = (endLine: number) => {
    const text = current.join('\n').trimEnd()
    if (text.trim() !== '') {
      chunks.push(...splitOversized(path, text, startLine, endLine, context, kind, settings))
    }
    current = []
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const declaration = declarationName(line)

    // Start a new chunk at a top-level declaration, but only once the current
    // one has enough in it — otherwise a file of one-line exports becomes a
    // hundred chunks.
    const size = current.join('\n').length
    if (declaration && size >= settings.targetSize) {
      // The comment block immediately above a declaration belongs with it, not
      // with the previous chunk.
      const carried: string[] = []
      while (current.length > 0 && isCommentOrBlank(current[current.length - 1]!)) {
        carried.unshift(current.pop()!)
      }

      flush(index - carried.length)
      startLine = index + 1 - carried.length
      current = carried
      context = declaration
    } else if (declaration && context === '') {
      context = declaration
    }

    current.push(line)
  }

  flush(lines.length)
  return chunks
}

function isCommentOrBlank(line: string): boolean {
  const trimmed = line.trim()
  return (
    trimmed === '' ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('"""')
  )
}

/** The name declared by a top-level line, if it declares one. */
export function declarationName(line: string): string | undefined {
  // Must start at column zero: an indented `function` is a nested one, and
  // splitting there cuts its parent in half.
  if (line.length === 0 || /^\s/.test(line)) return undefined

  const patterns: RegExp[] = [
    /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([A-Za-z_$][\w$]*)/,
    /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/,
    /^(?:pub\s+)?(?:struct|enum|trait|impl|mod)\s+([A-Za-z_][\w]*)/,
    /^def\s+([A-Za-z_][\w]*)/,
    /^class\s+([A-Za-z_][\w]*)/,
    /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/,
    /^(?:public|private|protected)\s+[\w<>[\]]+\s+([A-Za-z_][\w]*)\s*\(/,
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(line)
    if (match?.[1]) return match[1]
  }
  return undefined
}

/** Splits a chunk that exceeds the ceiling, with overlap between the pieces. */
function splitOversized(
  path: string,
  text: string,
  startLine: number,
  endLine: number,
  context: string,
  kind: ChunkKind,
  settings: Required<ChunkOptions>,
): Chunk[] {
  if (text.length <= settings.maxSize) {
    return [make(path, text, startLine, endLine, context, kind)]
  }

  const lines = text.split('\n')
  const chunks: Chunk[] = []
  let current: string[] = []
  let pieceStart = startLine

  for (let index = 0; index < lines.length; index++) {
    current.push(lines[index]!)

    if (current.join('\n').length >= settings.maxSize) {
      const pieceEnd = startLine + index
      chunks.push(make(path, current.join('\n'), pieceStart, pieceEnd, context, kind))

      // Overlap: the last few lines start the next piece, so a statement
      // spanning the boundary is retrievable from at least one side.
      const overlap = current.slice(-settings.overlapLines)
      current = [...overlap]
      pieceStart = pieceEnd - overlap.length + 1
    }
  }

  if (current.join('\n').trim() !== '') {
    chunks.push(make(path, current.join('\n'), pieceStart, endLine, context, kind))
  }

  return chunks
}

function make(
  path: string,
  text: string,
  startLine: number,
  endLine: number,
  context: string,
  kind: ChunkKind,
): Chunk {
  return {
    id: chunkId(path, startLine, text),
    path,
    startLine,
    endLine: Math.max(endLine, startLine),
    text,
    context: context === '' ? undefined : context,
    kind,
  }
}

/**
 * A stable id from the path, position, and content.
 *
 * Content-derived so that re-indexing an unchanged file produces the same ids
 * and the index can skip it; position-derived so two identical chunks in one
 * file stay distinct.
 */
export function chunkId(path: string, startLine: number, text: string): string {
  let hash = 0x811c9dc5
  const material = `${path}:${startLine}:${text}`
  for (let index = 0; index < material.length; index++) {
    hash ^= material.charCodeAt(index)
    // FNV-1a's 32-bit prime, applied with shifts because JavaScript's `*`
    // loses precision above 2^53 and the multiply overflows into it.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Renders a chunk the way it is given to a model. */
export function renderChunk(chunk: Chunk): string {
  const location =
    chunk.startLine === chunk.endLine
      ? `${chunk.path}:${chunk.startLine}`
      : `${chunk.path}:${chunk.startLine}-${chunk.endLine}`

  // The header is not decoration: without it the model cannot cite where an
  // answer came from, and an uncitable answer is one the user cannot check.
  const header = chunk.context ? `${location} (${chunk.context})` : location
  return `--- ${header}\n${chunk.text}`
}
