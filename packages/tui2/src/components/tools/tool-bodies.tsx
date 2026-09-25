/**
 * Card bodies shared by several tools: a coloured diff, a terminal transcript,
 * a checklist, a code listing, and the fallback "arguments + result" layout.
 */

import { TextAttributes } from '@opentui/core'
import { type ReactNode, useState } from 'react'

import { useTheme } from '../../hooks/use-theme'
import { formatTimeout } from '../../utils/format-timeout'
import { Button } from '../button'
import { CardSection, FieldList, ReadableValue, TextBlock } from './tool-card'

import type { ParsedToolResult } from '../../utils/tool-result'

/** Diff colours tuned per mode; the theme's `success`/`error` read too loud on long diffs. */
const DIFF_COLORS = {
  dark: { added: '#7ACC35', removed: '#E07A76' },
  light: { added: '#2F7D12', removed: '#B42318' },
}

export const DiffBlock = ({ diff, maxLines = 40 }: { diff: string; maxLines?: number }) => {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  const colors = DIFF_COLORS[theme.mode]

  const lines = diff
    .replace(/\s+$/, '')
    .split('\n')
    .filter((line) => !line.startsWith('diff --git') && !line.startsWith('index '))
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
    return <text fg={theme.muted}>no changes</text>
  }

  const hidden = Math.max(0, lines.length - maxLines)
  const shown = expanded ? lines : lines.slice(0, maxLines)

  return (
    <box style={{ flexDirection: 'column', width: '100%' }}>
      {shown.map((line, index) => {
        if (line.startsWith('@@')) {
          const location = /\+(\d+)/.exec(line)?.[1]
          return (
            <text
              key={index}
              fg={theme.muted}
              attributes={TextAttributes.DIM}
              style={{ wrapMode: 'none' }}
            >
              {location ? `⋯ line ${location}` : '⋯'}
            </text>
          )
        }
        if (line.startsWith('+++') || line.startsWith('---')) {
          return (
            <text
              key={index}
              fg={theme.muted}
              attributes={TextAttributes.BOLD}
              style={{ wrapMode: 'none' }}
            >
              {line.replace(/^(\+\+\+|---) (a\/|b\/)?/, '')}
            </text>
          )
        }
        const fg = line.startsWith('+')
          ? colors.added
          : line.startsWith('-')
            ? colors.removed
            : theme.muted
        return (
          <text key={index} fg={fg} style={{ wrapMode: 'word' }}>
            {line === '' ? ' ' : line}
          </text>
        )
      })}
      {hidden > 0 ? (
        <Button style={{ width: '100%' }} onClick={() => setExpanded(!expanded)}>
          <text fg={theme.secondary} attributes={TextAttributes.UNDERLINE}>
            {expanded ? 'Show less' : `↓ ${hidden} more diff line${hidden === 1 ? '' : 's'}`}
          </text>
        </Button>
      ) : null}
    </box>
  )
}

/** `$ command` then its output, most recent lines first in view. */
export const TerminalBody = ({
  command,
  output,
  cwd,
  pending = false,
  timeoutSeconds,
}: {
  command: string
  output: string
  cwd?: string
  /** Still running: say nothing about output that has not arrived. */
  pending?: boolean
  timeoutSeconds?: number
}) => {
  const theme = useTheme()
  const footer = [
    cwd ? `in ${cwd}` : '',
    // Only set when the call chose its own limit, so always worth showing.
    timeoutSeconds !== undefined ? formatTimeout(timeoutSeconds) : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <box style={{ flexDirection: 'column', width: '100%' }}>
      {command ? (
        <text style={{ wrapMode: 'word' }}>
          <span fg={theme.success} attributes={TextAttributes.BOLD}>
            {'$ '}
          </span>
          <span fg={theme.foreground}>{command}</span>
        </text>
      ) : null}
      {/* A failure shows in the border and badge; a long log in red is unreadable. */}
      {output.trim() ? (
        <TextBlock text={output} maxLines={12} tail color={theme.muted} />
      ) : pending ? null : (
        <text fg={theme.muted} attributes={TextAttributes.ITALIC}>
          no output
        </text>
      )}
      {footer ? (
        <text fg={theme.muted} attributes={TextAttributes.DIM} style={{ wrapMode: 'none' }}>
          {footer}
        </text>
      ) : null}
    </box>
  )
}

export type ChecklistItem = {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  id?: string
}

