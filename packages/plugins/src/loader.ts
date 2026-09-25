import { existsSync, watch, type FSWatcher } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join, resolve, sep } from 'node:path'
import { readManifest, type Plugin, type PluginManifest } from './index.ts'

/**
 * Plugin activation (architecture §20.3).
 *
 * Loading third-party code into the agent process is the highest-consequence
 * thing this system does, so the boundary is explicit rather than implied:
 *
 * * A plugin runs only if the user enabled it by name. Discovery does not
 *   imply activation — dropping a directory into `~/.jean/plugins` must not be
 *   enough to execute code.
 * * A plugin registers tools and commands through a passed-in context. It gets
 *   no reference to the registry, the config, or the model client, so it cannot
 *   quietly rewrite permission gating or read credentials out of config.
 * * A plugin that throws is disabled and reported, not retried. A broken plugin
 *   should cost one message, not every turn.
 *
 * This is not a sandbox. A plugin is `import`ed into this process and can do
 * anything Node can do; the boundary above limits accident, not intent. That
 * distinction is why activation requires naming the plugin.
 */

export interface PluginCommand {
  name: string
  description: string
  run: (args: string[]) => Promise<string> | string
}

export interface PluginTool {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

/** What a plugin is handed. Deliberately narrow. */
export interface PluginContext {
  /** The project root. */
  cwd: string
  /** The plugin's own directory, for reading its bundled files. */
  pluginDir: string
  registerTool: (tool: PluginTool) => void
  registerCommand: (command: PluginCommand) => void
  log: (message: string) => void
}

export interface PluginModule {
  /** Called once at activation. */
  activate?: (context: PluginContext) => Promise<void> | void
  /** Called at shutdown, for plugins holding resources. */
  deactivate?: () => Promise<void> | void
}

export interface LoadedPlugin {
  manifest: PluginManifest
  path: string
  tools: PluginTool[]
  commands: PluginCommand[]
  module?: PluginModule
  error?: string
}

export interface LoaderOptions {
  cwd: string
  /** Plugin names the user enabled. Nothing else runs. */
  enabled: string[]
  onLog?: (message: string) => void
  onError?: (message: string) => void
  /** Per-plugin activation budget. */
  timeoutMs?: number
}

export class PluginLoader {
  private readonly options: LoaderOptions
  private readonly loaded = new Map<string, LoadedPlugin>()

  constructor(options: LoaderOptions) {
    this.options = options
  }

  /**
   * Activates the enabled plugins among those discovered.
   *
   * One plugin failing never stops another: a broken plugin is a broken
   * plugin, not a broken agent.
   */
  async loadAll(discovered: Plugin[]): Promise<LoadedPlugin[]> {
    const results: LoadedPlugin[] = []

    for (const plugin of discovered) {
      if (!this.options.enabled.includes(plugin.manifest.name)) {
        // Discovered but not enabled. Silent by design: listing every unused
        // plugin on every start is noise.
        continue
      }
      results.push(await this.load(plugin))
    }

    return results
  }

  /** Activates one plugin. Never throws. */
  async load(plugin: Plugin): Promise<LoadedPlugin> {
    const existing = this.loaded.get(plugin.manifest.name)
    if (existing) return existing
    return this.activate(plugin, false)
  }

  /**
   * Deactivates a plugin and activates it again from its files as they are
   * now — its manifest re-read, every module under its directory evaluated
   * afresh. Never throws: a reload that fails leaves the plugin disabled
   * with the error, as a first load would.
   */
  async reload(plugin: Plugin): Promise<LoadedPlugin> {
    const previous = this.loaded.get(plugin.manifest.name)
    try {
      await previous?.module?.deactivate?.()
    } catch {
      // The old version is going away either way.
    }
    this.loaded.delete(plugin.manifest.name)
    const manifest = readManifest(join(plugin.path, 'jean-plugin.json')) ?? plugin.manifest
    return this.activate({ ...plugin, manifest }, true)
  }

