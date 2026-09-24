/**
 * `@jean/codemap` — repository intelligence (architecture §8.3).
 *
 * Indexes what the codebase declares and where, so an agent can find the files
 * a task touches without reading them. In a large repository, locating the
 * handful of relevant files by reading is the single largest waste of context
 * an agent commits — and it usually finds the wrong ones.
 *
 * The architecture specifies tree-sitter; tree-sitter is a native dependency
 * and this build has none, so this is a per-language pattern scanner instead.
 * `@jean/lsp` provides exact resolution where it matters.
 */

export {
  extractImports,
  extractSymbols,
  languageForFile,
  supportedLanguages,
  type ExtractedSymbol,
  type SymbolKind,
} from './symbols.ts'

export {
  CodeMap,
  type FileEntry,
  type MapOptions,
  type SymbolHit,
} from './map.ts'

export {
  compilePattern,
  EXAMPLE_PATTERNS,
  matchInText,
  searchStructural,
  type PatternOptions,
  type StructuralMatch,
} from './structural.ts'

export { createCodeMapTools } from './tools.ts'
