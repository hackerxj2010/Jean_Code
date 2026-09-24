import { readFile, stat } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import { walk } from '@jean/tools'
import {
  extractImports,
  extractSymbols,
  languageForFile,
  type ExtractedSymbol,
  type SymbolKind,
} from './symbols.ts'

/**
 * The repository code map (architecture §8.3).
 *
 * Scans the whole codebase once and keeps an index of what is declared where.
 * The point is to make "which files matter for this task" answerable without
 * reading them: a 2,000-file repository has perhaps six files relevant to any
 * given change, and finding them by reading is the single largest waste of
 * context an agent commits.
 */

export interface FileEntry {
  path: string
  language: string
  lines: number
  size: number
  symbols: ExtractedSymbol[]
  imports: string[]
  /** Modification time, so a rescan can skip unchanged files. */
  mtimeMs: number
}

export interface MapOptions {
  root: string
  /** Files larger than this are indexed by name only. */
  maxFileBytes?: number
  maxFiles?: number
  signal?: AbortSignal
  onProgress?: (scanned: number) => void
}

export interface SymbolHit {
  name: string
  kind: SymbolKind
  path: string
  line: number
  exported: boolean
  container?: string
  signature: string
}

export class CodeMap {
  private readonly files = new Map<string, FileEntry>()
  /** Symbol name to the files declaring it, for O(1) lookup by name. */
  private readonly byName = new Map<string, Set<string>>()
  private readonly root: string
  private built = false

  constructor(root: string) {
    this.root = root
  }

  /**
   * Scans the repository.
   *
   * Incremental: a file whose mtime and size are unchanged keeps its existing
   * entry rather than being re-read and re-scanned. On a large repository that
   * turns a rescan from seconds into milliseconds.
   */
  async build(options: Omit<MapOptions, 'root'> = {}): Promise<{ files: number; symbols: number }> {
    const maxBytes = options.maxFileBytes ?? 1_000_000
    const maxFiles = options.maxFiles ?? 20_000

    const seen = new Set<string>()
    let scanned = 0

    for await (const entry of walk(this.root, { signal: options.signal })) {
      if (entry.isDir) continue
      if (scanned >= maxFiles) break

      const language = languageForFile(entry.relPath)
      if (!language) continue

      seen.add(entry.relPath)
      scanned++
      if (scanned % 200 === 0) options.onProgress?.(scanned)

      const existing = this.files.get(entry.relPath)
      if (existing && existing.size === entry.size) {
        const info = await stat(entry.absPath).catch(() => undefined)
        if (info && info.mtimeMs === existing.mtimeMs) continue
      }

      if (entry.size > maxBytes) {
        // Indexed by name only: a generated bundle has thousands of "symbols"
        // and none of them are worth an agent's attention.
        this.setEntry({
          path: entry.relPath,
          language,
          lines: 0,
          size: entry.size,
          symbols: [],
          imports: [],
          mtimeMs: 0,
        })
        continue
      }

      const text = await readFile(entry.absPath, 'utf8').catch(() => undefined)
      if (text === undefined) continue

      const info = await stat(entry.absPath).catch(() => undefined)
      this.setEntry({
        path: entry.relPath,
        language,
        lines: text.split('\n').length,
        size: entry.size,
        symbols: extractSymbols(text, language),
        imports: extractImports(text, language),
        mtimeMs: info?.mtimeMs ?? 0,
      })
    }

    // Drop files that no longer exist, so a deleted file stops being suggested.
    for (const path of [...this.files.keys()]) {
      if (!seen.has(path)) this.remove(path)
    }

    this.built = true
    return { files: this.files.size, symbols: this.symbolCount() }
  }

  private setEntry(entry: FileEntry): void {
    this.remove(entry.path)
    this.files.set(entry.path, entry)

    for (const symbol of entry.symbols) {
      const key = symbol.name.toLowerCase()
      const set = this.byName.get(key) ?? new Set()
      set.add(entry.path)
      this.byName.set(key, set)
    }
  }

  private remove(path: string): void {
    const existing = this.files.get(path)
    if (!existing) return

    for (const symbol of existing.symbols) {
      const key = symbol.name.toLowerCase()
      const set = this.byName.get(key)
      if (!set) continue
      set.delete(path)
      if (set.size === 0) this.byName.delete(key)
    }
    this.files.delete(path)
  }

  /** Re-scans one file, after an edit. */
  async refresh(absolutePath: string): Promise<void> {
    const relPath = relative(this.root, absolutePath).split(sep).join('/')
    const language = languageForFile(relPath)
    if (!language) return

    const text = await readFile(absolutePath, 'utf8').catch(() => undefined)
    if (text === undefined) {
      this.remove(relPath)
      return
    }

    const info = await stat(absolutePath).catch(() => undefined)
    this.setEntry({
      path: relPath,
      language,
      lines: text.split('\n').length,
      size: info?.size ?? text.length,
      symbols: extractSymbols(text, language),
      imports: extractImports(text, language),
      mtimeMs: info?.mtimeMs ?? 0,
    })
  }

  get isBuilt(): boolean {
    return this.built
  }

