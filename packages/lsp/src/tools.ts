import { readFile } from 'node:fs/promises'
import { displayPath, resolveInWorkspace, ToolError, type Tool, type ToolResult } from '@jean/tools'
import type { Diagnostic, Location, Position, SymbolInfo } from './client.ts'
import type { LspManager } from './manager.ts'
import type { DiagnosticsResult, FileChange, HierarchyItem, NativeLanguageServers, NativeLocation, NativeSymbol, Target } from './native.ts'

/**
 * Language-server tools (architecture §11.2).
 *
 * These are what make the agent reason about code rather than text. `grep` for
 * a symbol finds every string that looks like it; `lsp_references` finds the
 * ones that actually bind to it — across files, through imports and re-exports.
 * And the changes a language server knows how to make — a rename across the
 * project, a quick fix, moving a file with its imports — are made by the
 * server, correctly, instead of by text substitution.
 *
 * Every tool addresses code by `line` and `symbol` rather than by column.
 * Models are reliable about "the name `foo` on line 42" and unreliable about
 * column numbers, so the column is found from the text.
 *
 * The Rust engine (`crates/pi-lsp`) serves every tool when it is built. The
 * TypeScript client serves the core six without it.
 */

// ---- the TypeScript fallback's own position handling ------------------------

/**
 * Resolves a (line, symbol) pair to an LSP position, validating that the
 * symbol really is on that line — a stale line number otherwise produces a
 * confidently wrong answer about some unrelated token.
 */
async function locate(absolute: string, line: number, symbol: string | undefined, shown: string): Promise<Position> {
  if (!Number.isInteger(line) || line < 1) {
    throw new ToolError(`\`line\` must be a positive integer; got ${line}.`)
  }
  const text = await readFile(absolute, 'utf8').catch(() => undefined)
  if (text === undefined) throw new ToolError(`${shown} could not be read.`)
  const lines = text.split('\n')
  const target = lines[line - 1]
  if (target === undefined) {
    throw new ToolError(
      `${shown} has ${lines.length} lines, so line ${line} does not exist.`,
      'Read the file again — the line numbers may have shifted since you last saw it.',
    )
  }
  if (!symbol) return { line: line - 1, character: 0 }
  const column = target.indexOf(symbol)
  if (column === -1) {
    throw new ToolError(`\`${symbol}\` is not on line ${line} of ${shown}.`, `That line reads: ${target.trim().slice(0, 120)}`)
  }
  // The middle of the token: servers resolve a position inside an identifier
  // reliably, and its first character sometimes lands on punctuation.
  return { line: line - 1, character: column + Math.floor(symbol.length / 2) }
}

// ---- rendering ----------------------------------------------------------------

const shownPath = (path: string, cwd: string) => displayPath(path, { cwd } as never)

function renderNativeLocations(locations: NativeLocation[], cwd: string, limit = 50): string {
  const byFile = new Map<string, NativeLocation[]>()
  for (const location of locations.slice(0, limit)) byFile.set(location.path, [...(byFile.get(location.path) ?? []), location])
  const out: string[] = []
  for (const [path, list] of byFile) {
    out.push(shownPath(path, cwd))
    for (const location of list) out.push(`  ${location.line + 1}: ${location.text.trim().slice(0, 160)}`)
  }
  if (locations.length > limit) out.push(`\n... ${locations.length - limit} more, not shown.`)
  return out.join('\n')
}

async function renderLocations(locations: Location[], cwd: string, limit = 50): Promise<string> {
  const byFile = new Map<string, Location[]>()
  for (const location of locations.slice(0, limit)) byFile.set(location.path, [...(byFile.get(location.path) ?? []), location])
  const out: string[] = []
  for (const [path, list] of byFile) {
    const lines = (await readFile(path, 'utf8').catch(() => undefined))?.split('\n')
    out.push(shownPath(path, cwd))
    for (const location of list) {
      out.push(`  ${location.range.start.line + 1}: ${(lines?.[location.range.start.line]?.trim() ?? '').slice(0, 160)}`)
    }
  }
  if (locations.length > limit) out.push(`\n... ${locations.length - limit} more, not shown.`)
  return out.join('\n')
}

interface AnyDiagnostic {
  path: string
  severity: 'error' | 'warning' | 'information' | 'hint'
  message: string
  source?: string | null
  server?: string
  range: { start: { line: number } }
}

