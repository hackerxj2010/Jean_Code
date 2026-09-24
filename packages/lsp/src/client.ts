import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { languageOf } from './languages.ts'
import { Connection, LspError, pathToUri, uriToPath } from './protocol.ts'
import type { ServerSpec } from './servers.ts'

/**
 * One language server, from spawn to shutdown.
 *
 * Owns the handshake, the open-document set, and the diagnostics the server
 * pushes. One instance per (server, workspace root) pair; [`LspManager`] decides
 * how many of those exist.
 */

export interface Position {
  /** Zero-based, as LSP counts. Everything user-facing adds one. */
  line: number
  character: number
}

export interface Range {
  start: Position
  end: Position
}

export interface Location {
  path: string
  range: Range
}

export type DiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint'

export interface Diagnostic {
  path: string
  range: Range
  severity: DiagnosticSeverity
  message: string
  source?: string
  code?: string | number
}

export interface SymbolInfo {
  name: string
  kind: string
  path: string
  range: Range
  /** Enclosing symbol, when the server reports a hierarchy. */
  container?: string
}

/** LSP `SymbolKind` is a number; these are the spec's names, 1-indexed. */
const SYMBOL_KINDS = [
  'file', 'module', 'namespace', 'package', 'class', 'method', 'property',
  'field', 'constructor', 'enum', 'interface', 'function', 'variable',
  'constant', 'string', 'number', 'boolean', 'array', 'object', 'key',
  'null', 'enum-member', 'struct', 'event', 'operator', 'type-parameter',
]

const SEVERITIES: DiagnosticSeverity[] = ['error', 'warning', 'information', 'hint']

export interface ClientOptions {
  spec: ServerSpec
  root: string
  /** Called whenever the server republishes diagnostics for a file. */
  onDiagnostics?: (path: string, diagnostics: Diagnostic[]) => void
  /** Surfaced to the user; a server that fails to start should be visible. */
  onError?: (message: string) => void
}

export class LspClient {
  readonly id: string
  readonly root: string

  private readonly spec: ServerSpec
  private readonly options: ClientOptions
  private process?: ChildProcess
  private connection?: Connection
  private initialized = false
  private starting?: Promise<boolean>

  /** Open documents, by path, with the version last sent. */
  private readonly open = new Map<string, { version: number; text: string }>()
  /** Latest diagnostics per path, as the server last published them. */
  private readonly diagnostics = new Map<string, Diagnostic[]>()
  private capabilities: Record<string, unknown> = {}

  constructor(options: ClientOptions) {
    this.options = options
    this.spec = options.spec
    this.root = options.root
    this.id = `${options.spec.id}@${options.root}`
  }

  /** Starts the server and completes the handshake. Idempotent. */
  async start(): Promise<boolean> {
    if (this.initialized) return true
    // Concurrent callers share one startup rather than racing to spawn twice.
    this.starting ??= this.doStart()
    return this.starting
  }

