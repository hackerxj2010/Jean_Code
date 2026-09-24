import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { jeanHome } from '@jean/config'

/**
 * `@jean/plugins` — the extension surface (architecture §20.3).
 *
 * A plugin is a directory with a `jean-plugin.json` manifest. Discovery finds
 * them; [`PluginLoader`] activates the ones the user enabled by name.
 *
 * Discovery deliberately does not imply activation. Loading third-party code
 * into the agent process is the highest-consequence thing this system does, and
 * dropping a directory into `~/.jean/plugins` must not be enough to execute it.
 */

export interface PluginManifest {
  name: string
  version: string
  description?: string
  /** Entry point, relative to the plugin directory. */
  main?: string
  /** Slash commands the plugin adds. */
  commands?: { name: string; description: string }[]
  /** Directories to prepend to PATH while the plugin is active. */
  bin?: string[]
  /** Minimum Jean Code version. */
  engine?: string
}

export interface Plugin {
  manifest: PluginManifest
  path: string
  source: 'user' | 'project'
}

/** Reads and validates a plugin manifest. Returns `undefined` if unusable. */
export function readManifest(path: string): PluginManifest | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined

  const manifest = parsed as Partial<PluginManifest>
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) return undefined
  if (typeof manifest.version !== 'string') return undefined

  return manifest as PluginManifest
}

/** Finds installed plugins in `~/.jean/plugins` and `.jean/plugins`. */
export function discoverPlugins(cwd: string): Plugin[] {
  const found: Plugin[] = []
  const roots: [string, Plugin['source']][] = [
    [join(jeanHome(), 'plugins'), 'user'],
    [join(cwd, '.jean', 'plugins'), 'project'],
  ]

  for (const [root, source] of roots) {
    if (!existsSync(root)) continue
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      const dir = join(root, entry)
      const manifest = readManifest(join(dir, 'jean-plugin.json'))
      if (manifest) found.push({ manifest, path: dir, source })
    }
  }

  return found
}

export {
  PluginLoader,
  type LoadedPlugin,
  type LoaderOptions,
  type PluginCommand,
  type PluginContext,
  type PluginModule,
  type PluginTool,
} from './loader.ts'
