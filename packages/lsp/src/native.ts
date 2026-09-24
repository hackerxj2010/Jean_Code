import { nativeReady, type Native } from '@jean/native'

/**
 * The language-server engine in `crates/pi-lsp`, reached through the bridge.
 *
 * This is what the LSP tools use whenever the Rust core is built: seventy-odd
 * servers installed on demand, primary servers and linters side by side,
 * diagnostics waited for until the server has finished reporting, and every
 * edit a server proposes applied to disk all or nothing. The TypeScript
 * client in `client.ts` remains as the fallback for the six core requests.
 *
 * Positions: lines are zero-based on the wire, and a target is best given as
 * a line and the symbol on it — the engine finds the column, in the server's
 * own units, and says so when the symbol is not there.
 */

export interface Target {
  path: string
  /** Zero-based. */
  line?: number
  symbol?: string
  /** UTF-16 column, when no symbol is given. */
  character?: number
  /** Which occurrence of `symbol` on the line, zero-based. */
  occurrence?: number
}

export interface NativeLocation {
  path: string
  line: number
  character: number
  endLine: number
  endCharacter: number
  /** The source line the location points at. */
  text: string
}

export interface NativeRange {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

export interface NativeDiagnostic {
  path: string
  range: NativeRange
  severity: 'error' | 'warning' | 'information' | 'hint'
  message: string
  source: string | null
  code: string | null
  server: string
  tags: string[]
  related: { location: { path: string; range: NativeRange }; message: string }[]
}

export interface DiagnosticsResult {
  diagnostics: NativeDiagnostic[]
  files: { path: string; servers?: { server: string; freshness?: string; error?: string }[]; error?: string }[]
  /** Work servers reported as still in progress — indexing, a build. */
  pending: string[]
}

export interface NativeSymbol {
  name: string
  kind: string
  detail: string | null
  container: string | null
  path: string
  range: NativeRange
  selection: NativeRange
  depth: number
}

export interface FileChange {
  path: string
  kind: 'modified' | 'created' | 'renamed' | 'deleted'
  from: string | null
  edits: number
  diff: string
}

export interface CodeActionInfo {
  index: number
  title: string
  kind: string | null
  preferred: boolean
  disabled: string | null
  server: string
}

export interface HierarchyItem {
  name: string
  kind: string
  detail: string | null
  path: string
  range: NativeRange
  selection: NativeRange
  ranges?: NativeRange[]
}

export interface ServerInfo {
  id: string
  name: string
  role: 'primary' | 'linter'
  extensions: string[]
  status: 'running' | 'installed' | 'installable' | 'missing' | 'disabled'
  binary: string | null
  install: string | null
  note: string | null
}

export interface EngineStatus {
  projectRoot: string
  autoInstall: boolean
  toolsDir: string
  running: {
    server: string
    root: string
    pid: number | null
    name: string | null
    version: string | null
    uptimeSeconds: number
    openDocuments: number
    progress: string[]
    log: string[]
    stderr: string[]
  }[]
  installs: string[]
  notes: Record<string, string>
}

export interface EngineOptions {
  projectRoot: string
  /** Per-server overrides and additions, as in the `lsp` config section. */
  servers?: Record<string, unknown>
  autoInstall?: boolean
  toolsDir?: string
}

export class NativeLanguageServers {
  private constructor(private readonly native: Native) {}

  /**
   * The engine, configured for a project — `undefined` when the Rust core
   * is not built, which callers take as "use the TypeScript client".
   */
  static async open(options: EngineOptions): Promise<NativeLanguageServers | undefined> {
    const native = await nativeReady()
    if (!native) return undefined
    try {
      await native.lsp('configure', {
        projectRoot: options.projectRoot,
        servers: options.servers ?? {},
        ...(options.autoInstall === undefined ? {} : { autoInstall: options.autoInstall }),
        ...(options.toolsDir ? { toolsDir: options.toolsDir } : {}),
      })
      return new NativeLanguageServers(native)
    } catch {
      return undefined
    }
  }

  private call<T>(method: string, params: object, timeoutMs?: number): Promise<T> {
    return this.native.lsp<T>(method, params as Record<string, unknown>, timeoutMs)
  }

  diagnostics(paths?: string[], options: { waitMs?: number; severity?: string } = {}): Promise<DiagnosticsResult> {
    return this.call('diagnostics', { ...(paths ? { paths } : {}), ...options })
  }