  private async doStart(): Promise<boolean> {
    const [command, ...args] = this.spec.command
    try {
      this.process = spawn(command!, args, {
        cwd: this.root,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      })
    } catch (err) {
      this.fail(`could not start ${this.spec.id}: ${message(err)}`)
      return false
    }

    // stderr is where servers report their own problems; surfacing it is the
    // difference between "LSP is broken" and a message naming the cause.
    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) this.options.onError?.(`[${this.spec.id}] ${text.slice(0, 500)}`)
    })

    this.connection = new Connection(this.process)
    this.connection.onNotification((method, params) => this.onNotification(method, params))

    // Servers commonly ask these of the client during startup; answering
    // minimally is enough and avoids a stall waiting on a reply.
    this.connection.onRequest('workspace/configuration', () => [this.spec.settings ?? {}])
    this.connection.onRequest('client/registerCapability', () => null)
    this.connection.onRequest('window/workDoneProgress/create', () => null)

    try {
      const result = (await this.connection.request(
        'initialize',
        {
          processId: process.pid,
          rootUri: pathToUri(this.root),
          rootPath: this.root,
          workspaceFolders: [{ uri: pathToUri(this.root), name: this.root.split(/[\\/]/).pop() }],
          initializationOptions: this.spec.initialization,
          capabilities: CLIENT_CAPABILITIES,
        },
        // Generous: a cold rust-analyzer or jdtls genuinely takes this long.
        60_000,
      )) as { capabilities?: Record<string, unknown> }

      this.capabilities = result?.capabilities ?? {}
      this.connection.notify('initialized', {})
      if (this.spec.settings) {
        this.connection.notify('workspace/didChangeConfiguration', { settings: this.spec.settings })
      }
      this.initialized = true
      return true
    } catch (err) {
      this.fail(`${this.spec.id} failed to initialize: ${message(err)}`)
      return false
    }
  }

  private fail(text: string): void {
    this.options.onError?.(text)
    this.stop()
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'textDocument/publishDiagnostics') return

    const payload = params as { uri?: string; diagnostics?: unknown[] }
    if (!payload?.uri) return

    const path = uriToPath(payload.uri)
    const parsed = (payload.diagnostics ?? []).map((raw) => {
      const d = raw as {
        range: Range
        severity?: number
        message: string
        source?: string
        code?: string | number
      }
      return {
        path,
        range: d.range,
        // Absent severity means "error" per the spec's convention in practice.
        severity: SEVERITIES[(d.severity ?? 1) - 1] ?? 'error',
        message: d.message,
        source: d.source,
        code: d.code,
      } satisfies Diagnostic
    })

    this.diagnostics.set(path, parsed)
    this.options.onDiagnostics?.(path, parsed)
  }

  /**
   * Tells the server about a file, or that it changed.
   *
   * Full-text sync rather than incremental: the agent rewrites whole regions
   * through hashline patches, so computing minimal deltas would be work spent
   * to describe a change that is rarely small.
   */
  async openOrUpdate(path: string, text?: string): Promise<void> {
    if (!(await this.start())) return

    const content = text ?? (await readFile(path, 'utf8').catch(() => undefined))
    if (content === undefined) return

    const existing = this.open.get(path)
    const uri = pathToUri(path)

    if (!existing) {
      this.connection?.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: languageOf(path) ?? 'plaintext',
          version: 1,
          text: content,
        },
      })
      this.open.set(path, { version: 1, text: content })
      return
    }

    if (existing.text === content) return // nothing changed; skip the round trip

    const version = existing.version + 1
    this.connection?.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    })
    this.open.set(path, { version, text: content })
  }

  /** Tells the server a file is no longer open. */
  close(path: string): void {
    if (!this.open.has(path)) return
    this.connection?.notify('textDocument/didClose', {
      textDocument: { uri: pathToUri(path) },
    })
    this.open.delete(path)
  }

  /**
   * Diagnostics for a file.
   *
   * Diagnostics arrive as a push notification, not a response, so this waits
   * briefly for the server to catch up with a file it was just told about.
   * Without the wait the first call after an edit reliably returns nothing.
   */
  async diagnosticsFor(path: string, settleMs = 4000): Promise<Diagnostic[]> {
    if (!(await this.start())) return []
    await this.openOrUpdate(path)

    // The pull model, when the server offers it. It is a request with a
    // response, so there is no race: the answer is the answer.
    if (this.capabilities.diagnosticProvider) {
      const pulled = await this.pullDiagnostics(path)
      if (pulled) {
        this.diagnostics.set(path, pulled)
        return pulled
      }
    }

    // Otherwise wait for a push. Servers routinely publish an empty array the
    // moment a document opens and the real result a beat later, so waiting for
    // "any publish" reports every file as clean. Wait instead for a non-empty
    // result, and let a genuinely clean file cost the full window.
    const deadline = Date.now() + settleMs
    while (Date.now() < deadline) {
      const current = this.diagnostics.get(path)
      if (current && current.length > 0) return current
      await sleep(100)
    }
    return this.diagnostics.get(path) ?? []
  }

  /** `textDocument/diagnostic`, returning undefined when unsupported. */
  private async pullDiagnostics(path: string): Promise<Diagnostic[] | undefined> {
    const raw = (await this.request('textDocument/diagnostic', {
      textDocument: { uri: pathToUri(path) },
    })) as { kind?: string; items?: unknown[] } | undefined

    if (!raw?.items) return undefined
    return raw.items.map((item) => {
      const d = item as {
        range: Range
        severity?: number
        message: string
        source?: string
        code?: string | number
      }
      return {
        path,
        range: d.range,
        severity: SEVERITIES[(d.severity ?? 1) - 1] ?? 'error',
        message: d.message,
        source: d.source,
        code: d.code,
      } satisfies Diagnostic
    })
  }

  /** Every diagnostic the server has published, across files. */
  allDiagnostics(): Diagnostic[] {
    return [...this.diagnostics.values()].flat()
  }

  async definition(path: string, position: Position): Promise<Location[]> {
    return this.locationRequest('textDocument/definition', path, position)
  }

  async typeDefinition(path: string, position: Position): Promise<Location[]> {
    return this.locationRequest('textDocument/typeDefinition', path, position)
  }

  async implementation(path: string, position: Position): Promise<Location[]> {
    return this.locationRequest('textDocument/implementation', path, position)
  }

  async references(path: string, position: Position, includeDeclaration = false): Promise<Location[]> {
    if (!(await this.start())) return []
    await this.openOrUpdate(path)

    const raw = await this.request('textDocument/references', {
      textDocument: { uri: pathToUri(path) },
      position,
      context: { includeDeclaration },
    })
    return toLocations(raw)
  }

  /** Hover text, with the server's markup flattened to plain text. */
  async hover(path: string, position: Position): Promise<string | undefined> {
    if (!(await this.start())) return undefined
    await this.openOrUpdate(path)

    const raw = (await this.request('textDocument/hover', {
      textDocument: { uri: pathToUri(path) },
      position,
    })) as { contents?: unknown } | null

    if (!raw?.contents) return undefined
    const text = flattenMarkup(raw.contents)
    return text.trim() || undefined
  }

  /** Symbols declared in one file. */
  async documentSymbols(path: string): Promise<SymbolInfo[]> {
    if (!(await this.start())) return []
    await this.openOrUpdate(path)

    const raw = await this.request('textDocument/documentSymbol', {
      textDocument: { uri: pathToUri(path) },
    })
    if (!Array.isArray(raw)) return []

    // Two shapes are legal: a flat SymbolInformation[], or a nested
    // DocumentSymbol[]. Flattening the nested form keeps the caller simple.
    const out: SymbolInfo[] = []
    const visit = (nodes: unknown[], container?: string) => {
      for (const node of nodes) {
        const symbol = node as {
          name: string
          kind: number
          range?: Range
          selectionRange?: Range
          location?: { uri: string; range: Range }
          containerName?: string
          children?: unknown[]
        }
        const range = symbol.selectionRange ?? symbol.range ?? symbol.location?.range
        if (!range) continue

        out.push({
          name: symbol.name,
          kind: SYMBOL_KINDS[symbol.kind - 1] ?? 'unknown',
          path: symbol.location ? uriToPath(symbol.location.uri) : path,
          range,
          container: symbol.containerName ?? container,
        })
        if (symbol.children?.length) visit(symbol.children, symbol.name)
      }
    }
    visit(raw)
    return out
  }

  /** Symbols matching a query, across the whole workspace. */
  async workspaceSymbols(query: string, limit = 100): Promise<SymbolInfo[]> {
    if (!(await this.start())) return []

    const raw = await this.request('workspace/symbol', { query })
    if (!Array.isArray(raw)) return []

    return raw.slice(0, limit).map((node) => {
      const symbol = node as {
        name: string
        kind: number
        containerName?: string
        location: { uri: string; range: Range }
      }
      return {
        name: symbol.name,
        kind: SYMBOL_KINDS[symbol.kind - 1] ?? 'unknown',
        path: uriToPath(symbol.location.uri),
        range: symbol.location.range,
        container: symbol.containerName,
      }
    })
  }

  /**
   * A rename across the workspace, as a map of path to edits.
   *
   * Returns the edits rather than applying them: writing files is the tool
   * layer's job, and it has the permission gate.
   */
  async rename(
    path: string,
    position: Position,
    newName: string,
  ): Promise<Map<string, { range: Range; newText: string }[]>> {
    const edits = new Map<string, { range: Range; newText: string }[]>()
    if (!(await this.start())) return edits
    await this.openOrUpdate(path)

    const raw = (await this.request('textDocument/rename', {
      textDocument: { uri: pathToUri(path) },
      position,
      newName,
    })) as {
      changes?: Record<string, { range: Range; newText: string }[]>
      documentChanges?: { textDocument: { uri: string }; edits: { range: Range; newText: string }[] }[]
    } | null

    if (!raw) return edits

    for (const [uri, list] of Object.entries(raw.changes ?? {})) {
      edits.set(uriToPath(uri), list)
    }
    // `documentChanges` is the newer, versioned form; servers pick one.
    for (const change of raw.documentChanges ?? []) {
      const target = uriToPath(change.textDocument.uri)
      edits.set(target, [...(edits.get(target) ?? []), ...change.edits])
    }
    return edits
  }

  private async locationRequest(
    method: string,
    path: string,
    position: Position,
  ): Promise<Location[]> {
    if (!(await this.start())) return []
    await this.openOrUpdate(path)

    const raw = await this.request(method, {
      textDocument: { uri: pathToUri(path) },
      position,
    })
    return toLocations(raw)
  }

  /** Sends a request, turning a server-side failure into an empty result. */
  private async request(method: string, params: unknown): Promise<unknown> {
    try {
      return await this.connection?.request(method, params)
    } catch (err) {
      // A server that does not implement a capability answers with an error.
      // That is a normal outcome, not something to fail the agent's turn over.
      if (err instanceof LspError) {
        this.options.onError?.(`[${this.spec.id}] ${method}: ${err.message}`)
        return undefined
      }
      throw err
    }
  }

  /**
   * Sends an arbitrary LSP request (architecture §8.3, `rawRequest`).
   *
   * The escape hatch for server-specific methods — `rust-analyzer/expandMacro`,
   * `textDocument/switchSourceHeader` — that no general client can enumerate.
   * Errors come back as `undefined` rather than throwing, matching every other
   * operation here.
   */
  async rawRequest(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!(await this.start())) return undefined
    try {
      return await this.connection?.request(method, params, timeoutMs)
    } catch (err) {
      if (err instanceof LspError) {
        this.options.onError?.(`[${this.spec.id}] ${method}: ${err.message}`)
        return undefined
      }
      throw err
    }
  }

  /** Whether the server advertised a capability, e.g. `renameProvider`. */
  supports(capability: string): boolean {
    return Boolean(this.capabilities[capability])
  }

  /** Shuts the server down, politely then firmly. */
  stop(): void {
    this.initialized = false
    this.starting = undefined
    try {
      this.connection?.notify('shutdown')
      this.connection?.notify('exit')
    } catch {
      // The server may already be gone; the kill below is the real guarantee.
    }
    this.connection?.shutdown('client stopped')
    this.connection = undefined

    const child = this.process
    this.process = undefined
    if (!child || child.killed) return
    child.kill()
    // A server that ignores SIGTERM would otherwise outlive the CLI.
    const timer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL')
    }, 2000)
    timer.unref?.()
  }
}

