/**
 * Symbol extraction (architecture §8.3).
 *
 * The architecture specifies tree-sitter with 50+ grammars. Tree-sitter is a
 * native dependency, and this build has none — so this is a per-language
 * pattern scanner instead, and it is worth being precise about the difference:
 * a real parser knows a declaration from a mention inside a string; this does
 * not, always.
 *
 * What makes it useful anyway is the job it does. A code map answers "where
 * does this repository define things" so an agent can navigate without reading
 * every file. A false positive there costs one wasted `read`; a parser would
 * cost a native build step on every platform. When exact resolution matters,
 * `@jean/lsp` already provides it — `lsp_definition` is the correct tool for
 * "where is this bound", and this is the correct tool for "what is here".
 */

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'constant'
  | 'variable'
  | 'module'
  | 'import'

export interface ExtractedSymbol {
  name: string
  kind: SymbolKind
  line: number
  /** True when the declaration is exported or public. */
  exported: boolean
  /** Enclosing class or module, when it can be determined from indentation. */
  container?: string
  /** The declaration line, trimmed — enough to show a signature. */
  signature: string
}

interface Pattern {
  regex: RegExp
  kind: SymbolKind
  /** Which capture group holds the name. */
  group?: number
  /** Treated as exported when this group is present. */
  exportGroup?: number
  /** Always exported, regardless of syntax (Go's capitalization rule handles this). */
  alwaysExported?: boolean
}

/**
 * Patterns per language.
 *
 * Anchored at the start of a line (allowing indentation) so a declaration is
 * distinguished from the same words appearing mid-expression. That single
 * constraint removes most of the false positives a naive scan would produce.
 */
