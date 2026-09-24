/**
 * What the interface used to import from `@codebuff/common`.
 *
 * One file rather than the 30-odd module paths the originals lived at: the
 * total is a few hundred lines, and splitting it to mirror somebody else's
 * layout would be cargo cult. `tsconfig` maps every old path here.
 */

import { readdirSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'

import type { FileTreeNode, Logger, PathInfo } from './types'

// ---- environment ----------------------------------------------------------

export const IS_DEV = process.env.NODE_ENV === 'development'
export const IS_TEST = process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test'
export const IS_CI = process.env.CI === 'true' || process.env.CI === '1'

export const env = process.env

export function getBaseEnv(): NodeJS.ProcessEnv {
  return process.env
}

export type BaseEnv = NodeJS.ProcessEnv
export type ClientEnv = NodeJS.ProcessEnv

// ---- agent limits ---------------------------------------------------------

/**
 * Turn cap for one run.
 *
 * High enough that a real task finishes, low enough that a loop the model
 * cannot break out of costs bounded money rather than unbounded money.
 */
export const MAX_AGENT_STEPS_DEFAULT = 50

/** The file the agent writes durable project notes to. */
export const PRIMARY_KNOWLEDGE_FILE_NAME = 'JEAN.md'

// ---- strings --------------------------------------------------------------

/**
 * Removes ANSI escape sequences.
 *
 * Covers SGR colour codes and the OSC-8 hyperlinks that terminal links use —
 * measuring a string's width with either still in it gives a number far larger
 * than what is on screen, and the layout collapses.
 */
export function stripAnsi(text: string): string {
  const CSI = String.fromCharCode(27) + '\\['
  const OSC = String.fromCharCode(27) + '\\]'
  const BEL = String.fromCharCode(7)
  const ST = String.fromCharCode(27) + '\\\\'

  return text
    .replace(new RegExp(`${OSC}8;;.*?(${BEL}|${ST})`, 'g'), '')
    .replace(new RegExp(`${CSI}[0-9;?]*[a-zA-Z]`, 'g'), '')
}

/**
 * `1 file` / `2 files`, without a call site having to hold the plural.
 * `{ includeCount: false }` gives the word alone: "the questions".
 */
export function pluralize(
  count: number,
  singular: string,
  plural?: string | { plural?: string; includeCount?: boolean },
): string {
  const options = typeof plural === 'string' ? { plural } : (plural ?? {})
  const word = count === 1 ? singular : (options.plural ?? `${singular}s`)
  return options.includeCount === false ? word : `${count} ${word}`
}

// ---- errors ---------------------------------------------------------------

export function getErrorObject(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack }
  }
  return { message: typeof error === 'string' ? error : JSON.stringify(error) }
}

/**
 * Pulls a usable message out of a provider's error response.
 *
 * Providers nest the useful sentence differently — `error.message`,
 * `error.error.message`, `error.detail` — and showing the raw JSON instead
 * means the user reads a blob to find one line.
 */
