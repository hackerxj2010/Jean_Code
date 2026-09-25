import type { JeanConfig } from '@jean/config'
import { NativeDebuggers, type AdapterInfo } from '@jean/dap'
import { NativeLanguageServers, type ServerInfo } from '@jean/lsp'
import { buildNative, nativeStatus } from '@jean/native'
import { color, line, symbols } from '../ui.ts'

/**
 * `jean setup` — everything Jean runs on, installed in one go.
 *
 * In order, because each step needs the one before: the Rust core (built
 * with cargo), then every debug adapter whose language is on this machine,
 * then the language servers for the languages most projects are written in.
 * Adapters and servers go into `~/.jean/tools`, never onto the system. What
 * cannot be installed automatically — a missing language runtime, a server
 * that ships only with its SDK — is listed at the end with how to get it.
 *
 *   jean setup             the core, debuggers, and the common servers
 *   jean setup all         every adapter and server that installs itself
 *   jean setup native      only the Rust core
 *   jean setup debuggers   only the debug adapters
 *   jean setup lsp         only the language servers
 *   jean setup check       what is there and what is missing; installs nothing
 */

type Step = 'native' | 'debuggers' | 'lsp'

/** Whether to install an item: yes, not asked for, or not here and why. */
type Verdict = true | false | string

interface Runtime {
  id: string
  binaries: string[]
  get: string
}

const RUNTIMES: Runtime[] = [
  { id: 'node', binaries: ['node'], get: 'https://nodejs.org (or: winget install OpenJS.NodeJS / brew install node)' },
  { id: 'python', binaries: ['python3', 'python', 'py'], get: 'https://www.python.org/downloads (or: winget install Python.Python.3.13 / brew install python)' },
  { id: 'cargo', binaries: ['cargo'], get: 'https://rustup.rs' },
  { id: 'go', binaries: ['go'], get: 'https://go.dev/dl (or: winget install GoLang.Go / brew install go)' },
  { id: 'dotnet', binaries: ['dotnet'], get: 'https://dotnet.microsoft.com/download' },
  { id: 'elixir', binaries: ['elixir'], get: 'https://elixir-lang.org/install.html' },
]

/**
 * The language each adapter debugs: installing one for a language that is
 * not here would be a download nobody can use. CodeLLDB debugs any native
 * binary — Rust, C, C++, Zig — so it is always worth having.
 */
const ADAPTER_LANGUAGE: Record<string, string | null> = {
  debugpy: 'python',
  'js-debug': 'node',
  codelldb: null,
  delve: 'go',
  netcoredbg: 'dotnet',
  'elixir-ls': 'elixir',
}

/** The servers a plain `jean setup` installs: the languages most code is in. */
const COMMON_SERVERS = [
  'typescript',
  'eslint',
  'pyright',
  'ruff',
  'rust-analyzer',
  'gopls',
  'clangd',
  'json',
  'css',
  'html',
  'yaml',
  'taplo',
  'markdown',
  'bash',
  'dockerfile',
  'lua',
]

/** The runtime an install recipe runs on: `npm install x` needs Node. */
function recipeNeeds(recipe: string | null): string | null {
  const tool = recipe?.split(' ')[0] ?? ''
  const needs: Record<string, string> = { npm: 'node', pip: 'python', go: 'go', cargo: 'cargo', dotnet: 'dotnet', gem: 'ruby' }
  return needs[tool] ?? null
}

function present(runtime: string): boolean {
  const known = RUNTIMES.find((r) => r.id === runtime)
  return (known?.binaries ?? [runtime]).some((binary) => Bun.which(binary) !== null)
}

function heading(text: string): void {
  line()
  line(color.bold(text))
}

