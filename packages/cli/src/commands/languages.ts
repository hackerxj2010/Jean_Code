import { resolve } from 'node:path'
import type { JeanConfig } from '@jean/config'
import { NativeDebuggers, type AdapterInfo } from '@jean/dap'
import { formatDiagnostics, NativeLanguageServers, type ServerInfo } from '@jean/lsp'
import { color, line, symbols } from '../ui.ts'

/**
 * `jean lsp` and `jean debug` — the language servers and debug adapters the
 * agent's tools run on (`crates/pi-lsp`, `crates/pi-dap`): which are ready,
 * which Jean installs the first time a file needs one, installing one ahead
 * of time, and checking files from the command line.
 */

function openServers(config: JeanConfig, cwd: string): Promise<NativeLanguageServers | undefined> {
  return NativeLanguageServers.open({
    projectRoot: cwd,
    servers: config.lsp as Record<string, unknown>,
    autoInstall: config.languageTools?.autoInstall,
    toolsDir: config.languageTools?.dir,
  })
}

function openDebuggers(config: JeanConfig, cwd: string): Promise<NativeDebuggers | undefined> {
  return NativeDebuggers.open({
    projectRoot: cwd,
    adapters: config.debuggers as Record<string, unknown> | undefined,
    autoInstall: config.languageTools?.autoInstall,
    toolsDir: config.languageTools?.dir,
  })
}

const notBuilt = () => line(color.red(`${symbols.cross} This needs the Rust core. Run \`jean native build\`.`))

function paint(status: string): string {
  const padded = status.padEnd(11)
  if (status === 'running' || status === 'installed') return color.green(padded)
  if (status === 'installable') return color.cyan(padded)
  return color.dim(padded)
}

function counts(items: { status: string }[]): string {
  const ready = items.filter((i) => i.status === 'installed' || i.status === 'running').length
  const later = items.filter((i) => i.status === 'installable').length
  return `${ready} ready, ${later} installed on first use, ${items.length - ready - later} unavailable`
}

function printServers(servers: ServerInfo[], all: boolean): void {
  const shown = all ? servers : servers.filter((s) => s.status !== 'missing' && s.status !== 'disabled')
  for (const server of shown) {
    const role = server.role === 'linter' ? color.dim('linter  ') : '        '
    const detail =
      server.status === 'installable' && server.install
        ? server.install
        : (server.binary ?? server.note ?? server.install ?? '')
    line(`  ${server.id.padEnd(24)} ${paint(server.status)} ${role}${color.dim(detail)}`)
  }
  if (!all && shown.length < servers.length) {
    line(color.dim(`  ... ${servers.length - shown.length} more unavailable; \`jean lsp servers\` lists them all.`))
  }
}

function printAdapters(adapters: AdapterInfo[]): void {
  for (const adapter of adapters) {
    const detail = adapter.status === 'installable' && adapter.install ? adapter.install : (adapter.path ?? adapter.install ?? '')
    line(`  ${adapter.id.padEnd(12)} ${paint(adapter.status)} ${adapter.extensions.slice(0, 6).join(' ').padEnd(24)} ${color.dim(detail)}`)
  }
}

