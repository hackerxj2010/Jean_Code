/**
 * File extension to LSP language identifier.
 *
 * The identifiers are the ones in the LSP specification's `TextDocumentItem`
 * table; servers key their behaviour off them, so an approximation here shows
 * up later as a server that silently declines to analyze a file.
 */
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.abap': 'abap',
  '.astro': 'astro',
  '.bat': 'bat',
  '.bib': 'bibtex',
  '.c': 'c',
  '.cc': 'cpp',
  '.cjs': 'javascript',
  '.clj': 'clojure',
  '.cljc': 'clojure',
  '.cljs': 'clojure',
  '.coffee': 'coffeescript',
  '.cpp': 'cpp',
  '.cs': 'csharp',
  '.cshtml': 'razor',
  '.css': 'css',
  '.csx': 'csharp',
  '.cts': 'typescript',
  '.cxx': 'cpp',
  '.d': 'd',
  '.dart': 'dart',
  '.diff': 'diff',
  '.dockerfile': 'dockerfile',
  '.edn': 'clojure',
  '.erl': 'erlang',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.fs': 'fsharp',
  '.fsi': 'fsharp',
  '.fsscript': 'fsharp',
  '.fsx': 'fsharp',
  '.gd': 'gdscript',
  '.gleam': 'gleam',
  '.go': 'go',
  '.graphql': 'graphql',
  '.groovy': 'groovy',
  '.gql': 'graphql',
  '.h': 'c',
  '.handlebars': 'handlebars',
  '.hbs': 'handlebars',
  '.hh': 'cpp',
  '.hpp': 'cpp',
  '.hrl': 'erlang',
  '.hs': 'haskell',
  '.htm': 'html',
  '.html': 'html',
  '.hxx': 'cpp',
  '.ini': 'ini',
  '.java': 'java',
  '.jl': 'julia',
  '.js': 'javascript',
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.jsx': 'javascriptreact',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.latex': 'latex',
  '.less': 'less',
  '.lhs': 'haskell',
  '.lua': 'lua',
  '.m': 'objective-c',
  '.markdown': 'markdown',
  '.md': 'markdown',
  '.mjs': 'javascript',
  '.ml': 'ocaml',
  '.mli': 'ocaml',
  '.mm': 'objective-cpp',
  '.mts': 'typescript',
  '.nim': 'nim',
  '.nix': 'nix',
  '.pas': 'pascal',
  '.php': 'php',
  '.pl': 'perl',
  '.pm': 'perl',
  '.prisma': 'prisma',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.py': 'python',
  '.pyi': 'python',
  '.r': 'r',
  '.rake': 'ruby',
  '.razor': 'razor',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.sass': 'sass',
  '.scala': 'scala',
  '.scm': 'scheme',
  '.scss': 'scss',
  '.sh': 'shellscript',
  '.sql': 'sql',
  '.svelte': 'svelte',
  '.swift': 'swift',
  '.tex': 'latex',
  '.toml': 'toml',
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.vb': 'vb',
  '.vue': 'vue',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.zig': 'zig',
  '.zon': 'zig',
}

/** Files whose language is decided by name rather than extension. */
const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  'cargo.toml': 'toml',
  'go.mod': 'go.mod',
  'go.sum': 'go.sum',
}

/** The LSP language id for a path, or `undefined` when it is not known. */
export function languageOf(path: string): string | undefined {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  const byName = LANGUAGE_BY_NAME[name]
  if (byName) return byName

  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  return LANGUAGE_BY_EXTENSION[name.slice(dot)]
}

/** The file extension of a path, lowercased and including the dot. */
export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}