const PATTERNS: Record<string, Pattern[]> = {
  typescript: [
    { regex: /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/, kind: 'function', group: 2, exportGroup: 1 },
    { regex: /^\s*(export\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: 'class', group: 2, exportGroup: 1 },
    { regex: /^\s*(export\s+)?interface\s+(\w+)/, kind: 'interface', group: 2, exportGroup: 1 },
    { regex: /^\s*(export\s+)?type\s+(\w+)\s*[=<]/, kind: 'type', group: 2, exportGroup: 1 },
    { regex: /^\s*(export\s+)?(?:const\s+)?enum\s+(\w+)/, kind: 'enum', group: 2, exportGroup: 1 },
    // An arrow function assigned to a const is a function declaration in
    // everything but syntax, and most modern code is written this way.
    { regex: /^\s*(export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/, kind: 'function', group: 2, exportGroup: 1 },
    { regex: /^\s*(export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*(?!.*\()/, kind: 'constant', group: 2, exportGroup: 1 },
    // A method inside a class body: indented, not a control keyword.
    { regex: /^\s{2,}(?:(public|private|protected)\s+)?(?:static\s+)?(?:async\s+)?(?:readonly\s+)?(\w+)\s*\(/, kind: 'method', group: 2 },
  ],

  javascript: [
    { regex: /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/, kind: 'function', group: 2, exportGroup: 1 },
    { regex: /^\s*(export\s+)?class\s+(\w+)/, kind: 'class', group: 2, exportGroup: 1 },
    { regex: /^\s*(export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/, kind: 'function', group: 2, exportGroup: 1 },
    { regex: /^\s{2,}(?:static\s+)?(?:async\s+)?(\w+)\s*\(/, kind: 'method', group: 1 },
  ],

  python: [
    { regex: /^\s*(?:async\s+)?def\s+(\w+)/, kind: 'function', group: 1 },
    { regex: /^\s*class\s+(\w+)/, kind: 'class', group: 1 },
    // A module-level constant, by the SCREAMING_CASE convention.
    { regex: /^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/, kind: 'constant', group: 1 },
  ],

  rust: [
    { regex: /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/, kind: 'function', group: 2, exportGroup: 1 },
    { regex: /^\s*(pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/, kind: 'struct', group: 2, exportGroup: 1 },
    { regex: /^\s*(pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/, kind: 'enum', group: 2, exportGroup: 1 },
    { regex: /^\s*(pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/, kind: 'trait', group: 2, exportGroup: 1 },
    { regex: /^\s*(pub(?:\([^)]*\))?\s+)?type\s+(\w+)/, kind: 'type', group: 2, exportGroup: 1 },
    { regex: /^\s*(pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(\w+)/, kind: 'constant', group: 2, exportGroup: 1 },
    { regex: /^\s*(pub(?:\([^)]*\))?\s+)?mod\s+(\w+)/, kind: 'module', group: 2, exportGroup: 1 },
  ],

  go: [
    // Go exports by capitalization, so `exported` is decided below rather than
    // by a syntax marker.
    { regex: /^func\s+(?:\([^)]*\)\s*)?(\w+)/, kind: 'function', group: 1, alwaysExported: true },
    { regex: /^type\s+(\w+)\s+struct/, kind: 'struct', group: 1, alwaysExported: true },
    { regex: /^type\s+(\w+)\s+interface/, kind: 'interface', group: 1, alwaysExported: true },
    { regex: /^type\s+(\w+)/, kind: 'type', group: 1, alwaysExported: true },
    { regex: /^(?:const|var)\s+(\w+)/, kind: 'constant', group: 1, alwaysExported: true },
  ],

  java: [
    { regex: /^\s*(public\s+)?(?:abstract\s+|final\s+)?class\s+(\w+)/, kind: 'class', group: 2, exportGroup: 1 },
    { regex: /^\s*(public\s+)?interface\s+(\w+)/, kind: 'interface', group: 2, exportGroup: 1 },
    { regex: /^\s*(public\s+)?enum\s+(\w+)/, kind: 'enum', group: 2, exportGroup: 1 },
    { regex: /^\s{2,}(public|private|protected)?\s*(?:static\s+)?(?:final\s+)?[\w<>[\],\s]+\s+(\w+)\s*\(/, kind: 'method', group: 2 },
  ],

  ruby: [
    { regex: /^\s*def\s+(?:self\.)?(\w+)/, kind: 'function', group: 1 },
    { regex: /^\s*class\s+(\w+)/, kind: 'class', group: 1 },
    { regex: /^\s*module\s+(\w+)/, kind: 'module', group: 1 },
    { regex: /^\s*([A-Z][A-Z0-9_]*)\s*=/, kind: 'constant', group: 1 },
  ],

  php: [
    { regex: /^\s*(public\s+|private\s+|protected\s+)?function\s+(\w+)/, kind: 'function', group: 2, exportGroup: 1 },
    { regex: /^\s*(abstract\s+|final\s+)?class\s+(\w+)/, kind: 'class', group: 2 },
    { regex: /^\s*interface\s+(\w+)/, kind: 'interface', group: 1 },
    { regex: /^\s*trait\s+(\w+)/, kind: 'trait', group: 1 },
  ],

  c: [
    { regex: /^[\w*\s]+\s+\*?(\w+)\s*\([^;]*\)\s*\{/, kind: 'function', group: 1 },
    { regex: /^typedef\s+struct\s*\{?[^}]*\}?\s*(\w+)\s*;/, kind: 'struct', group: 1 },
    { regex: /^struct\s+(\w+)\s*\{/, kind: 'struct', group: 1 },
    { regex: /^enum\s+(\w+)\s*\{/, kind: 'enum', group: 1 },
    { regex: /^#define\s+(\w+)/, kind: 'constant', group: 1 },
  ],

  csharp: [
    { regex: /^\s*(public\s+|internal\s+)?(?:abstract\s+|sealed\s+|static\s+)?class\s+(\w+)/, kind: 'class', group: 2, exportGroup: 1 },
    { regex: /^\s*(public\s+|internal\s+)?interface\s+(\w+)/, kind: 'interface', group: 2, exportGroup: 1 },
    { regex: /^\s*(public\s+|internal\s+)?struct\s+(\w+)/, kind: 'struct', group: 2, exportGroup: 1 },
    { regex: /^\s*(public\s+|internal\s+)?enum\s+(\w+)/, kind: 'enum', group: 2, exportGroup: 1 },
    { regex: /^\s{2,}(public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?[\w<>[\],?\s]+\s+(\w+)\s*\(/, kind: 'method', group: 2, exportGroup: 1 },
  ],

  swift: [
    { regex: /^\s*(public\s+|open\s+)?(?:static\s+)?func\s+(\w+)/, kind: 'function', group: 2, exportGroup: 1 },
    { regex: /^\s*(public\s+|open\s+)?(?:final\s+)?class\s+(\w+)/, kind: 'class', group: 2, exportGroup: 1 },
    { regex: /^\s*(public\s+)?struct\s+(\w+)/, kind: 'struct', group: 2, exportGroup: 1 },
    { regex: /^\s*(public\s+)?protocol\s+(\w+)/, kind: 'interface', group: 2, exportGroup: 1 },
    { regex: /^\s*(public\s+)?enum\s+(\w+)/, kind: 'enum', group: 2, exportGroup: 1 },
  ],

  kotlin: [
    { regex: /^\s*(public\s+)?(?:suspend\s+)?fun\s+(\w+)/, kind: 'function', group: 2, exportGroup: 1 },
    { regex: /^\s*(public\s+)?(?:data\s+|sealed\s+|abstract\s+)?class\s+(\w+)/, kind: 'class', group: 2, exportGroup: 1 },
    { regex: /^\s*(public\s+)?interface\s+(\w+)/, kind: 'interface', group: 2, exportGroup: 1 },
    { regex: /^\s*(public\s+)?object\s+(\w+)/, kind: 'class', group: 2, exportGroup: 1 },
  ],

  elixir: [
    { regex: /^\s*def\s+(\w+)/, kind: 'function', group: 1 },
    { regex: /^\s*defp\s+(\w+)/, kind: 'function', group: 1 },
    { regex: /^\s*defmodule\s+([\w.]+)/, kind: 'module', group: 1 },
  ],

  lua: [
    { regex: /^\s*(?:local\s+)?function\s+([\w.:]+)/, kind: 'function', group: 1 },
    { regex: /^\s*([\w.]+)\s*=\s*function/, kind: 'function', group: 1 },
  ],

  shell: [
    { regex: /^\s*(?:function\s+)?(\w+)\s*\(\s*\)\s*\{/, kind: 'function', group: 1 },
    { regex: /^([A-Z][A-Z0-9_]*)=/, kind: 'constant', group: 1 },
  ],
}

/**
 * Words that syntactically look like a declaration but are not one.
 *
 * `super(...)` and `if (...)` both match a "name followed by a paren" pattern.
 * Without this the index fills with entries for control flow, which is worse
 * than useless: it makes the symbol search return noise for common words.
 */
const NOT_DECLARATIONS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else', 'match',
  'with', 'try', 'super', 'this', 'typeof', 'await', 'new', 'throw', 'yield',
  'delete', 'void', 'in', 'of', 'case', 'default', 'function', 'class',
  'const', 'let', 'var', 'import', 'export', 'from', 'as', 'and', 'or', 'not',
  'print', 'assert', 'lambda', 'pass', 'raise', 'elif', 'except', 'finally',
  'defer', 'go', 'select', 'range', 'break', 'continue', 'when', 'unless',
])

/** Which pattern set applies to a file. */
export function languageForFile(path: string): string | undefined {
  const extension = (path.match(/\.[^.\\/]+$/)?.[0] ?? '').toLowerCase()

  const byExtension: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python', '.pyi': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.rb': 'ruby', '.rake': 'ruby',
    '.php': 'php',
    '.c': 'c', '.h': 'c', '.cpp': 'c', '.cc': 'c', '.hpp': 'c', '.cxx': 'c',
    '.cs': 'csharp',
    '.swift': 'swift',
    '.kt': 'kotlin', '.kts': 'kotlin',
    '.ex': 'elixir', '.exs': 'elixir',
    '.lua': 'lua',
    '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  }

  return byExtension[extension]
}

/** Languages with a pattern set. */
export function supportedLanguages(): string[] {
  return Object.keys(PATTERNS).sort()
}

/**
 * Extracts symbols from source text.
 *
 * Comments and string-only lines are skipped first, which is where most false
 * positives would otherwise come from — a commented-out function reads exactly
 * like a real one to a pattern.
 */
export function extractSymbols(text: string, language: string): ExtractedSymbol[] {
  const patterns = PATTERNS[language]
  if (!patterns) return []

  const out: ExtractedSymbol[] = []
  const lines = text.split('\n')

  /** Tracks the innermost class, by indentation, so methods get a container. */
  let container: { name: string; indent: number } | undefined
  let inBlockComment = false

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()

    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false
      continue
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true
      continue
    }
    if (
      !trimmed ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('--')
    ) {
      // `#` is a comment nearly everywhere, but a Python decorator and a C
      // preprocessor directive both start with it and one of those declares a
      // constant, so `#define` is let through.
      if (!/^#define\s/.test(trimmed)) continue
    }

    const indent = line.length - line.trimStart().length
    if (container && indent <= container.indent) container = undefined

    for (const pattern of patterns) {
      const match = pattern.regex.exec(line)
      if (!match) continue

      const name = match[pattern.group ?? 1]
      if (!name) continue

      if (NOT_DECLARATIONS.has(name)) continue

      const exported = pattern.alwaysExported
        ? // Go and friends export by capitalization.
          /^[A-Z]/.test(name)
        : Boolean(pattern.exportGroup && match[pattern.exportGroup])

      out.push({
        name,
        kind: pattern.kind,
        line: index + 1,
        exported,
        container: container?.name,
        signature: trimmed.slice(0, 200),
      })

      if (pattern.kind === 'class' || pattern.kind === 'interface' || pattern.kind === 'module') {
        container = { name, indent }
      }
      // One symbol per line: the patterns overlap by design (a `const` that is
      // an arrow function matches both the function and constant rules), and
      // the earlier, more specific pattern should win.
      break
    }
  }

  return out
}

/** Import statements, for building a dependency graph. */
export function extractImports(text: string, language: string): string[] {
  const out = new Set<string>()

  const patterns: Record<string, RegExp[]> = {
    typescript: [/^\s*import\s+.*?from\s+['"]([^'"]+)['"]/gm, /require\(['"]([^'"]+)['"]\)/g],
    javascript: [/^\s*import\s+.*?from\s+['"]([^'"]+)['"]/gm, /require\(['"]([^'"]+)['"]\)/g],
    python: [/^\s*from\s+([\w.]+)\s+import/gm, /^\s*import\s+([\w.]+)/gm],
    rust: [/^\s*use\s+([\w:]+)/gm],
    go: [/^\s*"([^"]+)"\s*$/gm],
    java: [/^\s*import\s+([\w.]+);/gm],
    ruby: [/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm],
  }

  for (const regex of patterns[language] ?? []) {
    // A global regex carries lastIndex between calls, so it is reset here.
    regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      if (match[1]) out.add(match[1])
    }
  }

  return [...out]
}
