import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseJsonc } from '../parser.ts'
import type { McpServerConfig, PartialConfig } from '../types.ts'

/**
 * Import compatibility (architecture §24.4).
 *
 * On first run Jean Code reads configuration that already exists in the project
 * for eight other agents, so a repo that has been used with Cursor or Claude
 * Code keeps its rules, its MCP servers, and its instruction files without a
 * migration step.
 *
 * Nothing here writes to disk and nothing overrides an explicit Jean setting —
 * imports sit between defaults and `~/.jean/config.json` in precedence.
 */

export interface ImportedConfig {
  /** Config fragments to merge, in the order they were found. */
  config: PartialConfig
  /** Instruction/rule files discovered, as absolute paths. */
  instructionFiles: string[]
  /** Human-readable list of what was imported, for `jean doctor`. */
  sources: string[]
}

interface FormatSpec {
  name: string
  /** Directory or file, relative to the project root. */
  probe: string
  /** Instruction files to pick up, relative to the project root. */
  rules: string[]
  /** JSON files that may declare MCP servers, relative to the project root. */
  mcp: string[]
  /** Key inside the MCP JSON holding the server map. */
  mcpKey?: string
}

/** The eight formats, in the order the doc lists them. */
const FORMATS: FormatSpec[] = [
  {
    name: 'Claude Code',
    probe: '.claude',
    rules: ['CLAUDE.md', '.claude/CLAUDE.md'],
    mcp: ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json'],
    mcpKey: 'mcpServers',
  },
  {
    name: 'Cursor',
    probe: '.cursor',
    rules: ['.cursorrules', '.cursor/rules'],
    mcp: ['.cursor/mcp.json'],
    mcpKey: 'mcpServers',
  },
  {
    name: 'Windsurf',
    probe: '.windsurf',
    rules: ['.windsurfrules', '.windsurf/rules'],
    mcp: ['.windsurf/mcp_config.json'],
    mcpKey: 'mcpServers',
  },
  {
    name: 'Gemini CLI',
    probe: '.gemini',
    rules: ['GEMINI.md', '.gemini/GEMINI.md'],
    mcp: ['.gemini/settings.json'],
    mcpKey: 'mcpServers',
  },
  {
    name: 'Codex CLI',
    probe: '.codex',
    rules: ['AGENTS.md', '.codex/AGENTS.md'],
    mcp: ['.codex/config.json'],
    mcpKey: 'mcp_servers',
  },
  {
    name: 'Cline',
    probe: '.clinerules',
    rules: ['.clinerules'],
    mcp: ['.cline/mcp.json'],
    mcpKey: 'mcpServers',
  },
  {
    name: 'GitHub Copilot',
    probe: '.github/copilot-instructions.md',
    rules: ['.github/copilot-instructions.md'],
    mcp: [],
  },
  {
    name: 'VS Code',
    probe: '.vscode',
    rules: [],
    mcp: ['.vscode/mcp.json', '.vscode/settings.json'],
    mcpKey: 'mcp',
  },
]

/** Scans `root` for configuration belonging to other agents. */
export function importForeignConfig(root: string): ImportedConfig {
  const instructionFiles: string[] = []
  const sources: string[] = []
  const mcpServers: Record<string, McpServerConfig> = {}

  for (const format of FORMATS) {
    if (!existsSync(join(root, format.probe))) continue
    let used = false

    for (const rule of format.rules) {
      const abs = join(root, rule)
      if (!existsSync(abs)) continue
      // A rules *directory* (Cursor's `.cursor/rules/*.mdc`) contributes each file.
      if (statSync(abs).isDirectory()) {
        for (const entry of safeReaddir(abs)) {
          if (/\.(md|mdc|txt)$/i.test(entry)) {
            instructionFiles.push(join(abs, entry))
            used = true
          }
        }
      } else {
        instructionFiles.push(abs)
        used = true
      }
    }

    for (const file of format.mcp) {
      const abs = join(root, file)
      if (!existsSync(abs)) continue
      const servers = readMcpServers(abs, format.mcpKey ?? 'mcpServers')
      for (const [name, cfg] of Object.entries(servers)) {
        // First format to claim a name wins; later ones do not clobber it.
        if (!(name in mcpServers)) {
          mcpServers[name] = cfg
          used = true
        }
      }
    }

    if (used) sources.push(format.name)
  }

  const config: PartialConfig = {}
  if (Object.keys(mcpServers).length > 0) config.mcpServers = mcpServers

  return { config, instructionFiles: dedupe(instructionFiles), sources }
}

/**
 * Reads an MCP server map out of a foreign config file, normalizing the two
 * shapes in the wild: a flat `{name: {command, args}}` map, and VS Code's
 * `{servers: {...}}` nesting.
 */
function readMcpServers(path: string, key: string): Record<string, McpServerConfig> {
  let parsed: unknown
  try {
    parsed = parseJsonc(readFileSync(path, 'utf8'), path)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object') return {}

  const root = parsed as Record<string, unknown>
  let raw = root[key] ?? root.mcpServers ?? root.servers
  if (raw !== null && typeof raw === 'object' && 'servers' in (raw as object)) {
    raw = (raw as Record<string, unknown>).servers
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}

  const out: Record<string, McpServerConfig> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const v = value as Record<string, unknown>
    const server: McpServerConfig = {}
    if (typeof v.command === 'string') {
      server.type = 'stdio'
      server.command = v.command
    }
    if (Array.isArray(v.args) && v.args.every((a) => typeof a === 'string')) {
      server.args = v.args as string[]
    }
    if (typeof v.url === 'string') {
      // Claude Code writes `"type": "http"` for Streamable HTTP; an untyped
      // url is left untyped so the client can negotiate the transport.
      server.url = v.url
      if (v.type === 'http' || v.type === 'streamable-http') server.type = 'http'
      else if (v.type === 'sse') server.type = 'sse'
      else delete server.type
    }
    if (v.env !== null && typeof v.env === 'object' && !Array.isArray(v.env)) {
      server.env = v.env as Record<string, string>
    }
    if (v.headers !== null && typeof v.headers === 'object' && !Array.isArray(v.headers)) {
      server.headers = v.headers as Record<string, string>
    }
    // A foreign entry with neither a command nor a URL cannot be started.
    if (server.command || server.url) out[name] = server
  }
  return out
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)]
}

/** The formats Jean Code knows how to read, for `jean doctor` output. */
export function supportedFormats(): string[] {
  return ['Jean Code', ...FORMATS.map((f) => f.name)]
}
