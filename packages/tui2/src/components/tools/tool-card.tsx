/**
 * The frame every tool call is drawn in, and the pieces that fill it.
 *
 * A card is a rounded box: a header line (icon, what ran, on what, and how it
 * ended) and a body that shows arguments and results as a person would write
 * them — labelled fields, lists, checklists, readable text — never as JSON.
 */

import { TextAttributes } from '@opentui/core'
import { type ReactNode, useState } from 'react'

import { useTheme } from '../../hooks/use-theme'
import {
  type ToolStatus,
  humanizeKey,
  inlineValue,
  isRecord,
  truncate,
} from '../../utils/tool-result'
import { Button } from '../button'

import type { ChatTheme } from '../../types/theme-system'

export type ToolCategory =
  | 'read'
  | 'write'
  | 'run'
  | 'search'
  | 'network'
  | 'git'
  | 'code'
  | 'debug'
  | 'memory'
  | 'agent'
  | 'plan'
  | 'security'
  | 'other'

/** The accent a category's icon is drawn in. */
export function categoryColor(category: ToolCategory, theme: ChatTheme): string {
  switch (category) {
    case 'read':
      return theme.link
    case 'write':
      return theme.warning
    case 'run':
      return theme.success
    case 'search':
      return theme.info
    case 'network':
      return theme.secondary
    case 'git':
      return theme.warning
    case 'code':
      return theme.link
    case 'debug':
      return theme.error
    case 'memory':
      return theme.secondary
    case 'agent':
      return theme.primary
    case 'plan':
      return theme.primary
    case 'security':
      return theme.error
    default:
      return theme.muted
  }
}

interface ToolCardProps {
  icon: string
  title: string
  /** What the call acted on: a path, a command, a query. */
  subtitle?: string
  category: ToolCategory
  status: ToolStatus
  /** Short outcome shown on the right: "12 lines", "exit 0", "3 matches". */
  meta?: string
  availableWidth: number
  collapsed?: boolean
  onToggle?: () => void
  /** One line shown under the header while collapsed. */
  preview?: string
  children?: ReactNode
}

const STATUS_GLYPH: Record<ToolStatus, string> = {
  running: '◌',
  done: '✓',
  error: '✗',
}

export const ToolCard = ({
  icon,
  title,
  subtitle,
  category,
  status,
  meta,
  availableWidth,
  collapsed = false,
  onToggle,
  preview,
  children,
}: ToolCardProps) => {
  const theme = useTheme()
  const accent = categoryColor(category, theme)
  const borderColor =
    status === 'error' ? theme.error : status === 'running' ? theme.primary : theme.border
  const statusColor =
    status === 'error' ? theme.error : status === 'running' ? theme.primary : theme.success

  const toggle = onToggle ? (collapsed ? '▸ ' : '▾ ') : ''
  const statusText =
    status === 'running'
      ? `${STATUS_GLYPH.running} running`
      : `${STATUS_GLYPH[status]}${meta ? ` ${meta}` : ''}`

  // Border and padding take four cells; the status sits on the right.
  const inner = Math.max(20, availableWidth - 4)
  const fixed = toggle.length + icon.length + 1 + title.length + 2 + statusText.length + 2
  const subtitleRoom = Math.max(0, inner - fixed)
  const shownSubtitle = subtitle ? truncate(subtitle.replace(/\s+/g, ' '), subtitleRoom) : ''

  const header = (
    <box style={{ flexDirection: 'row', justifyContent: 'space-between', width: '100%' }}>
      <text style={{ wrapMode: 'none', flexShrink: 1 }}>
        {toggle ? <span fg={theme.muted}>{toggle}</span> : null}
        <span fg={accent} attributes={TextAttributes.BOLD}>{`${icon} `}</span>
        <span fg={theme.foreground} attributes={TextAttributes.BOLD}>
          {title}
        </span>
        {shownSubtitle ? <span fg={theme.muted}>{`  ${shownSubtitle}`}</span> : null}
      </text>
      <text style={{ wrapMode: 'none', flexShrink: 0 }}>
        <span fg={statusColor} attributes={status === 'running' ? TextAttributes.DIM : undefined}>
          {` ${statusText}`}
        </span>
      </text>
    </box>
  )

  const showBody = !collapsed && children !== null && children !== undefined && children !== false
  const showPreview = collapsed && preview !== undefined && preview !== ''

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={borderColor}
      style={{
        flexDirection: 'column',
        width: '100%',
        paddingLeft: 1,
        paddingRight: 1,
        marginTop: 0,
        marginBottom: 0,
      }}
    >
      {onToggle ? (
        <Button style={{ flexDirection: 'column', width: '100%' }} onClick={onToggle}>
          {header}
        </Button>
      ) : (
        header
      )}
      {showPreview ? (
        <text style={{ wrapMode: 'none' }} fg={theme.muted} attributes={TextAttributes.ITALIC}>
          {truncate(preview, inner - 2)}
        </text>
      ) : null}
      {showBody ? (
        <box style={{ flexDirection: 'column', width: '100%', gap: 0 }}>{children}</box>
      ) : null}
    </box>
  )
}