  /**
   * Reloads each plugin when a file in its directory changes, and reports the
   * result. Changes are gathered for a moment first: an editor's save is
   * several writes, and a build rewrites many files at once.
   *
   * Returns a function that stops watching.
   */
  watch(plugins: Plugin[], onReload: (loaded: LoadedPlugin) => void, settleMs = 250): () => void {
    const watchers: FSWatcher[] = []
    for (const plugin of plugins) {
      if (!this.loaded.has(plugin.manifest.name)) continue
      let timer: ReturnType<typeof setTimeout> | undefined
      let running = Promise.resolve()
      const changed = (file: string | null) => {
        // Dependencies and dotfiles change under a plugin without changing it.
        if (file && /(^|[\\/])(node_modules|\.git)([\\/]|$)|(^|[\\/])\.[^\\/]+$/.test(file)) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          running = running.then(async () => onReload(await this.reload(plugin)))
        }, settleMs)
        timer.unref?.()
      }
      try {
        const watcher = watch(plugin.path, { recursive: true }, (_event, file) => changed(file ? String(file) : null))
        watcher.on('error', () => undefined)
        watcher.unref?.()
        watchers.push(watcher)
      } catch {
        // No recursive watching on this platform or file system: watch the
        // directory itself, which still sees its entry point change.
        try {
          const watcher = watch(plugin.path, (_event, file) => changed(file ? String(file) : null))
          watcher.unref?.()
          watchers.push(watcher)
        } catch {
          // Not watchable at all; the plugin still works, unreloaded.
        }
      }
    }
    return () => {
      for (const watcher of watchers.splice(0)) watcher.close()
    }
  }

  private async activate(plugin: Plugin, fresh: boolean): Promise<LoadedPlugin> {
    const record: LoadedPlugin = {
      manifest: plugin.manifest,
      path: plugin.path,
      tools: [],
      commands: [],
    }

    const entry = resolve(plugin.path, plugin.manifest.main ?? 'index.js')
    if (!existsSync(entry)) {
      record.error = `entry point ${plugin.manifest.main ?? 'index.js'} does not exist`
      this.options.onError?.(`plugin ${plugin.manifest.name}: ${record.error}`)
      this.loaded.set(plugin.manifest.name, record)
      return record
    }

    const context: PluginContext = {
      cwd: this.options.cwd,
      pluginDir: plugin.path,
      registerTool: (tool) => {
        // Namespaced so a plugin cannot shadow `read`, `write`, or `bash` and
        // silently intercept them.
        record.tools.push({ ...tool, name: `${plugin.manifest.name}__${tool.name}` })
      },
      registerCommand: (command) => record.commands.push(command),
      log: (message) => this.options.onLog?.(`[${plugin.manifest.name}] ${message}`),
    }

    try {
      // `pathToFileURL` rather than the raw path: a bare Windows path is not a
      // valid module specifier and `import` rejects it.
      // A reload has to evaluate the plugin's code again, dependencies
      // included: the runtime keeps every module it evaluated, keyed by path.
      if (fresh) forget(plugin.path)
      const module = (await withTimeout(
        import(pathToFileURL(entry).href + (fresh ? `?reload=${Date.now()}` : '')),
        this.options.timeoutMs ?? 10_000,
        `${plugin.manifest.name} took too long to load`,
      )) as PluginModule

      record.module = module
      if (typeof module.activate === 'function') {
        await withTimeout(
          Promise.resolve(module.activate(context)),
          this.options.timeoutMs ?? 10_000,
          `${plugin.manifest.name} took too long to activate`,
        )
      }

      this.options.onLog?.(
        `loaded ${plugin.manifest.name} v${plugin.manifest.version} (${record.tools.length} tools, ${record.commands.length} commands)`,
      )
    } catch (err) {
      record.error = err instanceof Error ? err.message : String(err)
      // Tools registered before the failure are discarded: a half-activated
      // plugin is not in a state anyone reasoned about.
      record.tools = []
      record.commands = []
      this.options.onError?.(`plugin ${plugin.manifest.name} failed: ${record.error}`)
    }

    this.loaded.set(plugin.manifest.name, record)
    return record
  }

  /** Every activated plugin's tools, flattened. */
  tools(): PluginTool[] {
    return [...this.loaded.values()].flatMap((p) => p.tools)
  }

  commands(): PluginCommand[] {
    return [...this.loaded.values()].flatMap((p) => p.commands)
  }

  active(): LoadedPlugin[] {
    return [...this.loaded.values()].filter((p) => !p.error)
  }

  failed(): LoadedPlugin[] {
    return [...this.loaded.values()].filter((p) => p.error)
  }

  /** Runs each plugin's `deactivate`, ignoring failures. */
  async unloadAll(): Promise<void> {
    for (const plugin of this.loaded.values()) {
      try {
        await plugin.module?.deactivate?.()
      } catch {
        // Shutdown is not the moment to care about a misbehaving plugin.
      }
    }
    this.loaded.clear()
  }

  /**
   * Directories a plugin contributes to PATH.
   *
   * Returned rather than applied: mutating `process.env.PATH` from a library is
   * the kind of action that surprises whoever debugs it later, so the caller
   * decides.
   */
  binDirectories(): string[] {
    return [...this.loaded.values()]
      .filter((p) => !p.error)
      .flatMap((p) => (p.manifest.bin ?? []).map((dir) => join(p.path, dir)))
      .filter((dir) => existsSync(dir))
  }
}

/** Drops every module under `dir` from the runtime's cache. */
function forget(dir: string): void {
  const cache = (globalThis as { require?: { cache?: Record<string, unknown> } }).require?.cache ?? require.cache
  const prefix = resolve(dir) + sep
  for (const key of Object.keys(cache)) {
    const path = key.startsWith('file:') ? decodeURIComponent(new URL(key).pathname).replace(/^\/([A-Za-z]:)/, '$1') : key
    if (resolve(path).startsWith(prefix)) delete cache[key]
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms)
      timer.unref?.()
    }),
  ])
}
