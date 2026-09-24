/**
 * The agent client the interface talks to.
 *
 * Kept at this path because ~30 files import it here; the contents are Jean's.
 * The client itself lives in `compat/client.ts` — this is the process-wide
 * handle plus the two display helpers the renderers need.
 */

import { JeanClient } from '../compat/client'
import { getProjectRoot } from '../project-files'

import type { ToolResultOutput } from '../compat/types'

let instance: JeanClient | null = null

/**
 * The session's client, created once.
 *
 * One instance for the process because it owns the `EventStore`, and the whole
 * point of that store is that turn N+1 can see turn N.
 */
export async function getCodebuffClient(): Promise<JeanClient | null> {
  if (instance) return instance

  try {
    instance = new JeanClient({ cwd: getProjectRoot() })
    return instance
  } catch (error) {
    // Returning null rather than throwing: every call site already handles a
    // missing client by showing a message, and a throw here would take down
    // the render.
    return null
  }
}

/** Drops the cached client, so the next call rebuilds it against new config. */
export function resetCodebuffClient(): void {
  instance?.close('reset')
  instance = null
}

/**
 * Ends the session on the way out: the session file records its end, and the
 * language servers, debuggers, MCP servers, and kernels the agent started are
 * stopped rather than left running after the interface is gone.
 */
export function closeCodebuffClient(reason = 'user exit'): void {
  instance?.close(reason)
  instance = null
}

/**
 * Renders a tool's output for a card.
 *
 * Text passes through; JSON is pretty-printed. Both are capped — a card that
 * grows without bound pushes the conversation off screen, which is the thing
 * the user actually wants to read.
 */
export function formatToolOutput(output: ToolResultOutput[] | undefined): string {
  if (!output || output.length === 0) return ''

  const parts = output.map((entry) => {
    if (entry.type === 'text') return entry.value
    if (entry.type === 'error') return entry.message

    const value = entry.value
    if (typeof value === 'string') return value
    if (value === null || value === undefined) return ''

    try {
      return JSON.stringify(value, null, 2)
    } catch {
      // Circular structures reach here. Saying so beats an empty card.
      return '[unserializable result]'
    }
  })

  return clamp(parts.join('\n'))
}

/** 8 KB, past which a card is scrolling noise rather than information. */
const MAX_OUTPUT = 8192

function clamp(text: string): string {
  if (text.length <= MAX_OUTPUT) return text
  const kept = text.slice(0, MAX_OUTPUT)
  return `${kept}\n… ${text.length - MAX_OUTPUT} more characters`
}

/**
 * How a tool is labelled in the interface.
 *
 * `type` drives the icon and colour. Grouping by what the tool *does to the
 * world* rather than by name is what lets the reader scan a long run of cards
 * and see where the writes were.
 */
export function getToolDisplayInfo(toolName: string): { name: string; type: string } {
  const WRITE = new Set(['write', 'edit', 'multi_edit', 'patch', 'checkpoint'])
  const READ = new Set(['read', 'glob', 'grep', 'ast_grep', 'codemap_outline', 'codemap_overview'])
  const RUN = new Set(['bash', 'bash_output', 'bash_input'])
  const NET = new Set(['web_search', 'web_fetch', 'browser_open', 'browser_act', 'browser_inspect'])

  const type = WRITE.has(toolName)
    ? 'write'
    : READ.has(toolName)
      ? 'read'
      : RUN.has(toolName)
        ? 'run'
        : NET.has(toolName)
          ? 'network'
          : toolName === 'spawn'
            ? 'agent'
            : 'other'

  return { name: prettify(toolName), type }
}

/** `bash_output` becomes `Bash output`. */
function prettify(toolName: string): string {
  const spaced = toolName.replace(/[_-]+/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