/** A labelled part of a card body: "Arguments", "Result", "Matches". */
export const CardSection = ({ label, children }: { label?: string; children: ReactNode }) => {
  const theme = useTheme()
  return (
    <box style={{ flexDirection: 'column', width: '100%', marginTop: 0 }}>
      {label ? (
        <text style={{ wrapMode: 'none' }} fg={theme.muted} attributes={TextAttributes.BOLD}>
          {label}
        </text>
      ) : null}
      {children}
    </box>
  )
}

/**
 * Label/value rows, aligned: the human reading of an argument object.
 * Nested objects and lists are drawn beneath their label, indented.
 */
export const FieldList = ({
  fields,
  omit = [],
  maxValueLength = 400,
}: {
  fields: Record<string, unknown>
  omit?: string[]
  maxValueLength?: number
}) => {
  const theme = useTheme()
  const entries = Object.entries(fields).filter(
    ([key, value]) =>
      !omit.includes(key) &&
      value !== undefined &&
      value !== '' &&
      !(Array.isArray(value) && value.length === 0),
  )
  if (entries.length === 0) return null
  const labelWidth = Math.min(18, Math.max(...entries.map(([key]) => humanizeKey(key).length)))

  return (
    <box style={{ flexDirection: 'column', width: '100%' }}>
      {entries.map(([key, value]) => {
        const label = humanizeKey(key).padEnd(labelWidth)
        const nested =
          (Array.isArray(value) && value.some((v) => typeof v === 'object' && v !== null)) ||
          isRecord(value)
        const multiline = typeof value === 'string' && value.includes('\n')
        if (nested || multiline) {
          return (
            <box key={key} style={{ flexDirection: 'column', width: '100%' }}>
              <text fg={theme.muted}>{label}</text>
              <box style={{ paddingLeft: 2, width: '100%' }}>
                {multiline ? (
                  <TextBlock text={value as string} maxLines={12} />
                ) : (
                  <ReadableValue value={value} depth={1} />
                )}
              </box>
            </box>
          )
        }
        return (
          <text key={key} style={{ wrapMode: 'word' }}>
            <span fg={theme.muted}>{`${label}  `}</span>
            <span fg={theme.foreground}>{inlineValue(value, maxValueLength)}</span>
          </text>
        )
      })}
    </box>
  )
}

