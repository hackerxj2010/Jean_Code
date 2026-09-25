import { TextAttributes } from '@opentui/core'
import { useState, type ReactNode } from 'react'

import { Button } from './button'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'
import { formatTimeout } from '../utils/format-timeout'
import { getLastNVisualLines } from '../utils/text-layout'

interface TerminalCommandDisplayProps {
  command: string
  output: string | null
  /** Unused since the box: the output is always behind its toggle. Kept for callers. */
  expandable?: boolean
  /** Lines of live output shown while the command runs (default 5). */
  maxVisibleLines?: number
  /** Whether command is still running */
  isRunning?: boolean
  /** Working directory where the command was run */
  cwd?: string
  /** Timeout in seconds for the command */
  timeoutSeconds?: number
  /** Optional width override for wrapping calculations */
  availableWidth?: number
  /** How the command ended: its exit code, or null when it was stopped. */
  exitCode?: number | null
  timedOut?: boolean
  /**
   * Whether the output is folded away. Given with `onToggle`, the caller owns
   * the state — a tool block keeps it in the chat store, so Ctrl+T folds and
   * unfolds every box at once; without them the box keeps its own.
   */
  collapsed?: boolean
  onToggle?: () => void
}

/** The longest output an unfolded box shows; the rest is summarised. */
const MAX_EXPANDED_LINES = 400

/**
 * A shell command in a box titled `bash`, as Gemini CLI shows one: the
 * command, how it ended, and its output folded until it is asked for.
 *
 *   ╭ bash ──────────────────────────────╮
 *   │ $ bun test                         │
 *   │ ✗ exit 1 · ▸ 42 lines of output    │
 *   ╰────────────────────────────────────╯
 *
 * While the command runs, its last few lines show live instead.
 */
export const TerminalCommandDisplay = ({
  command,
  output,
  maxVisibleLines,
  isRunning = false,
  timeoutSeconds,
  availableWidth,
  exitCode,
  timedOut = false,
  collapsed,
  onToggle,
}: TerminalCommandDisplayProps) => {
  const theme = useTheme()
  const { separatorWidth } = useTerminalDimensions()
  const [ownCollapsed, setOwnCollapsed] = useState(true)
  const isCollapsed = onToggle ? (collapsed ?? true) : ownCollapsed
  const toggle = onToggle ?? (() => setOwnCollapsed((value) => !value))

  // The timeout is worth a mention only when it is not the default (30s).
  const DEFAULT_TIMEOUT_SECONDS = 30
  const timeoutLabel =
    timeoutSeconds !== undefined && timeoutSeconds !== DEFAULT_TIMEOUT_SECONDS ? formatTimeout(timeoutSeconds) : null

  const failed = timedOut || (exitCode !== undefined && exitCode !== 0)
  const frame = isRunning ? theme.info : failed ? theme.error : theme.border

  // Inside the border and its one-cell padding on each side.
  const width = Math.max(10, (availableWidth ?? separatorWidth) - 4)
  const text = output?.replace(/\s+$/, '') ?? ''
  const wrapped = text ? text.split('\n').flatMap((line) => getLastNVisualLines(line, width, Infinity).lines) : []

  const status = isRunning ? (
    <span fg={theme.info}>⋯ running</span>
  ) : timedOut ? (
    <span fg={theme.warning}>⏱ timed out</span>
  ) : exitCode === null ? (
    <span fg={theme.warning}>■ stopped</span>
  ) : exitCode !== undefined && exitCode !== 0 ? (
    <span fg={theme.error}>✗ exit {exitCode}</span>
  ) : (
    <span fg={theme.success}>✓</span>
  )

  let body: ReactNode = null
  if (isRunning) {
    // Live: the tail of what it has printed so far.
    const tail = wrapped.slice(-(maxVisibleLines ?? 5))
    if (tail.length > 0) {
      body = (
        <text fg={theme.muted} style={{ wrapMode: 'none' }}>
          {tail.join('\n')}
        </text>
      )
    }
  } else if (wrapped.length > 0 && !isCollapsed) {
    const hidden = Math.max(0, wrapped.length - MAX_EXPANDED_LINES)
    body = (
      <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
        {hidden > 0 && (
          <text fg={theme.muted} attributes={TextAttributes.DIM}>
            … {hidden} earlier {hidden === 1 ? 'line' : 'lines'}
          </text>
        )}
        <text fg={theme.muted} style={{ wrapMode: 'none' }}>
          {wrapped.slice(hidden).join('\n')}
        </text>
      </box>
    )
  }

  const lines = wrapped.length
  const toggleLabel =
    lines === 0 ? 'no output' : isCollapsed ? `▸ ${lines} ${lines === 1 ? 'line' : 'lines'} of output` : '▾ hide output'

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={frame}
      title=" bash "
      titleAlignment="left"
      style={{ flexDirection: 'column', gap: 0, width: '100%', paddingLeft: 1, paddingRight: 1 }}
    >
      <text style={{ wrapMode: 'word' }}>
        <span fg={theme.success}>$ </span>
        <span fg={theme.foreground} attributes={TextAttributes.BOLD}>
          {command}
        </span>
        {timeoutLabel && (
          <span fg={theme.muted} attributes={TextAttributes.DIM}>
            {' '}({timeoutLabel})
          </span>
        )}
      </text>
      {isRunning ? (
        <text style={{ wrapMode: 'none' }}>{status}</text>
      ) : (
        <Button style={{ flexDirection: 'row', width: '100%' }} onClick={lines > 0 ? toggle : undefined}>
          <text style={{ wrapMode: 'none' }}>
            {status}
            <span fg={theme.muted}> · </span>
            <span fg={lines > 0 ? theme.secondary : theme.muted}>{toggleLabel}</span>
          </text>
        </Button>
      )}
      {body}
    </box>
  )
}
