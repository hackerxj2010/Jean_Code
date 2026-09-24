import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

/**
 * The language server registry.
 *
 * Jean Code never installs a language server. It uses what the project already
 * has — which is the right call: a toolchain the repository is built with is
 * configured correctly, matches the code's actual version, and belongs to the
 * user rather than to us.
 *
 * A server is only started when its binary resolves *and* the project shows a
 * root marker for it, so opening a single `.py` file inside a Go monorepo does
 * not launch a Python server against the wrong root.
 */

const run = promisify(execFile)

export interface ServerSpec {
  /** Stable identifier, used in config and diagnostics. */
  id: string
  /** File extensions this server handles. */
  extensions: string[]
  /** The command, tried in order until one resolves. */
  command: string[]
  /**
   * Files or directories that mark a project root for this server.
   *
   * Searched upward from the file being opened. The nearest match becomes the
   * workspace root the server is initialized with — which is what makes a
   * monorepo work: each package gets a server rooted at the package.
   */
  rootMarkers: string[]
  /** Passed through in `initializationOptions`. */
  initialization?: Record<string, unknown>
  /** Settings sent via `workspace/didChangeConfiguration`. */
  settings?: Record<string, unknown>
  /** Higher wins when several servers claim the same extension. */
  priority?: number
}

/**
 * The bundled servers.
 *
 * Deliberately the mainstream one per language rather than every option: a
 * second server for the same files doubles the startup cost and usually
 * duplicates the diagnostics. Anything missing can be added through config.
 */
export const BUILTIN_SERVERS: ServerSpec[] = [
  {
    id: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
    command: ['typescript-language-server', '--stdio'],
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    initialization: { preferences: { includeInlayParameterNameHints: 'none' } },
    priority: 10,
  },
  {
    id: 'deno',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'],
    command: ['deno', 'lsp'],
    // Only when the project is actually a Deno one; otherwise `typescript`
    // above handles these extensions.
    rootMarkers: ['deno.json', 'deno.jsonc'],
    initialization: { enable: true, lint: true },
    priority: 20,
  },
  {
    id: 'rust-analyzer',
    extensions: ['.rs'],
    command: ['rust-analyzer'],
    rootMarkers: ['Cargo.toml'],
    settings: {
      'rust-analyzer': {
        checkOnSave: { command: 'clippy' },
        cargo: { allFeatures: false },
      },
    },
  },
  {
    id: 'gopls',
    extensions: ['.go'],
    command: ['gopls'],
    rootMarkers: ['go.mod', 'go.work'],
  },
  {
    id: 'pyright',
    extensions: ['.py', '.pyi'],
    command: ['pyright-langserver', '--stdio'],
    rootMarkers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'],
    priority: 10,
  },
  {
    id: 'ruff',
    extensions: ['.py', '.pyi'],
    command: ['ruff', 'server'],
    rootMarkers: ['pyproject.toml', 'ruff.toml', '.ruff.toml'],
    priority: 5,
  },
  {
    id: 'clangd',
    extensions: ['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh', '.hxx'],
    command: ['clangd', '--background-index'],
    rootMarkers: ['compile_commands.json', 'CMakeLists.txt', 'Makefile', '.clangd'],
  },
  {
    id: 'jdtls',
    extensions: ['.java'],
    command: ['jdtls'],
    rootMarkers: ['pom.xml', 'build.gradle', 'build.gradle.kts', '.classpath'],
  },
  {
    id: 'lua-ls',
    extensions: ['.lua'],
    command: ['lua-language-server'],
    rootMarkers: ['.luarc.json', 'stylua.toml', '.git'],
  },
  {
    id: 'ruby-lsp',
    extensions: ['.rb', '.rake', '.gemspec'],
    command: ['ruby-lsp'],
    rootMarkers: ['Gemfile', '.ruby-version'],
  },
  {
    id: 'zls',
    extensions: ['.zig', '.zon'],
    command: ['zls'],
    rootMarkers: ['build.zig', 'build.zig.zon'],
  },
  {
    id: 'elixir-ls',
    extensions: ['.ex', '.exs'],
    command: ['elixir-ls'],
    rootMarkers: ['mix.exs'],
  },
  {
    id: 'svelte',
    extensions: ['.svelte'],
    command: ['svelteserver', '--stdio'],
    rootMarkers: ['svelte.config.js', 'svelte.config.mjs', 'package.json'],
  },
  {
    id: 'vue',
    extensions: ['.vue'],
    command: ['vue-language-server', '--stdio'],
    rootMarkers: ['vite.config.ts', 'vue.config.js', 'package.json'],
  },
  {
    id: 'json',
    extensions: ['.json', '.jsonc'],
    command: ['vscode-json-language-server', '--stdio'],
    rootMarkers: ['package.json', '.git'],
  },
  {
    id: 'yaml',
    extensions: ['.yaml', '.yml'],
    command: ['yaml-language-server', '--stdio'],
    rootMarkers: ['.git'],
  },
  {
    id: 'bash',
    extensions: ['.sh', '.bash'],
    command: ['bash-language-server', 'start'],
    rootMarkers: ['.git'],
  },
  {
    id: 'terraform',
    extensions: ['.tf', '.tfvars'],
    command: ['terraform-ls', 'serve'],
    rootMarkers: ['.terraform', '.git'],
  },
]