export async function runSetupCommand(positional: string[], config: JeanConfig, cwd: string): Promise<number> {
  const mode = positional[0] ?? 'default'
  const known = ['default', 'all', 'native', 'debuggers', 'lsp', 'check']
  if (!known.includes(mode)) {
    line(color.red(`Unknown \`${mode}\`.`) + color.dim(` Use: jean setup [${known.slice(1).join('|')}]`))
    return 2
  }
  const steps: Step[] = mode === 'native' || mode === 'debuggers' || mode === 'lsp' ? [mode] : ['native', 'debuggers', 'lsp']
  const everything = mode === 'all'
  const dryRun = mode === 'check'
  const later: string[] = []
  let failures = 0

  heading('Runtimes')
  for (const runtime of RUNTIMES) {
    const found = present(runtime.id)
    line(`  ${found ? color.green(symbols.check) : color.dim('·')} ${runtime.id.padEnd(8)} ${found ? '' : color.dim(`not found — ${runtime.get}`)}`)
  }

  if (steps.includes('native')) {
    heading('Rust core')
    const status = await nativeStatus()
    const current = status.available && !status.stale && status.missing.length === 0 && status.library !== undefined
    if (current) {
      line(`  ${color.green(symbols.check)} built and current ${color.dim(status.binary ?? '')}`)
    } else if (dryRun) {
      line(`  ${color.yellow(symbols.warn)} ${status.available ? 'out of date' : 'not built'} — \`jean setup native\` builds it`)
    } else if (!present('cargo')) {
      line(`  ${color.yellow(symbols.warn)} cargo is not installed; Jean runs on its TypeScript fallbacks until it is.`)
      later.push(`Rust, for the native core, the debuggers, and the language servers: ${RUNTIMES.find((r) => r.id === 'cargo')?.get}`)
    } else {
      line(color.dim('  cargo build --release -p pi-natives && cargo build --profile ffi -p pi-ffi'))
      const result = await buildNative((text) => process.stderr.write(color.dim(text)))
      if (result.code === 0) {
        line(`  ${color.green(symbols.check)} built ${color.dim(result.binary ?? '')}`)
      } else {
        failures++
        line(`  ${color.red(symbols.cross)} the build failed (exit ${result.code}); \`jean native build\` shows why.`)
      }
    }
  }

  if (steps.includes('debuggers')) {
    heading('Debug adapters')
    const engine = await NativeDebuggers.open({
      projectRoot: cwd,
      adapters: config.debuggers as Record<string, unknown> | undefined,
      toolsDir: config.languageTools?.dir,
    })
    if (!engine) {
      line(`  ${color.red(symbols.cross)} needs the Rust core, which is not built.`)
      failures++
    } else {
      const wanted = (adapter: AdapterInfo): Verdict => {
        if (!(adapter.id in ADAPTER_LANGUAGE)) return everything
        const language = ADAPTER_LANGUAGE[adapter.id]
        if (language === null || language === undefined || everything) return true
        return present(language) ? true : `no ${language} on this machine`
      }
      try {
        failures += await installAll(await engine.adapters(), wanted, async (id) => (await engine.install(id)).path, dryRun, later)
      } finally {
        await engine.stop().catch(() => undefined)
      }
    }
  }

  if (steps.includes('lsp')) {
    heading('Language servers')
    const engine = await NativeLanguageServers.open({
      projectRoot: cwd,
      servers: config.lsp as Record<string, unknown>,
      toolsDir: config.languageTools?.dir,
    })
    if (!engine) {
      line(`  ${color.red(symbols.cross)} needs the Rust core, which is not built.`)
      failures++
    } else {
      const wanted = (server: ServerInfo): Verdict => everything || COMMON_SERVERS.includes(server.id)
      try {
        failures += await installAll(await engine.servers(), wanted, async (id) => (await engine.install(id)).binary, dryRun, later)
      } finally {
        await engine.stop().catch(() => undefined)
      }
    }
  }

  return finish(later, failures, dryRun)
}

/**
 * Installs each wanted item that is missing and installs itself, one after
 * another — installers share `~/.jean/tools`. Returns how many failed.
 */
async function installAll<T extends { id: string; status: string; install?: string | null }>(
  items: T[],
  wanted: (item: T) => Verdict,
  install: (id: string) => Promise<string>,
  dryRun: boolean,
  later: string[],
): Promise<number> {
  let failures = 0
  const skip = (id: string, why: string) => line(`  ${color.dim('·')} ${id.padEnd(16)} ${color.dim(why)}`)
  for (const item of items) {
    const verdict = wanted(item)
    if (verdict === false) continue
    const recipe = item.install ?? null
    if (item.status === 'installed' || item.status === 'running') {
      line(`  ${color.green(symbols.check)} ${item.id.padEnd(16)} ${color.dim('ready')}`)
      continue
    }
    if (typeof verdict === 'string') {
      skip(item.id, `skipped: ${verdict}`)
      continue
    }
    const needs = recipeNeeds(recipe)
    if (needs && !present(needs)) {
      skip(item.id, `skipped: its installer needs ${needs}`)
      continue
    }
    if (item.status !== 'installable') {
      if (recipe) later.push(`${item.id}: ${recipe}`)
      skip(item.id, 'installed by hand — see below')
      continue
    }
    if (dryRun) {
      line(`  ${color.cyan('+')} ${item.id.padEnd(16)} ${color.dim(`would install: ${recipe ?? ''}`)}`)
      continue
    }
    const tty = process.stdout.isTTY === true
    if (tty) process.stdout.write(`  ${color.cyan('…')} ${item.id.padEnd(16)} ${color.dim(recipe ?? '')}`)
    const clear = tty ? '\r' : ''
    const end = tty ? '\x1b[K\n' : '\n'
    try {
      const path = await install(item.id)
      process.stdout.write(`${clear}  ${color.green(symbols.check)} ${item.id.padEnd(16)} ${color.dim(path)}${end}`)
    } catch (error) {
      failures++
      const message = (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 160) ?? ''
      process.stdout.write(`${clear}  ${color.red(symbols.cross)} ${item.id.padEnd(16)} ${color.red(message)}${end}`)
    }
  }
  return failures
}

function finish(later: string[], failures: number, dryRun: boolean): number {
  if (later.length > 0) {
    heading('Install by hand')
    for (const item of new Set(later)) line(`  ${color.dim('·')} ${item}`)
  }
  line()
  if (dryRun) {
    line(color.dim('Nothing was installed. `jean setup` installs what is marked +.'))
    return 0
  }
  line(
    failures === 0
      ? `${color.green(symbols.check)} Setup complete. \`jean doctor\` shows the whole picture.`
      : `${color.yellow(symbols.warn)} ${failures} step${failures === 1 ? '' : 's'} failed; the rest is installed. Run \`jean setup\` again to retry.`,
  )
  return failures === 0 ? 0 : 1
}
