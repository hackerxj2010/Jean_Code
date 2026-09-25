/**
 * Reading a tool call for display.
 *
 * A finished call arrives as `[{ type: 'json', value }]` (see
 * `compat/tool-names.ts`), where `value` holds the tool's `display` fields next
 * to its readable `output` text. The block also keeps a clamped string copy in
 * `output`, which is what older results and the terminal path carry. Both are
 * handled here so a card never has to parse JSON itself.
 */

import type { ContentBlock } from '../types/chat'

type ToolBlock = Extract<ContentBlock, { type: 'tool' }>

export type ToolStatus = 'running' | 'done' | 'error'

export interface ParsedToolResult {
  /** No result yet. */
  pending: boolean
  isError: boolean
  /** The readable answer: the tool's text, or an error message. */
  text: string
  /** Structured fields from the tool's `display`, minus the text. */
  fields: Record<string, unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function firstValue(raw: unknown): unknown {
  if (Array.isArray(raw)) {
    const entry = raw[0] as { type?: string; value?: unknown; message?: string } | undefined
    if (!entry) return undefined
    if (entry.type === 'error') return { errorMessage: entry.message, isError: true }
    return entry.value
  }
  return raw
}

export function parseToolResult(block: ToolBlock): ParsedToolResult {
  const hasRaw = block.outputRaw !== undefined
  if (!hasRaw && block.output === undefined) {
    return { pending: true, isError: false, text: '', fields: {} }
  }

  let value = hasRaw ? firstValue(block.outputRaw) : undefined
  if (value === undefined && typeof block.output === 'string') {
    try {
      value = firstValue(JSON.parse(block.output))
    } catch {
      value = block.output
    }
  }

  if (typeof value === 'string') {
    return { pending: false, isError: false, text: value, fields: {} }
  }
  if (!isRecord(value)) {
    return { pending: false, isError: false, text: '', fields: {} }
  }

  const { output, isError, errorMessage, stdout, stderr, ...fields } = value
  const error = typeof errorMessage === 'string' ? errorMessage : ''
  const streams = `${typeof stdout === 'string' ? stdout : ''}${typeof stderr === 'string' ? stderr : ''}`
  const text = typeof output === 'string' && output !== '' ? output : streams || error

  // A shell command that exited non-zero failed, whoever ran it.
  const failedExit = typeof fields.exitCode === 'number' && fields.exitCode !== 0

  return {
    pending: false,
    isError: isError === true || error !== '' || failedExit,
    text,
    fields,
  }
}

export function toolStatus(result: ParsedToolResult, isStreaming: boolean): ToolStatus {
  if (result.isError) return 'error'
  if (isStreaming || result.pending) return 'running'
  return 'done'
}

/** `max_results` and `maxResults` both become `Max results`. */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

/** A one-line version of any value, for headers and inline fields. */
export function inlineValue(value: unknown, max = 80): string {
  let text: string
  if (value === null || value === undefined) text = '—'
  else if (typeof value === 'boolean') text = value ? 'yes' : 'no'
  else if (typeof value === 'string') text = value.replace(/\s+/g, ' ').trim()
  else if (typeof value === 'number') text = String(value)
  else if (Array.isArray(value)) {
    text = value.every((v) => typeof v !== 'object' || v === null)
      ? value.map((v) => inlineValue(v, max)).join(', ')
      : plural(value.length, 'item')
  } else if (isRecord(value)) {
    const keys = Object.keys(value)
    text =
      keys.length === 0
        ? '—'
        : keys.map((k) => `${humanizeKey(k)}: ${inlineValue(value[k], 24)}`).join(' · ')
  } else text = String(value)
  return truncate(text, max)
}

export function truncate(text: string, max: number): string {
  if (max <= 1 || text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

export function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? ''
  )
}

export function stringArg(input: unknown, ...keys: string[]): string {
  if (!isRecord(input)) return ''
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

export { isRecord }
