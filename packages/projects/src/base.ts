/**
 * The knowledge base: building an index over a tree, and answering questions
 * from it.
 */

import { readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { chunkFile, renderChunk, type Chunk, type ChunkOptions } from './chunk.ts'
import { Index, type ScoredChunk } from './retrieve.ts'

/** A NUL byte marks a binary file whatever its extension claims. */
const NUL = String.fromCharCode(0)

export interface KnowledgeBaseOptions {
  root: string
  /** Globs to include. Everything not matched is skipped. */
  include?: string[]
  /** Globs to exclude, applied after include. */
  exclude?: string[]
  /** Files larger than this are skipped. */
  maxFileBytes?: number
  /** Ceiling on files indexed, so one run cannot walk a whole disk. */
  maxFiles?: number
  chunking?: ChunkOptions
}

/**
 * Directories never walked.
 *
 * Not a performance tweak: indexing `node_modules` buries every real answer
 * under a hundred thousand chunks of dependency source.
 */
const SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', 'target', 'dist', 'build', '.next', '.turbo', '.cache', 'vendor',
  '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.gradle', 'Pods', 'coverage',
  '.svelte-kit', '.nuxt', 'out', 'bin', 'obj', '.idea', '.vscode',
])

const INDEXABLE = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'rs', 'py', 'go', 'java', 'kt', 'swift', 'rb', 'php',
  'c', 'h', 'cpp', 'hpp', 'cs', 'scala', 'sh', 'bash', 'sql', 'graphql', 'proto', 'md', 'mdx',
  'rst', 'txt', 'json', 'yaml', 'yml', 'toml', 'vue', 'svelte', 'astro',
])

export interface BuildProgress {
  filesSeen: number
  filesIndexed: number
  chunks: number
  currentPath?: string
}

export interface BuildResult {
  filesIndexed: number
  filesSkipped: number
  chunks: number
  durationMs: number
  /** Why files were skipped, counted by reason. */
  skipped: Record<string, number>
}

export interface Query {
  text: string
  limit?: number
  /** Restrict to paths matching this substring or glob. */
  pathFilter?: string
  /** Total characters of chunk text to return, so a caller can size a prompt. */
  maxChars?: number
}

export interface QueryResult {
  results: ScoredChunk[]
  /** The chunks rendered for a model, with citations. */
  context: string
  /** Total characters in `context`. */
  chars: number
  /** True when results were dropped to fit `maxChars`. */
  truncated: boolean
}

export class KnowledgeBase {
  private index = new Index()
  private readonly options: Required<Omit<KnowledgeBaseOptions, 'chunking'>> & {
    chunking: ChunkOptions
  }
  /** Path → mtime, so a rebuild can skip unchanged files. */
  private seen = new Map<string, number>()

  constructor(options: KnowledgeBaseOptions) {
    this.options = {
      root: options.root,
      include: options.include ?? [],
      exclude: options.exclude ?? [],
      maxFileBytes: options.maxFileBytes ?? 512 * 1024,
      maxFiles: options.maxFiles ?? 20_000,
      chunking: options.chunking ?? {},
    }
  }

  get size(): number {
    return this.index.size
  }

  get files(): string[] {
    return this.index.paths()
  }

  /**
   * Indexes the tree.
   *
   * Incremental by default: a file whose mtime has not changed keeps its
   * existing chunks. A full reindex of a large repository takes seconds, and
   * doing it on every question would make the feature unusable.
   */
  async build(onProgress?: (progress: BuildProgress) => void): Promise<BuildResult> {
    const started = Date.now()
    const skipped: Record<string, number> = {}
    const note = (reason: string) => {
      skipped[reason] = (skipped[reason] ?? 0) + 1
    }

    let filesSeen = 0
    let filesIndexed = 0
    let chunks = 0
    const present = new Set<string>()

    for await (const path of walk(this.options.root, this.options.maxFiles)) {
      filesSeen++
      const relativePath = toPosix(relative(this.options.root, path))
      present.add(relativePath)

      const extension = relativePath.split('.').pop()?.toLowerCase() ?? ''
      if (!INDEXABLE.has(extension)) {
        note('unsupported type')
        continue
      }

      if (!this.included(relativePath)) {
        note('filtered out')
        continue
      }

      let modified: number
      let size: number
      try {
        const info = await stat(path)
        modified = info.mtimeMs
        size = info.size
      } catch {
        note('unreadable')
        continue
      }

      if (size > this.options.maxFileBytes) {
        note('too large')
        continue
      }

      // Unchanged since the last build: keep the existing chunks.
      if (this.seen.get(relativePath) === modified) {
        continue
      }

      let source: string
      try {
        source = await readFile(path, 'utf8')
      } catch {
        note('unreadable')
        continue
      }

      // A file with a NUL byte is binary whatever its extension claims.
      if (source.includes(NUL)) {
        note('binary')
        continue
      }

      // Replacing a file's chunks means dropping the old ones first, or a
      // deleted function stays retrievable forever.
      this.index.removePath(relativePath)

      const produced = chunkFile(relativePath, source, this.options.chunking)
      for (const chunk of produced) this.index.add(chunk, modified)

      this.seen.set(relativePath, modified)
      filesIndexed++
      chunks += produced.length

      onProgress?.({ filesSeen, filesIndexed, chunks, currentPath: relativePath })
    }

    // Files that disappeared since the last build must leave the index too.
    for (const path of [...this.seen.keys()]) {
      if (!present.has(path)) {
        this.index.removePath(path)
        this.seen.delete(path)
      }
    }

    return {
      filesIndexed,
      filesSkipped: filesSeen - filesIndexed,
      chunks: this.index.size,
      durationMs: Date.now() - started,
      skipped,
    }
  }