function toLocations(raw: unknown): Location[] {
  if (!raw) return []
  // A single Location, an array of them, or LocationLink[] are all legal.
  const list = Array.isArray(raw) ? raw : [raw]

  const out: Location[] = []
  for (const node of list) {
    const item = node as {
      uri?: string
      range?: Range
      targetUri?: string
      targetSelectionRange?: Range
      targetRange?: Range
    }
    const uri = item.uri ?? item.targetUri
    const range = item.range ?? item.targetSelectionRange ?? item.targetRange
    if (uri && range) out.push({ path: uriToPath(uri), range })
  }
  return out
}

/** Flattens the several shapes hover contents can take into plain text. */
function flattenMarkup(contents: unknown): string {
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) return contents.map(flattenMarkup).join('\n')
  if (contents && typeof contents === 'object') {
    const value = (contents as { value?: unknown }).value
    if (typeof value === 'string') return value
  }
  return ''
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * What this client tells servers it can do.
 *
 * Kept narrow on purpose: advertising a capability the client does not
 * implement makes servers send messages nothing handles. Everything here is
 * backed by real code above.
 */
const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { didSave: true, dynamicRegistration: false },
    publishDiagnostics: { relatedInformation: true },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    hover: { contentFormat: ['plaintext', 'markdown'] },
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    rename: { prepareSupport: false },
    // Pull diagnostics (LSP 3.17). A server only advertises `diagnosticProvider`
    // when the client declares this, and without it servers that have dropped
    // push diagnostics report nothing at all — silently, since "no diagnostics"
    // and "clean file" look identical.
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
  },
  workspace: {
    workspaceFolders: true,
    symbol: {},
    configuration: true,
    didChangeConfiguration: { dynamicRegistration: false },
  },
  window: { workDoneProgress: true },
}