export const Checklist = ({ items }: { items: ChecklistItem[] }) => {
  const theme = useTheme()
  return (
    <box style={{ flexDirection: 'column', width: '100%' }}>
      {items.map((item, index) => {
        const glyph = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◐' : '○'
        const glyphColor =
          item.status === 'completed'
            ? theme.success
            : item.status === 'in_progress'
              ? theme.primary
              : theme.muted
        return (
          <text key={item.id ?? index} style={{ wrapMode: 'word' }}>
            <span fg={glyphColor} attributes={TextAttributes.BOLD}>{`${glyph} `}</span>
            <span
              fg={item.status === 'completed' ? theme.muted : theme.foreground}
              attributes={
                item.status === 'completed'
                  ? TextAttributes.STRIKETHROUGH
                  : item.status === 'in_progress'
                    ? TextAttributes.BOLD
                    : undefined
              }
            >
              {item.text}
            </span>
          </text>
        )
      })}
    </box>
  )
}

/** Source code, with a gutter so it reads as code rather than prose. */
export const CodeBlock = ({ code, maxLines = 12 }: { code: string; maxLines?: number }) => {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  const lines = code.replace(/\s+$/, '').split('\n')
  const hidden = Math.max(0, lines.length - maxLines)
  const shown = expanded ? lines : lines.slice(0, maxLines)
  const width = String(shown.length).length

  return (
    <box style={{ flexDirection: 'column', width: '100%' }}>
      {shown.map((line, index) => (
        <text key={index} style={{ wrapMode: 'word' }}>
          <span
            fg={theme.muted}
            attributes={TextAttributes.DIM}
          >{`${String(index + 1).padStart(width)} │ `}</span>
          <span fg={theme.markdown?.codeTextFg ?? theme.foreground}>
            {line === '' ? ' ' : line}
          </span>
        </text>
      ))}
      {hidden > 0 ? (
        <Button style={{ width: '100%' }} onClick={() => setExpanded(!expanded)}>
          <text fg={theme.secondary} attributes={TextAttributes.UNDERLINE}>
            {expanded ? 'Show less' : `↓ ${hidden} more line${hidden === 1 ? '' : 's'}`}
          </text>
        </Button>
      ) : null}
    </box>
  )
}

/** An error, drawn so it cannot be mistaken for a result. */
export const ErrorText = ({ text }: { text: string }) => {
  const theme = useTheme()
  return (
    <TextBlock
      text={text || 'The tool failed without a message.'}
      maxLines={12}
      color={theme.error}
    />
  )
}

/**
 * The layout any tool gets unless it has something better: the arguments
 * that were not already in the header, then the answer, then any structured
 * detail the tool attached.
 */
export const GenericBody = ({
  args,
  omitArgs = [],
  result,
  omitFields = [],
  maxLines = 12,
}: {
  args: Record<string, unknown>
  omitArgs?: string[]
  result: ParsedToolResult
  omitFields?: string[]
  maxLines?: number
}) => {
  const shownArgs = Object.fromEntries(
    Object.entries(args).filter(([key]) => !omitArgs.includes(key)),
  )
  const extra = Object.fromEntries(
    Object.entries(result.fields).filter(
      // `kind` is plumbing and `count` is already the header's badge.
      ([key, value]) =>
        key !== 'kind' && key !== 'count' && !omitFields.includes(key) && !isBulky(value),
    ),
  )
  const hasArgs = Object.values(shownArgs).some((v) => v !== undefined && v !== '')
  const hasText = result.isError || result.text.trim() !== ''
  const hasExtra = Object.keys(extra).length > 0 && !result.isError

  return (
    <box style={{ flexDirection: 'column', width: '100%' }}>
      {hasArgs ? (
        <CardSection>
          <FieldList fields={shownArgs} maxValueLength={160} />
        </CardSection>
      ) : null}
      {hasText || hasExtra ? (
        <ResultRule show={hasArgs}>
          {result.isError ? (
            <ErrorText text={result.text} />
          ) : hasText ? (
            <TextBlock text={result.text} maxLines={maxLines} />
          ) : null}
          {hasExtra ? <ReadableValue value={extra} /> : null}
        </ResultRule>
      ) : null}
    </box>
  )
}

/** A hairline between what was asked and what came back. */
const ResultRule = ({ show, children }: { show: boolean; children: ReactNode }) => {
  const theme = useTheme()
  if (!show) return <box style={{ flexDirection: 'column', width: '100%' }}>{children}</box>
  return (
    <box
      border={['top']}
      borderStyle="single"
      borderColor={theme.border}
      style={{ flexDirection: 'column', width: '100%' }}
    >
      {children}
    </box>
  )
}

/** Whole files and long transcripts belong in their own view, not a field. */
function isBulky(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 300
  if (Array.isArray(value)) return value.length > 30
  return false
}