  fileCount(): number {
    return this.files.size
  }

  symbolCount(): number {
    let total = 0
    for (const entry of this.files.values()) total += entry.symbols.length
    return total
  }

  /**
   * Finds symbols by name.
   *
   * Exact matches first, then prefix, then substring. An agent searching for
   * `RateLimiter` wants the class before it wants `RateLimiterOptions`, and
   * ranking by match quality is what makes the first result usually right.
   */
  findSymbol(query: string, limit = 40): SymbolHit[] {
    const needle = query.toLowerCase()
    const exact: SymbolHit[] = []
    const prefix: SymbolHit[] = []
    const substring: SymbolHit[] = []

    for (const entry of this.files.values()) {
      for (const symbol of entry.symbols) {
        const name = symbol.name.toLowerCase()
        const hit: SymbolHit = { ...symbol, path: entry.path }

        if (name === needle) exact.push(hit)
        else if (name.startsWith(needle)) prefix.push(hit)
        else if (name.includes(needle)) substring.push(hit)
      }
    }

    // Exported symbols first within each tier: a public API is more likely to
    // be what was meant than a private helper of the same name.
    const byExport = (a: SymbolHit, b: SymbolHit) => Number(b.exported) - Number(a.exported)
    return [...exact.sort(byExport), ...prefix.sort(byExport), ...substring.sort(byExport)].slice(
      0,
      limit,
    )
  }

  /** Every symbol declared in one file. */
  symbolsIn(path: string): ExtractedSymbol[] {
    return this.files.get(normalize(path))?.symbols ?? []
  }

  /** The indexed entry for a file. */
  entry(path: string): FileEntry | undefined {
    return this.files.get(normalize(path))
  }

  /**
   * Ranks files by relevance to a natural-language query.
   *
   * The heuristic that matters: a symbol name appearing in the query is a much
   * stronger signal than the same word appearing in a path, because a developer
   * describing a task names the things it touches.
   */
  relevantFiles(query: string, limit = 15): { path: string; score: number; why: string }[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((term) => term.length > 2)

    if (terms.length === 0) return []

    const scored: { path: string; score: number; why: string }[] = []

    for (const entry of this.files.values()) {
      let score = 0
      const reasons: string[] = []

      const pathLower = entry.path.toLowerCase()
      for (const term of terms) {
        if (pathLower.includes(term)) {
          score += 2
          reasons.push(`path matches "${term}"`)
        }
      }

      const matchedSymbols: string[] = []
      for (const symbol of entry.symbols) {
        const name = symbol.name.toLowerCase()
        for (const term of terms) {
          if (name === term) {
            score += 10
            matchedSymbols.push(symbol.name)
          } else if (name.includes(term) && term.length > 3) {
            score += 4
            matchedSymbols.push(symbol.name)
          }
        }
      }

      if (matchedSymbols.length > 0) {
        const unique = [...new Set(matchedSymbols)].slice(0, 3)
        reasons.push(`declares ${unique.join(', ')}`)
      }

      // A tie-break, not a signal: among equally relevant files, the smaller one
      // is cheaper to read and more likely to be the specific thing.
      if (score > 0 && entry.lines > 0) score += Math.max(0, 2 - entry.lines / 500)

      if (score > 0) scored.push({ path: entry.path, score, why: reasons.join('; ') })
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /** Files importing a given module path. */
  importersOf(module: string): string[] {
    const out: string[] = []
    for (const entry of this.files.values()) {
      if (entry.imports.some((i) => i === module || i.endsWith(`/${module}`))) {
        out.push(entry.path)
      }
    }
    return out.sort()
  }

  /** A per-language and per-directory summary, for orienting in a new repository. */
  overview(): {
    languages: { language: string; files: number; lines: number }[]
    directories: { path: string; files: number }[]
    totalFiles: number
    totalLines: number
    totalSymbols: number
  } {
    const languages = new Map<string, { files: number; lines: number }>()
    const directories = new Map<string, number>()
    let totalLines = 0

    for (const entry of this.files.values()) {
      const language = languages.get(entry.language) ?? { files: 0, lines: 0 }
      language.files++
      language.lines += entry.lines
      languages.set(entry.language, language)
      totalLines += entry.lines

      // Two levels deep: one is too coarse in a monorepo, three is noise.
      const parts = entry.path.split('/')
      const directory = parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') : '.'
      directories.set(directory, (directories.get(directory) ?? 0) + 1)
    }

    return {
      languages: [...languages.entries()]
        .map(([language, counts]) => ({ language, ...counts }))
        .sort((a, b) => b.lines - a.lines),
      directories: [...directories.entries()]
        .map(([path, files]) => ({ path, files }))
        .sort((a, b) => b.files - a.files)
        .slice(0, 25),
      totalFiles: this.files.size,
      totalLines,
      totalSymbols: this.symbolCount(),
    }
  }

  /** Every indexed file path. */
  paths(): string[] {
    return [...this.files.keys()].sort()
  }
}

function normalize(path: string): string {
  return path.split(sep).join('/').replace(/^\.\//, '')
}