export function formatDiagnostics(diagnostics: AnyDiagnostic[], cwd: string, limit = 60): string {
  if (diagnostics.length === 0) return 'No problems reported.'
  // Errors first: a warning under an error is usually a consequence of it.
  const order = { error: 0, warning: 1, information: 2, hint: 3 }
  const sorted = [...diagnostics].sort(
    (a, b) => order[a.severity] - order[b.severity] || a.path.localeCompare(b.path) || a.range.start.line - b.range.start.line,
  )
  // Which server said it matters only when more than one is speaking.
  const servers = new Set(sorted.map((d) => d.server).filter(Boolean))
  const lines = sorted.slice(0, limit).map((d) => {
    const where = `${shownPath(d.path, cwd)}:${d.range.start.line + 1}`
    const from = [d.source, servers.size > 1 ? d.server : undefined].filter(Boolean).join(', ')
    return `${d.severity}: ${where} — ${d.message.replace(/\s+/g, ' ').slice(0, 300)}${from ? ` (${from})` : ''}`
  })
  const counts = sorted.reduce<Record<string, number>>((acc, d) => {
    acc[d.severity] = (acc[d.severity] ?? 0) + 1
    return acc
  }, {})
  const summary = Object.entries(counts)
    .map(([severity, count]) => `${count} ${severity}${count === 1 ? '' : 's'}`)
    .join(', ')
  if (sorted.length > limit) lines.push(`... ${sorted.length - limit} more.`)
  return `${summary}.\n\n${lines.join('\n')}`
}

function formatSymbols(symbols: (NativeSymbol | SymbolInfo)[], cwd: string, limit = 80): string {
  if (symbols.length === 0) return 'No symbols found.'
  const lines = symbols.slice(0, limit).map((s) => {
    const depth = 'depth' in s ? '  '.repeat(Math.min(s.depth, 6)) : ''
    const where = `${shownPath(s.path, cwd)}:${s.range.start.line + 1}`
    const container = s.container && !depth ? ` in ${s.container}` : ''
    const detail = 'detail' in s && s.detail ? `  ${s.detail.slice(0, 80)}` : ''
    return `${depth}${s.kind.padEnd(14)} ${s.name}${container}${detail}  ${where}`
  })
  if (symbols.length > limit) lines.push(`... ${symbols.length - limit} more.`)
  return lines.join('\n')
}

function formatChanges(changes: FileChange[], cwd: string, maxDiff = 6000): string {
  if (changes.length === 0) return 'No files changed.'
  const lines = changes.map((change) => {
    const path = shownPath(change.path, cwd)
    switch (change.kind) {
      case 'renamed':
        return `renamed ${change.from ? shownPath(change.from, cwd) : '?'} -> ${path}`
      case 'created':
        return `created ${path}`
      case 'deleted':
        return `deleted ${path}`
      default:
        return `modified ${path}${change.edits ? ` (${change.edits} edit${change.edits === 1 ? '' : 's'})` : ''}`
    }
  })
  let budget = maxDiff
  const diffs: string[] = []
  for (const change of changes) {
    if (!change.diff || budget <= 0) continue
    const piece = change.diff.slice(0, budget)
    diffs.push(piece)
    budget -= piece.length
  }
  return [...lines, ...(diffs.length > 0 ? ['', ...diffs] : [])].join('\n')
}

function formatHierarchy(item: HierarchyItem | null, results: HierarchyItem[], cwd: string, relation: string): string {
  if (!item) return 'The language server found nothing at that position to build a hierarchy from.'
  if (results.length === 0) return `\`${item.name}\` has no ${relation.toLowerCase()}.`
  const lines = results.slice(0, 60).map((result) => {
    const where = `${shownPath(result.path, cwd)}:${result.selection.start.line + 1}`
    const sites =
      result.ranges && result.ranges.length > 0
        ? ` — at line${result.ranges.length === 1 ? '' : 's'} ${result.ranges.map((r) => r.start.line + 1).join(', ')}`
        : ''
    return `  ${result.kind.padEnd(12)} ${result.name}  ${where}${sites}`
  })
  if (results.length > 60) lines.push(`  ... ${results.length - 60} more.`)
  return [`${relation} of \`${item.name}\` (${results.length}):`, ...lines].join('\n')
}

/** Tells the agent the Rust core is needed, and how to get it. */
function needsNative(what: string): never {
  throw new ToolError(`${what} is done by the Rust language-server engine, which is not built.`, 'Run `jean native build`.')
}

/** An engine error is the agent's to act on — a missing symbol, no server — so it becomes a tool error. */
function engineError(error: unknown): never {
  throw new ToolError(error instanceof Error ? error.message : String(error))
}

// ---- the tools ----------------------------------------------------------------

type At = { path: string; line: number; symbol: string }