/** Any value, drawn as fields, bullets, or text — whichever reads naturally. */
export const ReadableValue = ({ value, depth = 0 }: { value: unknown; depth?: number }) => {
  const theme = useTheme()

  if (typeof value === 'string') {
    return value.includes('\n') ? (
      <TextBlock text={value} maxLines={12} />
    ) : (
      <text fg={theme.foreground} style={{ wrapMode: 'word' }}>
        {value}
      </text>
    )
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <text fg={theme.muted}>none</text>
    const shown = value.slice(0, 20)
    return (
      <box style={{ flexDirection: 'column', width: '100%' }}>
        {shown.map((item, index) =>
          isRecord(item) && depth < 3 ? (
            <box key={index} style={{ flexDirection: 'row', width: '100%' }}>
              <text fg={theme.muted}>{'• '}</text>
              <box style={{ flexDirection: 'column', flexGrow: 1 }}>
                <FieldList fields={item} maxValueLength={120} />
              </box>
            </box>
          ) : (
            <text key={index} style={{ wrapMode: 'word' }}>
              <span fg={theme.muted}>{'• '}</span>
              <span fg={theme.foreground}>{inlineValue(item, 200)}</span>
            </text>
          ),
        )}
        {value.length > shown.length ? (
          <text fg={theme.muted}>{`… ${value.length - shown.length} more`}</text>
        ) : null}
      </box>
    )
  }
  if (isRecord(value) && depth < 3) return <FieldList fields={value} />
  return <text fg={theme.foreground}>{inlineValue(value, 200)}</text>
}

/**
 * Preformatted text — command output, file listings, the tool's answer —
 * shown up to `maxLines`, with the rest one click away.
 */
export const TextBlock = ({
  text,
  maxLines = 10,
  color,
  tail = false,
}: {
  text: string
  maxLines?: number
  color?: string
  /** Keep the last lines rather than the first (logs, build output). */
  tail?: boolean
}) => {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  const lines = text.replace(/\s+$/, '').split('\n')
  if (lines.length === 1 && lines[0] === '') return null

  const hidden = Math.max(0, lines.length - maxLines)
  const shown =
    expanded || hidden === 0 ? lines : tail ? lines.slice(-maxLines) : lines.slice(0, maxLines)

  const more =
    hidden > 0 ? (
      <Button style={{ width: '100%' }} onClick={() => setExpanded(!expanded)}>
        <text fg={theme.secondary} attributes={TextAttributes.UNDERLINE}>
          {expanded
            ? 'Show less'
            : `${tail ? '↑' : '↓'} ${hidden} more line${hidden === 1 ? '' : 's'}`}
        </text>
      </Button>
    ) : null

  return (
    <box style={{ flexDirection: 'column', width: '100%' }}>
      {tail && !expanded ? more : null}
      <text fg={color ?? theme.foreground} style={{ wrapMode: 'word' }}>
        {shown.join('\n')}
      </text>
      {!tail || expanded ? more : null}
    </box>
  )
}

/** A list with a glyph per row: files, matches, results, checklist items. */
export const ItemList = ({
  items,
  maxItems = 12,
}: {
  items: {
    glyph?: string
    glyphColor?: string
    text: string
    detail?: string
    dim?: boolean
    strike?: boolean
  }[]
  maxItems?: number
}) => {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  if (items.length === 0) return <text fg={theme.muted}>nothing found</text>

  const hidden = Math.max(0, items.length - maxItems)
  const shown = expanded ? items : items.slice(0, maxItems)

  return (
    <box style={{ flexDirection: 'column', width: '100%' }}>
      {shown.map((item, index) => (
        <text key={index} style={{ wrapMode: 'word' }}>
          <span fg={item.glyphColor ?? theme.muted}>{`${item.glyph ?? '•'} `}</span>
          <span
            fg={item.dim ? theme.muted : theme.foreground}
            attributes={item.strike ? TextAttributes.STRIKETHROUGH : undefined}
          >
            {item.text}
          </span>
          {item.detail ? <span fg={theme.muted}>{`  ${item.detail}`}</span> : null}
        </text>
      ))}
      {hidden > 0 ? (
        <Button style={{ width: '100%' }} onClick={() => setExpanded(!expanded)}>
          <text fg={theme.secondary} attributes={TextAttributes.UNDERLINE}>
            {expanded ? 'Show less' : `↓ ${hidden} more`}
          </text>
        </Button>
      ) : null}
    </box>
  )
}