  touch(path: string, kind: 'changed' | 'created' | 'deleted' = 'changed', open = false): Promise<{ servers: string[] }> {
    return this.call('touch', { path, kind, open })
  }

  definition(target: Target, kind: 'definition' | 'type' | 'implementation' | 'declaration' = 'definition') {
    return this.call<{ locations: NativeLocation[]; server: string }>('definition', { ...target, kind })
  }

  references(target: Target, includeDeclaration = false) {
    return this.call<{ locations: NativeLocation[]; server: string }>('references', { ...target, includeDeclaration })
  }

  hover(target: Target) {
    return this.call<{ text: string | null; server: string }>('hover', target)
  }

  highlights(target: Target) {
    return this.call<{ range: NativeRange; kind: 'text' | 'read' | 'write' }[]>('highlights', target)
  }

  symbols(path: string) {
    return this.call<{ symbols: NativeSymbol[]; server: string }>('symbols', { path })
  }

  workspaceSymbols(query: string, path?: string, limit?: number) {
    return this.call<{ symbols: NativeSymbol[] }>('workspace_symbols', { query, ...(path ? { path } : {}), ...(limit ? { limit } : {}) })
  }

  completion(target: Target & { after?: string; prefix?: string; limit?: number }) {
    return this.call<{
      items: { label: string; kind: string; detail: string | null; documentation: string | null; deprecated: boolean }[]
      server: string
    }>('completion', target)
  }

  signature(target: Target) {
    return this.call<
      { label: string; documentation: string | null; parameters: string[]; active: boolean; activeParameter: number | null }[]
    >('signature', target)
  }

  rename(target: Target, newName: string, apply = true) {
    return this.call<{
      applied: boolean
      changes: FileChange[]
      edits: { path: string; range: NativeRange; newText: string }[]
      server: string
    }>('rename', { ...target, newName, apply })
  }

  codeActions(path: string, line: number, options: { endLine?: number; apply?: string | number; only?: string[] } = {}) {
    return this.call<{ actions: CodeActionInfo[]; applied?: string; changes?: FileChange[] }>('code_actions', { path, line, ...options })
  }

  format(path: string, apply = true) {
    return this.call<{ change: FileChange | null; applied: boolean; server: string }>('format', { path, apply })
  }

  calls(target: Target, direction: 'incoming' | 'outgoing') {
    return this.call<{ item: HierarchyItem | null; results: HierarchyItem[]; server?: string }>('calls', { ...target, direction })
  }

  types(target: Target, direction: 'supertypes' | 'subtypes') {
    return this.call<{ item: HierarchyItem | null; results: HierarchyItem[]; server?: string }>('types', { ...target, direction })
  }

  inlayHints(path: string, line?: number, endLine?: number) {
    return this.call<{ position: { line: number; character: number }; label: string; kind: string | null }[]>('inlay_hints', {
      path,
      ...(line === undefined ? {} : { line }),
      ...(endLine === undefined ? {} : { endLine }),
    })
  }

  codeLens(path: string) {
    return this.call<{ range: NativeRange; title: string | null }[]>('code_lens', { path })
  }

  folding(path: string) {
    return this.call<{ startLine: number; endLine: number; kind: string | null }[]>('folding', { path })
  }

  semanticTokens(path: string, line?: number) {
    return this.call<{ line: number; character: number; length: number; type: string; modifiers: string[] }[]>('semantic_tokens', {
      path,
      ...(line === undefined ? {} : { line }),
    })
  }

  renameFile(from: string, to: string, apply = true) {
    return this.call<{ applied: boolean; moved: { from: string; to: string }; changes: FileChange[]; server: string | null }>(
      'rename_file',
      { from, to, apply },
    )
  }

  executeCommand(path: string, command: string, args?: unknown[]) {
    return this.call<{ result: unknown; edited: string[]; server: string }>('execute_command', {
      path,
      command,
      ...(args ? { arguments: args } : {}),
    })
  }

  servers(path?: string): Promise<ServerInfo[]> {
    return this.call('servers', path ? { path } : {})
  }

  status(): Promise<EngineStatus> {
    return this.call('status', {})
  }

  install(id: string) {
    return this.call<{ id: string; binary: string; log: string[] }>('install', { id }, 900_000)
  }

  stop(): Promise<string[]> {
    return this.call('stop', {})
  }
}