  /** Adds a single file, for an incremental update after an edit. */
  addFile(path: string, source: string, modified = Date.now()): number {
    const relativePath = toPosix(path)
    this.index.removePath(relativePath)

    const produced = chunkFile(relativePath, source, this.options.chunking)
    for (const chunk of produced) this.index.add(chunk, modified)

    this.seen.set(relativePath, modified)
    return produced.length
  }

  removeFile(path: string): number {
    const relativePath = toPosix(path)
    this.seen.delete(relativePath)
    return this.index.removePath(relativePath)
  }

  /** Answers a query with ranked chunks and a rendered context block. */
  query(query: Query): QueryResult {
    const limit = query.limit ?? 8
    const maxChars = query.maxChars ?? 12_000

    // Over-fetch, then filter: filtering inside the ranking would need the
    // index to know about paths, and this keeps the ranking one concern.
    let results = this.index.search(query.text, limit * 4)

    if (query.pathFilter) {
      const filter = query.pathFilter.toLowerCase()
      results = results.filter((result) => matchesPath(result.chunk.path.toLowerCase(), filter))
    }

    results = results.slice(0, limit)

    const parts: string[] = []
    let chars = 0
    let truncated = false
    const kept: ScoredChunk[] = []

    for (const result of results) {
      const rendered = renderChunk(result.chunk)
      // Stopping at the budget rather than truncating the last chunk: half a
      // function is worse than one fewer result.
      if (chars + rendered.length > maxChars && kept.length > 0) {
        truncated = true
        break
      }
      parts.push(rendered)
      kept.push(result)
      chars += rendered.length + 2
    }

    return {
      results: kept,
      context: parts.join('\n\n'),
      chars,
      truncated: truncated || results.length > kept.length,
    }
  }

  /** Chunks containing every query term, for an exact lookup. */
  lookup(text: string): Chunk[] {
    return this.index.searchAllTerms(text)
  }

  private included(path: string): boolean {
    const { include, exclude } = this.options

    for (const pattern of exclude) {
      if (matchesPath(path, pattern)) return false
    }
    if (include.length === 0) return true
    return include.some((pattern) => matchesPath(path, pattern))
  }
}

/** Whether a path matches a glob or a plain substring. */
export function matchesPath(path: string, pattern: string): boolean {
  if (!/[*?[]/.test(pattern)) return path.includes(pattern)

  // `**` crosses separators, `*` does not — the distinction every .gitignore
  // and tsconfig relies on.
  const source = pattern
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*\*\//g, 'SLASH')
    .replace(/\*\*/g, 'DEEP')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/SLASH/g, '(?:.*/)?')
    .replace(/DEEP/g, '.*')

  try {
    return new RegExp(`^${source}$`).test(path)
  } catch {
    // A pattern that will not compile matches nothing rather than throwing
    // mid-index and losing the whole build.
    return false
  }
}

/** Yields every file under a root, skipping the directories nobody wants. */
async function* walk(root: string, maxFiles: number): AsyncGenerator<string> {
  const { readdir } = await import('node:fs/promises')
  const queue: string[] = [root]
  let yielded = 0

  while (queue.length > 0) {
    const directory = queue.shift()!

    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (yielded >= maxFiles) return

      const path = join(directory, entry.name)

      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue
        queue.push(path)
        continue
      }

      // A symlink is not followed: a link back up the tree makes the walk
      // infinite, and one pointing outside the root indexes the wrong thing.
      if (!entry.isFile()) continue

      yielded++
      yield path
    }
  }
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}
