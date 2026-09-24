import { displayPath, resolveInWorkspace, ToolError, type Tool, type ToolResult } from '@jean/tools'
import type { CodeMap } from './map.ts'
import { nativeReady } from '@jean/native'
import { languageForFile, supportedLanguages } from './symbols.ts'
import { EXAMPLE_PATTERNS, searchStructural } from './structural.ts'

/**
 * Code-map tools (architecture §8.3).
 *
 * `codemap_find` is the one that changes how an agent works: it answers "which
 * files matter for this task" from an index rather than by reading. In a large
 * repository, finding the six relevant files by reading is the single largest
 * waste of context an agent commits, and it usually gets the wrong six.
 */

export function createCodeMapTools(map: CodeMap, ensureBuilt: () => Promise<void>): Tool[] {
  const findTool: Tool<{ query: string; limit?: number }> = {
    name: 'codemap_find',
    risk: 'read',
    description: [
      'Find the files relevant to a task, from an index of the whole repository.',
      '',
      'Use this first, before reading anything, when you do not already know where',
      'the relevant code lives. Describe the task in words — "the rate limiter',
      'middleware", "where sessions are persisted" — and it ranks files by the',
      'symbols they declare, not just by filename.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for, in words.' },
        limit: { type: 'integer', description: 'Maximum files to return. Default 15.' },
      },
      required: ['query'],
    },
    summarize: (args) => `codemap ${args.query.slice(0, 60)}`,

    async execute(args): Promise<ToolResult> {
      await ensureBuilt()

      const results = map.relevantFiles(args.query, args.limit ?? 15)
      if (results.length === 0) {
        return {
          output: [
            `Nothing in the index matches "${args.query}".`,
            '',
            `The index holds ${map.fileCount()} files and ${map.symbolCount()} symbols. Try different words, or use \`grep\` to search file contents directly.`,
          ].join('\n'),
        }
      }

      const lines = results.map((result) => `  ${result.path}\n      ${result.why}`)
      return {
        output: `${results.length} relevant file${results.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}`,
        display: { kind: 'codemap', count: results.length },
      }
    },
  }

  const symbolTool: Tool<{ name: string; limit?: number }> = {
    name: 'codemap_symbol',
    risk: 'read',
    description: [
      'Find where a symbol is declared, by name, across the repository.',
      '',
      'Faster than `grep` for this and far less noisy — it returns declarations,',
      'not every line mentioning the name. When you need the binding a reference',
      'actually resolves to, use `lsp_definition` instead.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name, or part of one.' },
        limit: { type: 'integer', description: 'Maximum results. Default 40.' },
      },
      required: ['name'],
    },
    summarize: (args) => `symbol ${args.name}`,

    async execute(args): Promise<ToolResult> {
      await ensureBuilt()

      const hits = map.findSymbol(args.name, args.limit ?? 40)
      if (hits.length === 0) {
        return { output: `No symbol matching "${args.name}" is declared in the indexed files.` }
      }

      const lines = hits.map((hit) => {
        const scope = hit.exported ? '' : ' (private)'
        const container = hit.container ? ` in ${hit.container}` : ''
        return `  ${hit.kind.padEnd(10)} ${hit.name}${container}${scope}\n      ${hit.path}:${hit.line}  ${hit.signature.slice(0, 100)}`
      })

      return {
        output: `${hits.length} declaration${hits.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}`,
        display: { kind: 'codemap', count: hits.length },
      }
    },
  }

  const outlineTool: Tool<{ path: string }> = {
    name: 'codemap_outline',
    risk: 'read',
    description: [
      "Outline a file's declarations without reading it.",
      '',
      'A cheap way to decide whether a file is worth reading, and where in it to',
      'look. Reading a 2,000-line file to find one function costs far more context',
      'than this does.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File to outline.' } },
      required: ['path'],
    },
    summarize: (args) => `outline ${args.path}`,

    async execute(args, context): Promise<ToolResult> {
      const absolute = resolveInWorkspace(args.path, context)
      const shown = displayPath(absolute, context)

      // The `pi-ast` outline reads just this file, for the languages it
      // tokenizes: no index to build first, and members nested by bracket
      // depth rather than guessed from indentation.
      const outlined = await nativeOutline(absolute, shown)
      if (outlined) return outlined

      await ensureBuilt()
      const entry = map.entry(shown)
      if (!entry) {
        return {
          output: `${shown} is not in the index. It may be a language the code map does not cover (${supportedLanguages().join(', ')}), or excluded by .gitignore.`,
        }
      }

      if (entry.symbols.length === 0) {
        return { output: `${shown} (${entry.lines} lines) declares no symbols the scanner recognizes.` }
      }

      const lines = entry.symbols.map((symbol) => {
        const indent = symbol.container ? '    ' : '  '
        const scope = symbol.exported ? '' : ' (private)'
        return `${indent}${String(symbol.line).padStart(5)}  ${symbol.kind.padEnd(10)} ${symbol.name}${scope}`
      })

      return {
        output: `${shown} — ${entry.lines} lines, ${entry.symbols.length} symbols:\n\n${lines.join('\n')}`,
        display: { kind: 'codemap', count: entry.symbols.length },
      }
    },
  }

  const overviewTool: Tool<Record<string, never>> = {
    name: 'codemap_overview',
    risk: 'read',
    description: [
      'Summarize the repository: languages, sizes, and where the code lives.',
      '',
      'Run this once when starting work in an unfamiliar codebase, before reading',
      'anything. It costs one call and tells you the shape of the project.',
    ].join('\n'),
    parameters: { type: 'object', properties: {} },
    summarize: () => 'repository overview',

    async execute(): Promise<ToolResult> {
      await ensureBuilt()
      const overview = map.overview()

      if (overview.totalFiles === 0) {
        return { output: 'The index is empty — no files in a language the code map covers.' }
      }

      const languages = overview.languages
        .map((l) => `  ${l.language.padEnd(12)} ${String(l.files).padStart(5)} files  ${l.lines.toLocaleString()} lines`)
        .join('\n')

      const directories = overview.directories
        .slice(0, 15)
        .map((d) => `  ${d.path.padEnd(36)} ${d.files} files`)
        .join('\n')

      return {
        output: [
          `${overview.totalFiles} files, ${overview.totalLines.toLocaleString()} lines, ${overview.totalSymbols.toLocaleString()} symbols.`,
          '',
          'Languages:',
          languages,
          '',
          'Where the code is:',
          directories,
        ].join('\n'),
        display: { kind: 'codemap', count: overview.totalFiles },
      }
    },
  }

  const importersTool: Tool<{ module: string }> = {
    name: 'codemap_importers',
    risk: 'read',
    description:
      'List the files importing a module. Use it before changing a module’s public shape, to see who would be affected.',
    parameters: {
      type: 'object',
      properties: { module: { type: 'string', description: 'Module path or package name.' } },
      required: ['module'],
    },
    summarize: (args) => `importers of ${args.module}`,

    async execute(args): Promise<ToolResult> {
      await ensureBuilt()

      const importers = map.importersOf(args.module)
      if (importers.length === 0) {
        return { output: `Nothing indexed imports "${args.module}".` }
      }

      return {
        output: `${importers.length} file${importers.length === 1 ? '' : 's'} import "${args.module}":\n${importers.map((p) => `  ${p}`).join('\n')}`,
        display: { kind: 'codemap', count: importers.length },
      }
    },
  }

  const structuralTool: Tool<{ pattern: string; language?: string; limit?: number }> = {
    name: 'ast_grep',
    risk: 'read',
    description: [
      'Search code by structure rather than by text.',
      '',
      '`$NAME` captures one expression, `$$$` matches any run of arguments.',
      'Whitespace is flexible, so `catch ($E) {}` finds `catch(err){}` too —',
      'which plain `grep` cannot, because it matches characters and this matches',
      'shape.',
      '',
      `Examples: ${EXAMPLE_PATTERNS.slice(0, 4)
        .map((example) => `${example.pattern} (${example.finds})`)
        .join(', ')}`,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The structural pattern.' },
        language: { type: 'string', description: 'Restrict to one language.' },
        limit: { type: 'integer', description: 'Maximum matches. Default 200.' },
      },
      required: ['pattern'],
    },
    summarize: (args) => `ast-grep ${args.pattern.slice(0, 50)}`,

    async execute(args, context): Promise<ToolResult> {
      const matches = await searchStructural(context.cwd, args.pattern, {
        language: args.language,
        limit: args.limit ?? 200,
        signal: context.signal,
      })

      if (matches.length === 0) {
        return {
          output: `No code matches \`${args.pattern}\`.

Patterns match structure: \`$NAME\` captures one expression, \`$$$\` matches any run. Nested structure needs a real parser and is not supported.`,
        }
      }

      const lines = matches.slice(0, 60).map((match) => {
        const captured = Object.entries(match.captures)
          .map(([name, value]) => `${name}=${value}`)
          .join(' ')
        return `  ${match.path}:${match.line}  ${match.text}${captured ? `
      ${captured}` : ''}`
      })

      if (matches.length > 60) lines.push(`  ... ${matches.length - 60} more`)
      return {
        output: [`${matches.length} matches:`, '', ...lines].join('\n'),
        display: { kind: 'codemap', count: matches.length },
      }
    },
  }

  return [
    structuralTool as Tool,
    findTool as Tool,
    symbolTool as Tool,
    outlineTool as Tool,
    overviewTool as Tool,
    importersTool as Tool,
  ]
}

/** Thrown when the index cannot be built at all. */
/** Languages the `pi-ast` tokenizer knows; others go to the index. */
const NATIVE_OUTLINE = new Set(['typescript', 'javascript', 'python', 'rust', 'go', 'shell'])

async function nativeOutline(absolute: string, shown: string): Promise<ToolResult | undefined> {
  const language = languageForFile(absolute)
  if (!language || !NATIVE_OUTLINE.has(language)) return undefined
  const native = await nativeReady()
  if (!native) return undefined

  let rendered: string
  try {
    rendered = (await native.outline(absolute)).trimEnd()
  } catch {
    return undefined
  }
  const count = rendered === '' ? 0 : rendered.split('\n').length
  if (count === 0) {
    return { output: `${shown} declares no symbols the outliner recognizes.` }
  }
  return {
    output: `${shown} — ${count} declaration${count === 1 ? '' : 's'} (· marks private):\n\n${rendered}`,
    display: { kind: 'codemap', count },
  }
}

export function indexUnavailable(reason: string): never {
  throw new ToolError(
    `The code map is unavailable: ${reason}`,
    'Use `glob` and `grep` to navigate the repository instead.',
  )
}