/**
 * Walks up from `startDir` looking for any of `markers`.
 *
 * Returns the *deepest* directory that has one, so the innermost package of a
 * monorepo wins over the repository root.
 */
export function findRoot(startDir: string, markers: string[], stopAt?: string): string | undefined {
  let current = resolve(startDir)
  const ceiling = stopAt ? resolve(stopAt) : undefined

  for (;;) {
    for (const marker of markers) {
      if (existsSync(join(current, marker))) return current
    }
    if (ceiling && current === ceiling) return undefined

    const parent = dirname(current)
    if (parent === current) return undefined // filesystem root
    current = parent
  }
}

const resolvedBinaries = new Map<string, boolean>()

/**
 * Whether a binary is on PATH.
 *
 * Cached for the process: a missing language server stays missing, and probing
 * for it on every file open would add a process spawn to a hot path.
 */
export async function hasBinary(binary: string): Promise<boolean> {
  const cached = resolvedBinaries.get(binary)
  if (cached !== undefined) return cached

  const probe = process.platform === 'win32' ? 'where' : 'which'
  let found = false
  try {
    const { stdout } = await run(probe, [binary], { timeout: 5000 })
    found = stdout.trim().length > 0
  } catch {
    found = false
  }

  resolvedBinaries.set(binary, found)
  return found
}

/** Clears the binary cache. For tests, and after a toolchain install. */
export function clearBinaryCache(): void {
  resolvedBinaries.clear()
}

export interface ServerMatch {
  spec: ServerSpec
  root: string
}

/**
 * Picks the server for a file: highest priority whose binary and root both
 * resolve.
 *
 * Both conditions matter. Without the binary check the agent waits on a spawn
 * that will fail; without the root marker it starts a server against a
 * directory that has nothing to do with the file.
 */
export async function serverFor(
  filePath: string,
  projectRoot: string,
  servers: ServerSpec[] = BUILTIN_SERVERS,
): Promise<ServerMatch | undefined> {
  const extension = (filePath.match(/\.[^.\\/]+$/)?.[0] ?? '').toLowerCase()
  if (!extension) return undefined

  const candidates = servers
    .filter((spec) => spec.extensions.includes(extension))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

  for (const spec of candidates) {
    const root = findRoot(dirname(filePath), spec.rootMarkers, dirname(projectRoot))
    if (!root) continue
    if (!(await hasBinary(spec.command[0]!))) continue
    return { spec, root }
  }

  return undefined
}

/** Every server that could serve this project, for `jean doctor`. */
export async function availableServers(
  servers: ServerSpec[] = BUILTIN_SERVERS,
): Promise<{ spec: ServerSpec; installed: boolean }[]> {
  return Promise.all(
    servers.map(async (spec) => ({ spec, installed: await hasBinary(spec.command[0]!) })),
  )
}