const positionParameters = {
  path: { type: 'string', description: 'File containing the symbol.' },
  line: { type: 'integer', description: 'Line number, 1-based, as `read` shows it.' },
  symbol: { type: 'string', description: 'The exact symbol text on that line.' },
}

/** Builds the LSP tools bound to a manager. */
export function createLspTools(manager: LspManager): Tool[] {
  const native = (): Promise<NativeLanguageServers | undefined> => manager.native()

  function target(args: { path: string; line?: number; symbol?: string }, cwd: Parameters<typeof resolveInWorkspace>[1]): Target {
    if (args.line !== undefined && (!Number.isInteger(args.line) || args.line < 1)) {
      throw new ToolError(`\`line\` must be a positive integer; got ${args.line}.`)
    }
    return {
      path: resolveInWorkspace(args.path, cwd),
      ...(args.line === undefined ? {} : { line: args.line - 1 }),
      ...(args.symbol ? { symbol: args.symbol } : {}),
    }
  }

  const diagnosticsTool: Tool<{ path?: string; paths?: string[]; severity?: 'error' | 'warning' }> = {
    name: 'lsp_diagnostics',
    risk: 'read',
    description: [
      "Compiler, type-checker, and linter errors for files, from the project's language servers.",
      '',
      'Use it after editing to confirm the change compiles, instead of running a full',
      'build. The type checker and linters (ESLint, Ruff, Biome...) report together.',
      'No path: every problem reported so far.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to check.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Several files to check at once.' },
        severity: { type: 'string', enum: ['error', 'warning'], description: 'Only this severity and worse.' },
      },
    },
    summarize: (args) => (args.path ? `diagnostics ${args.path}` : args.paths ? `diagnostics (${args.paths.length} files)` : 'diagnostics (all)'),

    async execute(args, context): Promise<ToolResult> {
      const paths = [...(args.paths ?? []), ...(args.path ? [args.path] : [])].map((p) => resolveInWorkspace(p, context))
      const engine = await native()
      if (engine) {
        let result: DiagnosticsResult
        try {
          result = await engine.diagnostics(paths.length > 0 ? paths : undefined, args.severity ? { severity: args.severity } : {})
        } catch (error) {
          engineError(error)
        }
        // "No errors" and "nothing checked this" must not look alike: the agent
        // would take an unsupported file as a clean bill of health.
        const notes: string[] = []
        for (const file of result.files) {
          const shown = shownPath(file.path, context.cwd)
          if (file.error) notes.push(`${shown}: ${file.error}`)
          for (const server of file.servers ?? []) {
            if (server.freshness === 'stale') notes.push(`${server.server} had not finished re-checking ${shown}; these may be out of date.`)
            if (server.freshness === 'unknown') notes.push(`${server.server} has not reported on ${shown} yet.`)
            if (server.error) notes.push(`${server.server}: ${server.error}`)
          }
        }
        if (result.pending.length > 0) notes.push(`Still working: ${result.pending.join('; ')}.`)
        return {
          output: [formatDiagnostics(result.diagnostics, context.cwd), ...(notes.length > 0 ? ['', ...notes] : [])].join('\n'),
          display: { kind: 'diagnostics', count: result.diagnostics.length },
        }
      }

      if (paths.length === 0) {
        const all = manager.allDiagnostics()
        return { output: formatDiagnostics(all, context.cwd), display: { kind: 'diagnostics', count: all.length } }
      }
      const collected: Diagnostic[] = []
      for (const path of paths) {
        const diagnostics = await manager.diagnostics(path)
        if (diagnostics.length === 0 && !(await manager.clientFor(path))) {
          return { output: `No language server handles ${shownPath(path, context.cwd)}, so there are no diagnostics to report.` }
        }
        collected.push(
          ...diagnostics.filter((d) => !args.severity || d.severity === 'error' || (args.severity === 'warning' && d.severity === 'warning')),
        )
      }
      return { output: formatDiagnostics(collected, context.cwd), display: { kind: 'diagnostics', count: collected.length } }
    },
  }

  const definitionTool: Tool<At & { kind?: 'definition' | 'type' | 'implementation' | 'declaration' }> = {
    name: 'lsp_definition',
    risk: 'read',
    description: [
      'Jump to where a symbol is defined — or its type, its implementations, or its declaration.',
      '',
      'Resolves through imports, re-exports, and type aliases, which grep cannot.',
      '`kind: "implementation"` finds the classes implementing an interface or method.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        ...positionParameters,
        kind: { type: 'string', enum: ['definition', 'type', 'implementation', 'declaration'], description: 'Default: definition.' },
      },
      required: ['path', 'line', 'symbol'],
    },
    summarize: (args) => `${args.kind ?? 'definition'} of ${args.symbol}`,

    async execute(args, context): Promise<ToolResult> {
      const kind = args.kind ?? 'definition'
      const none = { output: `No ${kind} found for \`${args.symbol}\`. It may be a built-in, or the language server may still be indexing.` }
      const engine = await native()
      if (engine) {
        const result = await engine.definition(target(args, context), kind).catch(engineError)
        if (result.locations.length === 0) return none
        return {
          output: `\`${args.symbol}\` — ${kind}:\n${renderNativeLocations(result.locations, context.cwd)}`,
          display: { kind: 'locations', count: result.locations.length },
        }
      }
      const absolute = resolveInWorkspace(args.path, context)
      const position = await locate(absolute, args.line, args.symbol, shownPath(absolute, context.cwd))
      const locations =
        kind === 'type'
          ? await manager.typeDefinition(absolute, position)
          : kind === 'implementation'
            ? await manager.implementation(absolute, position)
            : await manager.definition(absolute, position)
      if (locations.length === 0) return none
      return {
        output: `\`${args.symbol}\` — ${kind}:\n${await renderLocations(locations, context.cwd)}`,
        display: { kind: 'locations', count: locations.length },
      }
    },
  }

  const referencesTool: Tool<At & { includeDeclaration?: boolean }> = {
    name: 'lsp_references',
    risk: 'read',
    description: [
      'Find every place a symbol is actually used.',
      '',
      'Prefer this over `grep` before renaming or changing a signature: grep matches',
      'text — comments, strings, unrelated names — and misses aliased imports.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { ...positionParameters, includeDeclaration: { type: 'boolean', description: 'Include the declaration itself.' } },
      required: ['path', 'line', 'symbol'],
    },
    summarize: (args) => `references to ${args.symbol}`,

    async execute(args, context): Promise<ToolResult> {
      const engine = await native()
      let paths: string[]
      let rendered: string
      if (engine) {
        const result = await engine.references(target(args, context), args.includeDeclaration ?? false).catch(engineError)
        paths = result.locations.map((l) => l.path)
        rendered = renderNativeLocations(result.locations, context.cwd)
      } else {
        const absolute = resolveInWorkspace(args.path, context)
        const position = await locate(absolute, args.line, args.symbol, shownPath(absolute, context.cwd))
        const locations = await manager.references(absolute, position, args.includeDeclaration ?? false)
        paths = locations.map((l) => l.path)
        rendered = await renderLocations(locations, context.cwd)
      }
      if (paths.length === 0) return { output: `No references found for \`${args.symbol}\`.` }
      const files = new Set(paths).size
      return {
        output: `${paths.length} reference${paths.length === 1 ? '' : 's'} to \`${args.symbol}\` across ${files} file${files === 1 ? '' : 's'}:\n${rendered}`,
        display: { kind: 'locations', count: paths.length },
      }
    },
  }

  const hoverTool: Tool<At> = {
    name: 'lsp_hover',
    risk: 'read',
    description: [
      "A symbol's type signature and documentation.",
      '',
      'The fastest way to learn what a function takes and returns without reading',
      'its definition — including inferred types the source does not spell out.',
    ].join('\n'),
    parameters: { type: 'object', properties: positionParameters, required: ['path', 'line', 'symbol'] },
    summarize: (args) => `hover ${args.symbol}`,

    async execute(args, context): Promise<ToolResult> {
      const engine = await native()
      let text: string | null | undefined
      if (engine) {
        text = (await engine.hover(target(args, context)).catch(engineError)).text
      } else {
        const absolute = resolveInWorkspace(args.path, context)
        text = await manager.hover(absolute, await locate(absolute, args.line, args.symbol, shownPath(absolute, context.cwd)))
      }
      return { output: text ? `\`${args.symbol}\`:\n${text.slice(0, 4000)}` : `No type information available for \`${args.symbol}\`.` }
    },
  }

  const signatureTool: Tool<At> = {
    name: 'lsp_signature',
    risk: 'read',
    description: "The parameters of the function being called at a position — give the call's line and the function name or one of its arguments.",
    parameters: { type: 'object', properties: positionParameters, required: ['path', 'line', 'symbol'] },
    summarize: (args) => `signature ${args.symbol}`,

    async execute(args, context): Promise<ToolResult> {
      const engine = (await native()) ?? needsNative('Signature help')
      const signatures = await engine.signature(target(args, context)).catch(engineError)
      if (signatures.length === 0) return { output: 'No call at that position that the language server recognizes.' }
      const lines = signatures.map((s) => {
        const argument = s.activeParameter !== null ? s.parameters[s.activeParameter] : undefined
        const doc = s.documentation ? `\n    ${s.documentation.split('\n')[0]?.slice(0, 200)}` : ''
        return `${s.active ? '>' : ' '} ${s.label}${argument ? `  (argument: ${argument})` : ''}${doc}`
      })
      return { output: lines.join('\n') }
    },
  }

  const symbolsTool: Tool<{ query?: string; path?: string }> = {
    name: 'lsp_symbols',
    risk: 'read',
    description: [
      'List symbols: the outline of one file, or a search across the project by name.',
      '',
      'Give `path` to outline a file without reading it all. Give `query` to find a',
      'class, function, or type anywhere.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Outline this file.' },
        query: { type: 'string', description: 'Search the workspace for this name.' },
      },
    },
    summarize: (args) => (args.path ? `symbols in ${args.path}` : `symbols matching ${args.query}`),

    async execute(args, context): Promise<ToolResult> {
      const engine = await native()
      if (args.path) {
        const absolute = resolveInWorkspace(args.path, context)
        const symbols = engine ? (await engine.symbols(absolute).catch(engineError)).symbols : await manager.documentSymbols(absolute)
        return {
          output: `${shownPath(absolute, context.cwd)}:\n${formatSymbols(symbols, context.cwd)}`,
          display: { kind: 'symbols', count: symbols.length },
        }
      }
      if (!args.query) throw new ToolError('Give either `path` to outline a file, or `query` to search.')
      const symbols = engine ? (await engine.workspaceSymbols(args.query).catch(engineError)).symbols : await manager.workspaceSymbols(args.query)
      return { output: formatSymbols(symbols, context.cwd), display: { kind: 'symbols', count: symbols.length } }
    },
  }

  const hierarchyTool: Tool<At & { direction: 'incoming' | 'outgoing' | 'supertypes' | 'subtypes' }> = {
    name: 'lsp_hierarchy',
    risk: 'read',
    description: [
      "Who calls a function (`incoming`), what it calls (`outgoing`), or a type's",
      '`supertypes` and `subtypes` — the structure grep can only guess at.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { ...positionParameters, direction: { type: 'string', enum: ['incoming', 'outgoing', 'supertypes', 'subtypes'] } },
      required: ['path', 'line', 'symbol', 'direction'],
    },
    summarize: (args) => `${args.direction} of ${args.symbol}`,

    async execute(args, context): Promise<ToolResult> {
      const engine = (await native()) ?? needsNative('Call and type hierarchies')
      const at = target(args, context)
      const result =
        args.direction === 'supertypes' || args.direction === 'subtypes'
          ? await engine.types(at, args.direction).catch(engineError)
          : await engine.calls(at, args.direction).catch(engineError)
      const relation = { incoming: 'Callers', outgoing: 'Calls made', supertypes: 'Supertypes', subtypes: 'Subtypes' }[args.direction]
      return {
        output: formatHierarchy(result.item, result.results, context.cwd, relation),
        display: { kind: 'hierarchy', count: result.results.length },
      }
    },
  }

  const completionTool: Tool<{ path: string; line: number; after: string; prefix?: string }> = {
    name: 'lsp_completion',
    risk: 'read',
    description: [
      'What the language server would offer to complete — the members of an object,',
      'the exports of a module. `after` is the text on the line the completion',
      'follows, e.g. `user.` to list what `user` has.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File.' },
        line: { type: 'integer', description: 'Line, 1-based.' },
        after: { type: 'string', description: 'Text on the line the completion comes right after, e.g. `config.`' },
        prefix: { type: 'string', description: 'Only items starting with this.' },
      },
      required: ['path', 'line', 'after'],
    },
    summarize: (args) => `complete after ${args.after}`,

    async execute(args, context): Promise<ToolResult> {
      const engine = (await native()) ?? needsNative('Completion')
      const at = target({ path: args.path, line: args.line }, context)
      const result = await engine.completion({ ...at, after: args.after, prefix: args.prefix, limit: 60 }).catch(engineError)
      if (result.items.length === 0) return { output: `Nothing to complete after \`${args.after}\`.` }
      const lines = result.items.map(
        (item) => `${item.kind.padEnd(12)} ${item.label}${item.deprecated ? ' (deprecated)' : ''}${item.detail ? `  ${item.detail.slice(0, 100)}` : ''}`,
      )
      return { output: lines.join('\n') }
    },
  }

  const infoTool: Tool<{
    path: string
    kind: 'inlay_hints' | 'highlights' | 'code_lens' | 'folding' | 'semantic_tokens'
    line?: number
    endLine?: number
    symbol?: string
  }> = {
    name: 'lsp_code_info',
    risk: 'read',
    description: [
      'Other things a language server knows about a file:',
      '`inlay_hints` — inferred types and parameter names over a range of lines;',
      '`highlights` — where a symbol is read and written in the file (give line and symbol);',
      '`code_lens` — reference counts, runnable tests; `folding` — block structure;',
      '`semantic_tokens` — what each token on a line is (give line).',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File.' },
        kind: { type: 'string', enum: ['inlay_hints', 'highlights', 'code_lens', 'folding', 'semantic_tokens'] },
        line: { type: 'integer', description: 'Line, 1-based (start of the range for inlay hints).' },
        endLine: { type: 'integer', description: 'End of the range, 1-based.' },
        symbol: { type: 'string', description: 'For highlights: the symbol on `line`.' },
      },
      required: ['path', 'kind'],
    },
    summarize: (args) => `${args.kind} ${args.path}`,

    async execute(args, context): Promise<ToolResult> {
      const engine = (await native()) ?? needsNative('Code information')
      const path = resolveInWorkspace(args.path, context)
      const line = args.line === undefined ? undefined : args.line - 1
      const endLine = args.endLine === undefined ? undefined : args.endLine - 1
      const list = (items: string[], empty: string, limit = 200) =>
        ({ output: items.length === 0 ? empty : [...items.slice(0, limit), ...(items.length > limit ? [`... ${items.length - limit} more.`] : [])].join('\n') })
      switch (args.kind) {
        case 'inlay_hints': {
          const hints = await engine.inlayHints(path, line, endLine).catch(engineError)
          return list(hints.map((h) => `${h.position.line + 1}:${h.position.character + 1}  ${h.label}${h.kind ? ` (${h.kind})` : ''}`), 'No inlay hints.')
        }
        case 'highlights': {
          if (line === undefined || !args.symbol) throw new ToolError('Highlights need `line` and `symbol`.')
          const found = await engine.highlights({ path, line, symbol: args.symbol }).catch(engineError)
          return list(found.map((h) => `${h.range.start.line + 1}:${h.range.start.character + 1}  ${h.kind}`), 'No highlights.')
        }
        case 'code_lens': {
          const lenses = await engine.codeLens(path).catch(engineError)
          return list(lenses.map((l) => `${l.range.start.line + 1}: ${l.title ?? '(unresolved)'}`), 'No code lenses.')
        }
        case 'folding': {
          const ranges = await engine.folding(path).catch(engineError)
          return list(ranges.map((r) => `${r.startLine + 1}-${r.endLine + 1}${r.kind ? ` ${r.kind}` : ''}`), 'No folding ranges.')
        }
        case 'semantic_tokens': {
          const tokens = await engine.semanticTokens(path, line).catch(engineError)
          return list(
            tokens.map((t) => `${t.line + 1}:${t.character + 1} +${t.length} ${t.type}${t.modifiers.length > 0 ? ` [${t.modifiers.join(', ')}]` : ''}`),
            'No semantic tokens.',
            300,
          )
        }
        default:
          throw new ToolError(`Unknown kind \`${String(args.kind)}\`.`)
      }
    },
  }

  const renameTool: Tool<At & { newName: string; preview?: boolean }> = {
    name: 'lsp_rename',
    risk: 'write',
    description: [
      'Rename a symbol everywhere it is used, as the language server understands it,',
      'and write the edits — all files or none. Safer than search-and-replace, which',
      'cannot tell a binding from a matching string. `preview: true` only shows them.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        ...positionParameters,
        newName: { type: 'string', description: 'The new name.' },
        preview: { type: 'boolean', description: 'Show the edits, do not write them.' },
      },
      required: ['path', 'line', 'symbol', 'newName'],
    },
    summarize: (args) => `rename ${args.symbol} to ${args.newName}`,

    async execute(args, context): Promise<ToolResult> {
      const engine = await native()
      if (engine) {
        const result = await engine.rename(target(args, context), args.newName, !args.preview).catch(engineError)
        const count = result.edits.length
        return {
          output: `${result.applied ? 'Renamed' : 'Renaming would change'} \`${args.symbol}\` to \`${args.newName}\` — ${count} edit${count === 1 ? '' : 's'}:\n${formatChanges(result.changes, context.cwd)}`,
          touched: result.applied ? result.changes.map((c) => c.path) : [],
          display: { kind: 'rename', files: result.changes.length, edits: count },
        }
      }
      // The TypeScript client can only propose the edits.
      const absolute = resolveInWorkspace(args.path, context)
      const position = await locate(absolute, args.line, args.symbol, shownPath(absolute, context.cwd))
      const edits = await manager.rename(absolute, position, args.newName)
      if (edits.size === 0) {
        return { output: `The language server proposed no edits for renaming \`${args.symbol}\`. It may not support rename here.` }
      }
      let total = 0
      const lines: string[] = []
      for (const [path, list] of edits) {
        total += list.length
        lines.push(`${shownPath(path, context.cwd)} (${list.length})`)
        for (const edit of list.slice(0, 10)) lines.push(`  ${edit.range.start.line + 1}: -> ${edit.newText}`)
        if (list.length > 10) lines.push(`  ... ${list.length - 10} more`)
      }
      return {
        output: [
          `Renaming \`${args.symbol}\` to \`${args.newName}\` would change ${total} location${total === 1 ? '' : 's'} in ${edits.size} file${edits.size === 1 ? '' : 's'}:`,
          '',
          ...lines,
          '',
          'Nothing was written: applying a rename needs the Rust core (`jean native build`). Apply these with `edit`.',
        ].join('\n'),
        display: { kind: 'rename', files: edits.size, edits: total },
      }
    },
  }

  const actionsTool: Tool<{ path: string; line: number; endLine?: number; apply?: string; only?: string[]; command?: string; arguments?: unknown[] }> = {
    name: 'lsp_code_actions',
    risk: 'write',
    description: [
      'Quick fixes and refactorings the language server offers for a line or range —',
      'fix an import, add a missing member, extract a function, organize imports.',
      'Call without `apply` to list them; again with `apply` (a title, or part of one)',
      'to apply it. `only: ["source.organizeImports"]` narrows the list.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File.' },
        line: { type: 'integer', description: 'Line, 1-based.' },
        endLine: { type: 'integer', description: 'End of the range, 1-based.' },
        apply: { type: 'string', description: 'Title (or part of it) of the action to apply.' },
        only: { type: 'array', items: { type: 'string' }, description: 'Action kinds: quickfix, refactor.extract, source.organizeImports...' },
        command: { type: 'string', description: "Run this server command directly instead (from the server's documentation)." },
        arguments: { type: 'array', description: 'Arguments for `command`.' },
      },
      required: ['path', 'line'],
    },
    summarize: (args) => (args.apply ? `apply "${args.apply}"` : args.command ? `run ${args.command}` : `code actions ${args.path}:${args.line}`),

    async execute(args, context): Promise<ToolResult> {
      const engine = (await native()) ?? needsNative('Code actions')
      const at = target({ path: args.path, line: args.line }, context)
      if (args.command) {
        const result = await engine.executeCommand(at.path, args.command, args.arguments).catch(engineError)
        const edited = result.edited.map((p) => shownPath(p, context.cwd))
        return {
          output: `Ran ${args.command} on ${result.server}.${edited.length > 0 ? `\nEdited: ${edited.join(', ')}` : ''}`,
          touched: result.edited,
        }
      }
      const result = await engine
        .codeActions(at.path, at.line ?? 0, {
          ...(args.endLine ? { endLine: args.endLine - 1 } : {}),
          ...(args.apply ? { apply: args.apply } : {}),
          ...(args.only ? { only: args.only } : {}),
        })
        .catch(engineError)
      if (result.applied) {
        return {
          output: `Applied "${result.applied}":\n${formatChanges(result.changes ?? [], context.cwd)}`,
          touched: (result.changes ?? []).map((c) => c.path),
        }
      }
      if (result.actions.length === 0) return { output: 'The language server offers no actions here.' }
      const lines = result.actions.map(
        (a) => `- ${a.title}${a.kind ? ` [${a.kind}]` : ''}${a.preferred ? ' (preferred)' : ''}${a.disabled ? ` — unavailable: ${a.disabled}` : ''}`,
      )
      return { output: `${result.actions.length} action${result.actions.length === 1 ? '' : 's'} (apply one with \`apply\`):\n${lines.join('\n')}` }
    },
  }

  const formatTool: Tool<{ path: string; preview?: boolean }> = {
    name: 'lsp_format',
    risk: 'write',
    description: "Format a file with the project's formatter, through its language server (Biome or Ruff first when the project uses them).",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to format.' },
        preview: { type: 'boolean', description: 'Show the diff, do not write.' },
      },
      required: ['path'],
    },
    summarize: (args) => `format ${args.path}`,

    async execute(args, context): Promise<ToolResult> {
      const engine = (await native()) ?? needsNative('Formatting')
      const path = resolveInWorkspace(args.path, context)
      const result = await engine.format(path, !args.preview).catch(engineError)
      if (!result.change) return { output: `${shownPath(path, context.cwd)} is already formatted (${result.server}).` }
      return {
        output: `${result.applied ? 'Formatted' : 'Formatting would change'} ${shownPath(path, context.cwd)} (${result.server}):\n${formatChanges([result.change], context.cwd)}`,
        touched: result.applied ? [path] : [],
      }
    },
  }

  const renameFileTool: Tool<{ from: string; to: string; preview?: boolean }> = {
    name: 'lsp_rename_file',
    risk: 'write',
    description: 'Move or rename a file and update every import of it, through the language server.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Current path.' },
        to: { type: 'string', description: 'New path.' },
        preview: { type: 'boolean', description: 'Show the import updates, move nothing.' },
      },
      required: ['from', 'to'],
    },
    summarize: (args) => `move ${args.from} to ${args.to}`,

    async execute(args, context): Promise<ToolResult> {
      const engine = (await native()) ?? needsNative('Moving a file with its imports')
      const from = resolveInWorkspace(args.from, context)
      const to = resolveInWorkspace(args.to, context)
      const result = await engine.renameFile(from, to, !args.preview).catch(engineError)
      const updated = result.changes.length === 0 ? 'No imports needed updating.' : `Imports updated:\n${formatChanges(result.changes, context.cwd)}`
      return {
        output: `${result.applied ? 'Moved' : 'Would move'} ${shownPath(from, context.cwd)} -> ${shownPath(to, context.cwd)}${result.server ? ` (${result.server})` : ''}.\n${updated}`,
        touched: result.applied ? [from, to, ...result.changes.map((c) => c.path)] : [],
      }
    },
  }

  const serversTool: Tool<{ path?: string }> = {
    name: 'lsp_servers',
    risk: 'read',
    description: 'Which language servers are running, which are available for a file, and what each has been saying — for when a language tool answers nothing.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Only the servers for this file.' } } },
    summarize: (args) => (args.path ? `language servers for ${args.path}` : 'language servers'),

    async execute(args, context): Promise<ToolResult> {
      const engine = await native()
      if (!engine) {
        const running = manager.running()
        return {
          output:
            running.length === 0
              ? 'No language server is running (TypeScript client; `jean native build` enables the full engine).'
              : running.map((r) => `${r.id}  ${r.root}`).join('\n'),
        }
      }
      const status = await engine.status().catch(engineError)
      const servers = await engine.servers(args.path ? resolveInWorkspace(args.path, context) : undefined).catch(engineError)
      const running = status.running.map((r) => {
        const about = [r.name && r.version ? `${r.name} ${r.version}` : r.name, r.progress.length > 0 ? `working: ${r.progress.join('; ')}` : '']
          .filter(Boolean)
          .join(', ')
        const last = r.log.at(-1) ?? r.stderr.at(-1)
        return `  ${r.server}  ${shownPath(r.root, context.cwd) || '.'}  pid ${r.pid ?? '?'}${about ? `  (${about})` : ''}${last ? `\n    last: ${last.slice(0, 200)}` : ''}`
      })
      const shown = args.path ? servers : servers.filter((s) => s.status !== 'missing' && s.status !== 'disabled')
      const listed = shown.map((s) => {
        const note = s.note
          ? `— ${s.note.slice(0, 160)}`
          : s.status === 'installable' && s.install
            ? `— installs on first use: ${s.install}`
            : ''
        return `  ${s.id.padEnd(22)} ${s.status.padEnd(11)} ${s.role === 'linter' ? 'linter ' : ''}${note}`
      })
      return {
        output: [
          running.length > 0 ? `Running:\n${running.join('\n')}` : 'No language server is running yet; one starts on first use.',
          '',
          `${args.path ? 'Servers for this file' : 'Available'}:`,
          ...(listed.length > 0 ? listed : ['  (none)']),
          ...(status.installs.length > 0 ? ['', 'Installed this session:', ...status.installs.map((i) => `  ${i}`)] : []),
        ].join('\n'),
      }
    },
  }

  return [
    diagnosticsTool,
    definitionTool,
    referencesTool,
    hoverTool,
    signatureTool,
    symbolsTool,
    hierarchyTool,
    completionTool,
    infoTool,
    renameTool,
    actionsTool,
    formatTool,
    renameFileTool,
    serversTool,
  ] as Tool[]
}
