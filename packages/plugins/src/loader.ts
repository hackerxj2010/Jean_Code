import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import type { Plugin, PluginManifest } from './index.ts'

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
      const module = (await withTimeout(
        import(pathToFileURL(entry).href),
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

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms)
      timer.unref?.()
    }),
  ])
}
