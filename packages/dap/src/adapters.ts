import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

/**
 * The debug adapter registry (architecture §8.3).
 *
 * The architecture names three real targets: `lldb` for a C segfault, `dlv` for
 * a hung Go service, `debugpy` for wedged Python. Those are the ones worth
 * getting exactly right; the rest are here because their launch shape is
 * well-known and costs a few lines each.
 */

const run = promisify(execFile)

export interface AdapterSpec {
  id: string
  /** File extensions this adapter debugs. */
  extensions: string[]
  /** The adapter command, tried as-is. */
  command: string[]
  /** Merged under the caller's launch arguments. */
  defaults?: Record<string, unknown>
  /** Files marking a debuggable project root. */
  rootMarkers?: string[]
  /**
   * How the debuggee is named in `launch`.
   *
   * Adapters disagree: `program` for most, `mode`/`program` for Delve. Getting
   * this wrong produces an adapter that starts and then does nothing.
   */
  programKey?: string
}

export const BUILTIN_ADAPTERS: AdapterSpec[] = [
  {
    id: 'debugpy',
    extensions: ['.py'],
    command: ['python', '-m', 'debugpy.adapter'],
    rootMarkers: ['pyproject.toml', 'setup.py', 'requirements.txt'],
    programKey: 'program',
    defaults: {
      type: 'python',
      request: 'launch',
      console: 'internalConsole',
      // Stepping into the standard library buries the user's own bug in
      // framework frames.
      justMyCode: true,
      stopOnEntry: false,
    },
  },
  {
    id: 'delve',
    extensions: ['.go'],
    command: ['dlv', 'dap'],
    rootMarkers: ['go.mod'],
    programKey: 'program',
    defaults: { type: 'go', request: 'launch', mode: 'debug' },
  },
  {
    id: 'lldb',
    extensions: ['.c', '.cpp', '.cc', '.cxx', '.rs', '.m'],
    command: ['lldb-dap'],
    rootMarkers: ['CMakeLists.txt', 'Makefile', 'Cargo.toml', 'compile_commands.json'],
    programKey: 'program',
    defaults: { type: 'lldb', request: 'launch', stopOnEntry: false },
  },
  {
    id: 'codelldb',
    extensions: ['.rs', '.c', '.cpp'],
    command: ['codelldb', '--port', '0'],
    rootMarkers: ['Cargo.toml', 'CMakeLists.txt'],
    programKey: 'program',
    defaults: { type: 'lldb', request: 'launch' },
  },
  {
    id: 'node',
    extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx'],
    command: ['js-debug-adapter'],
    rootMarkers: ['package.json'],
    programKey: 'program',
    defaults: {
      type: 'pwa-node',
      request: 'launch',
      // Node's own internals are never what the user is debugging.
      skipFiles: ['<node_internals>/**'],
      sourceMaps: true,
    },
  },
  {
    id: 'gdb',
    extensions: ['.c', '.cpp', '.cc'],
    command: ['gdb', '--interpreter=dap'],
    rootMarkers: ['Makefile', 'CMakeLists.txt'],
    programKey: 'program',
    defaults: { type: 'gdb', request: 'launch' },
  },
]

const resolved = new Map<string, boolean>()

/** Whether an adapter binary is on PATH. Cached for the process. */
export async function hasAdapter(binary: string): Promise<boolean> {
  const cached = resolved.get(binary)
  if (cached !== undefined) return cached

  const probe = process.platform === 'win32' ? 'where' : 'which'
  let found = false
  try {
    const { stdout } = await run(probe, [binary], { timeout: 5000 })
    found = stdout.trim().length > 0
  } catch {
    found = false
  }

  resolved.set(binary, found)
  return found
}

export function clearAdapterCache(): void {
  resolved.clear()
}

/** Walks upward looking for a project-root marker. */
export function findRoot(startDir: string, markers: string[]): string | undefined {
  let current = resolve(startDir)
  for (;;) {
    for (const marker of markers) {
      if (existsSync(join(current, marker))) return current
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** Picks the adapter for a file: first whose binary and root both resolve. */
export async function adapterFor(
  filePath: string,
  adapters: AdapterSpec[] = BUILTIN_ADAPTERS,
): Promise<{ spec: AdapterSpec; root: string } | undefined> {
  const extension = (filePath.match(/\.[^.\\/]+$/)?.[0] ?? '').toLowerCase()
  if (!extension) return undefined

  for (const spec of adapters.filter((a) => a.extensions.includes(extension))) {
    const root = spec.rootMarkers ? findRoot(dirname(filePath), spec.rootMarkers) : dirname(filePath)
    if (!root) continue
    if (!(await hasAdapter(spec.command[0]!))) continue
    return { spec, root }
  }
  return undefined
}

/** Every adapter and whether it is installed, for `jean doctor`. */
export async function availableAdapters(
  adapters: AdapterSpec[] = BUILTIN_ADAPTERS,
): Promise<{ spec: AdapterSpec; installed: boolean }[]> {
  return Promise.all(
    adapters.map(async (spec) => ({ spec, installed: await hasAdapter(spec.command[0]!) })),
  )
}
