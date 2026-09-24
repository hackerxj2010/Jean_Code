import { LspClient, type Diagnostic, type Location, type Position, type SymbolInfo } from './client.ts'
import { NativeLanguageServers, type EngineStatus } from './native.ts'
import { BUILTIN_SERVERS, serverFor, type ServerSpec } from './servers.ts'

/**
 * Routes files to language servers, starting them on demand.
 *
 * On demand matters: a repository with six languages should not pay six server
 * startups because the agent read one file. A server starts the first time a
 * file it handles is touched, and lives until the session ends.
 */

export interface ManagerOptions {
  projectRoot: string
  /** Extra or overriding server definitions from config. */
  servers?: ServerSpec[]
  /** Disable specific bundled servers by id. */
  disabled?: string[]
  onError?: (message: string) => void
  /**
   * The `lsp` config section as written — per-server overrides and whole new
   * servers — handed to the Rust engine, which merges it over its registry.
   */
  config?: Record<string, unknown>
  /** Whether a missing server may be installed into `~/.jean/tools`. */
  autoInstall?: boolean
  /** Where installed servers go, instead of `~/.jean/tools`. */
  toolsDir?: string
}

export class LspManager {
  private readonly clients = new Map<string, LspClient>()
  private readonly servers: ServerSpec[]
  private readonly options: ManagerOptions
  /** Files with no server, so the lookup is not repeated for each one. */
  private readonly unsupported = new Set<string>()
  private engine?: Promise<NativeLanguageServers | undefined>

  /**
   * The Rust engine (`crates/pi-lsp`), opened once — `undefined` when the
   * core is not built, and the TypeScript client below serves instead.
   */
  native(): Promise<NativeLanguageServers | undefined> {
    this.engine ??= NativeLanguageServers.open({
      projectRoot: this.options.projectRoot,
      servers: this.options.config,
      autoInstall: this.options.autoInstall,
      toolsDir: this.options.toolsDir,
    })
    return this.engine
  }

  /** What is running, from whichever engine is in use. */
  async status(): Promise<EngineStatus | { running: { server: string; root: string }[] }> {
    const native = await this.native()
    if (native) return native.status()
    return { running: this.running().map((client) => ({ server: client.id, root: client.root })) }
  }

  constructor(options: ManagerOptions) {
    this.options = options

    const disabled = new Set(options.disabled ?? [])
    const custom = options.servers ?? []
    const customIds = new Set(custom.map((s) => s.id))

    // A custom server with a bundled id replaces it rather than competing.
    this.servers = [
      ...custom,
      ...BUILTIN_SERVERS.filter((s) => !customIds.has(s.id) && !disabled.has(s.id)),
    ]
  }

  /**
   * The client for a file, starting one if needed.
   *
   * Returns `undefined` when no server handles the file — a plain `.txt`, or a
   * language whose server is not installed. That is an ordinary outcome and
   * callers degrade rather than fail.
   */
  async clientFor(path: string): Promise<LspClient | undefined> {
    if (this.unsupported.has(path)) return undefined

    const match = await serverFor(path, this.options.projectRoot, this.servers)
    if (!match) {
      this.unsupported.add(path)
      return undefined
    }

    const key = `${match.spec.id}@${match.root}`
    const existing = this.clients.get(key)
    if (existing) return existing

    const client = new LspClient({
      spec: match.spec,
      root: match.root,
      onError: this.options.onError,
    })
    this.clients.set(key, client)

    if (!(await client.start())) {
      // A server that will not start should not be retried on every file.
      this.clients.delete(key)
      this.unsupported.add(path)
      return undefined
    }
    return client
  }

  async diagnostics(path: string): Promise<Diagnostic[]> {
    const client = await this.clientFor(path)
    return client ? client.diagnosticsFor(path) : []
  }

  async definition(path: string, position: Position): Promise<Location[]> {
    const client = await this.clientFor(path)
    return client ? client.definition(path, position) : []
  }

  async typeDefinition(path: string, position: Position): Promise<Location[]> {
    const client = await this.clientFor(path)
    return client ? client.typeDefinition(path, position) : []
  }

  async implementation(path: string, position: Position): Promise<Location[]> {
    const client = await this.clientFor(path)
    return client ? client.implementation(path, position) : []
  }

  async references(path: string, position: Position, includeDeclaration = false): Promise<Location[]> {
    const client = await this.clientFor(path)
    return client ? client.references(path, position, includeDeclaration) : []
  }

  async hover(path: string, position: Position): Promise<string | undefined> {
    const client = await this.clientFor(path)
    return client?.hover(path, position)
  }

  async documentSymbols(path: string): Promise<SymbolInfo[]> {
    const client = await this.clientFor(path)
    return client ? client.documentSymbols(path) : []
  }

  /**
   * Workspace symbol search across every running server.
   *
   * Only servers already started are queried: starting all of them to answer
   * one search would be slower than the grep it is meant to beat.
   */
  async workspaceSymbols(query: string, limit = 100): Promise<SymbolInfo[]> {
    const results = await Promise.all(
      [...this.clients.values()].map((client) =>
        client.workspaceSymbols(query, limit).catch(() => [] as SymbolInfo[]),
      ),
    )
    return results.flat().slice(0, limit)
  }

  async rename(
    path: string,
    position: Position,
    newName: string,
  ): Promise<Map<string, { range: { start: Position; end: Position }; newText: string }[]>> {
    const client = await this.clientFor(path)
    return client ? client.rename(path, position, newName) : new Map()
  }

  /** Notifies the owning server that a file changed on disk. */
  async touch(path: string, text?: string): Promise<void> {
    const client = await this.clientFor(path)
    await client?.openOrUpdate(path, text)
  }

  /** Every diagnostic every running server currently reports. */
  allDiagnostics(): Diagnostic[] {
    return [...this.clients.values()].flatMap((client) => client.allDiagnostics())
  }

  /** Running servers, for `/lsp` and `jean doctor`. */
  running(): { id: string; root: string }[] {
    return [...this.clients.values()].map((client) => ({ id: client.id, root: client.root }))
  }

  /** Stops every server, in both engines. */
  stop(): void {
    for (const client of this.clients.values()) client.stop()
    this.clients.clear()
    this.unsupported.clear()
    void this.engine?.then((native) => native?.stop()).catch(() => undefined)
  }
}