export async function runLspCommand(positional: string[], config: JeanConfig, cwd: string): Promise<number> {
  const sub = positional[0] ?? 'status'
  const engine = await openServers(config, cwd)
  if (!engine) {
    notBuilt()
    return 1
  }
  try {
    switch (sub) {
      case 'status':
      case 'servers': {
        const path = positional[1] ? resolve(cwd, positional[1]) : undefined
        const servers = await engine.servers(path)
        const status = await engine.status()
        line()
        line(color.bold(path ? `Language servers for ${positional[1]}` : 'Language servers'))
        line(color.dim(`  ${counts(servers)} · tools in ${status.toolsDir}${status.autoInstall ? '' : ' · automatic installs off'}`))
        line()
        printServers(servers, sub === 'servers' || path !== undefined)
        line()
        return 0
      }
      case 'install': {
        const id = positional[1]
        if (!id) {
          line(color.red('Usage: jean lsp install <server-id>'))
          return 2
        }
        line(color.dim(`  Installing ${id}...`))
        const result = await engine.install(id)
        for (const entry of result.log) line(color.dim(`  ${entry}`))
        line(`${symbols.check} ${id}: ${color.cyan(result.binary)}`)
        return 0
      }
      case 'check':
      case 'diagnostics': {
        const paths = positional.slice(1).map((path) => resolve(cwd, path))
        if (paths.length === 0) {
          line(color.red('Usage: jean lsp check <file>...'))
          return 2
        }
        const result = await engine.diagnostics(paths, { waitMs: 30_000 })
        line(formatDiagnostics(result.diagnostics, cwd))
        // "No problems" from a server that never answered is not a clean bill.
        let unsure = false
        for (const file of result.files) {
          if (file.error) line(color.yellow(`${symbols.warn} ${file.error}`))
          for (const server of file.servers ?? []) {
            if (server.error) line(color.yellow(`${symbols.warn} ${server.server}: ${server.error}`))
            if (server.freshness === 'unknown' || server.freshness === 'stale') {
              unsure = true
              line(color.yellow(`${symbols.warn} ${server.server} had not finished checking ${file.path}.`))
            }
          }
        }
        if (result.diagnostics.some((d) => d.severity === 'error')) return 1
        return unsure ? 3 : 0
      }
      default:
        line(color.red(`Unknown subcommand \`${sub}\`.`) + color.dim(' Use status, servers [file], install <id>, or check <file>...'))
        return 2
    }
  } catch (error) {
    line(color.red(`${symbols.cross} ${error instanceof Error ? error.message : String(error)}`))
    return 1
  } finally {
    await engine.stop().catch(() => undefined)
  }
}

export async function runDebugCommand(positional: string[], config: JeanConfig, cwd: string): Promise<number> {
  const sub = positional[0] ?? 'adapters'
  const engine = await openDebuggers(config, cwd)
  if (!engine) {
    notBuilt()
    return 1
  }
  try {
    switch (sub) {
      case 'status':
      case 'adapters': {
        const adapters = await engine.adapters(positional[1] ? resolve(cwd, positional[1]) : undefined)
        line()
        line(color.bold('Debug adapters'))
        line(color.dim(`  ${counts(adapters)}`))
        line()
        printAdapters(adapters)
        line()
        return 0
      }
      case 'install': {
        const id = positional[1]
        if (!id) {
          line(color.red('Usage: jean debug install <adapter-id>'))
          return 2
        }
        line(color.dim(`  Installing ${id}...`))
        const result = await engine.install(id)
        line(`${symbols.check} ${id}: ${color.cyan(result.path)}`)
        return 0
      }
      default:
        line(color.red(`Unknown subcommand \`${sub}\`.`) + color.dim(' Use adapters [file] or install <id>.'))
        return 2
    }
  } catch (error) {
    line(color.red(`${symbols.cross} ${error instanceof Error ? error.message : String(error)}`))
    return 1
  } finally {
    await engine.stop().catch(() => undefined)
  }
}

/** For `jean doctor`: how many servers and adapters are ready. */
export async function languageToolsSummary(
  config: JeanConfig,
  cwd: string,
): Promise<{ servers: string; debuggers: string; toolsDir: string; autoInstall: boolean } | undefined> {
  const servers = await openServers(config, cwd)
  const debuggers = await openDebuggers(config, cwd)
  if (!servers || !debuggers) return undefined
  const [list, adapters, status] = await Promise.all([servers.servers(), debuggers.adapters(), servers.status()])
  return { servers: counts(list), debuggers: counts(adapters), toolsDir: status.toolsDir, autoInstall: status.autoInstall }
}