export function extractApiErrorDetails(error: unknown): {
  message: string
  status?: number
  code?: string
} {
  if (typeof error !== 'object' || error === null) {
    return { message: String(error) }
  }

  const candidate = error as Record<string, unknown>
  const nested = candidate.error as Record<string, unknown> | undefined

  const message =
    pickString(nested?.message) ??
    pickString(candidate.message) ??
    pickString(candidate.detail) ??
    pickString(nested?.detail) ??
    'Unknown error'

  const status =
    pickNumber(candidate.status) ??
    pickNumber(candidate.statusCode) ??
    pickNumber(nested?.status)

  const code = pickString(candidate.code) ?? pickString(nested?.code)

  return { message, ...(status !== undefined && { status }), ...(code !== undefined && { code }) }
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

// ---- dates ----------------------------------------------------------------

/** "in 3h 20m" / "in 45 min" / "in under a minute". */
export function formatTimeUntil(target: Date | number | string, options: { fallback?: string } = {}): string {
  const at = target instanceof Date ? target.getTime() : typeof target === 'string' ? Date.parse(target) : target
  const ms = at - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return options.fallback ?? 'any moment now'

  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

// ---- images ---------------------------------------------------------------

export const SUPPORTED_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

export const IMAGE_EXTENSIONS_PATTERN = /\.(png|jpe?g|gif|webp|bmp)$/i

/** 5 MB — past this an image costs more context than it is worth. */
export const MAX_IMAGE_FILE_SIZE = 5 * 1024 * 1024
export const MAX_IMAGE_BASE64_SIZE = Math.floor(MAX_IMAGE_FILE_SIZE * 1.37)
export const MAX_TOTAL_IMAGE_SIZE = 20 * 1024 * 1024

export function getImageMimeType(filePath: string): string {
  const extension = filePath.toLowerCase().split('.').pop() ?? ''
  switch (extension) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'bmp':
      return 'image/bmp'
    default:
      return 'application/octet-stream'
  }
}

// ---- the project file tree ------------------------------------------------

/**
 * Directories never walked.
 *
 * Without this, building the tree for a JS project walks `node_modules` and
 * takes long enough that the interface looks hung at startup.
 */
const SKIP = new Set([
  '.git',
  'node_modules',
  'target',
  'dist',
  'build',
  '.next',
  '.turbo',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'coverage',
])

/** How many entries the tree may hold before it stops growing. */
const MAX_ENTRIES = 20_000

export function getProjectFileTree(root: string, maxDepth = 8): FileTreeNode[] {
  let budget = MAX_ENTRIES

  const walk = (directory: string, depth: number): FileTreeNode[] => {
    if (depth > maxDepth || budget <= 0) return []

    let entries: string[]
    try {
      entries = readdirSync(directory)
    } catch {
      // An unreadable directory is skipped, not fatal: a permission error deep
      // in the tree should not stop the interface from starting.
      return []
    }

    const nodes: FileTreeNode[] = []
    for (const name of entries.sort()) {
      if (budget <= 0) break
      if (name.startsWith('.') && name !== '.env.example') continue
      if (SKIP.has(name)) continue

      const full = join(directory, name)
      let isDirectory: boolean
      try {
        isDirectory = statSync(full).isDirectory()
      } catch {
        continue
      }

      budget--
      nodes.push(
        isDirectory
          ? {
              name,
              type: 'directory',
              filePath: relative(root, full).split(sep).join('/'),
              children: walk(full, depth + 1),
            }
          : { name, type: 'file', filePath: relative(root, full).split(sep).join('/') },
      )
    }
    return nodes
  }

  return walk(root, 0)
}

/** The tree flattened, for `@`-completion and the picker. */
export function getAllPathsWithDirectories(nodes: FileTreeNode[]): PathInfo[] {
  const out: PathInfo[] = []

  const visit = (list: FileTreeNode[]) => {
    for (const node of list) {
      out.push({ path: node.filePath, type: node.type })
      if (node.children) visit(node.children)
    }
  }

  visit(nodes)
  return out
}

export function fileName(filePath: string): string {
  return basename(filePath)
}

// ---- skills ---------------------------------------------------------------

/** A skill as the interface lists and invokes it; `content` is its instructions. */
export interface SkillDefinition {
  name: string
  description: string
  content: string
  path: string
  source: 'project' | 'user' | 'builtin'
}

export type SkillsMap = Record<string, SkillDefinition>

// ---- logging --------------------------------------------------------------

/**
 * A logger that writes to a file, never to the terminal.
 *
 * Writing to stdout would corrupt the alternate-screen buffer the interface is
 * drawing into — the output lands in the middle of the frame and stays there
 * until the next full repaint.
 */
export function createLogger(): Logger {
  const noop = () => {}
  return { debug: noop, info: noop, warn: noop, error: noop }
}

// ---- removed hosted features ----------------------------------------------
//
// Kept as inert constants so the call sites still compile. Each is a feature of
// Codebuff's service, not of a local coding agent.

export const CHATGPT_OAUTH_ENABLED = false
export const SUBSCRIPTION_DISPLAY_NAME = ''

export const FeedbackCategory = {
  Bug: 'bug',
  Idea: 'idea',
  Other: 'other',
} as const

export type FeedbackCategory = (typeof FeedbackCategory)[keyof typeof FeedbackCategory]

export function isFreebuffModelId(_id?: unknown): boolean {
  return false
}

export function getFreebuffModel(): undefined {
  return undefined
}

export function formatFreebuffHardBlockedPrivacySignals(): string {
  return ''
}

export type FreebuffCountryBlockReason = string
export type FreebuffIpPrivacySignal = string

export interface RenderUIButtonWidget {
  type: 'button'
  label: string
  action: string
}

// The real implementation: it connects the agent's `ask` tool to the
// questionnaire on screen, so it is not a removed feature.
export { AskUserBridge } from './ask-user-bridge'
export type {
  AskAnswer,
  AskQuestion,
  AskRequest,
  AskResponse,
} from './ask-user-bridge'

export type { FileTreeNode, Logger, PathInfo }
/** MCP servers as the interface lists them; Jean's own come from `@jean/mcp`. */
export interface MCPConfig {
  mcpServers: Record<string, unknown>
}

export type {
  AgentDefinition,
  PrintModeEvent,
  PrintModeFinish,
  PrintModeSubagentFinish,
  PrintModeSubagentStart,
  PrintModeToolCall,
  PrintModeToolResult,
  ToolResultOutput,
} from './types'
