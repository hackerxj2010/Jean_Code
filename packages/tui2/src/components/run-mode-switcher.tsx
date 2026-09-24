import { useKeyboard } from '@opentui/react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from './button'
import { useTheme } from '../hooks/use-theme'
import {
  RUN_MODE_LABELS,
  RUN_MODE_LABEL_WIDTH,
  RUN_MODES,
  useRunModeStore,
  type RunMode,
} from '../state/run-mode-store'
import { getCodebuffClient } from '../utils/codebuff-client'
import { logger } from '../utils/logger'

/** Centres a label inside a fixed width, so both segments are the same size. */
function centre(label: string, width: number): string {
  const spare = Math.max(0, width - label.length)
  const left = Math.floor(spare / 2)
  return ' '.repeat(left) + label + ' '.repeat(spare - left)
}

/**
 * The Auto / Swarm switch, centred at the top of the screen.
 *
 * Placed in the header rather than beside the prompt on purpose. This decides
 * *how many agents* run — a property of the session, changed rarely — while the
 * LITE/DEFAULT/MAX/PLAN toggle by the input decides effort and permissions for
 * the next message. Putting a rarely-changed session setting next to the thing
 * you touch every turn invites changing it by accident.
 *
 * Styled to match that effort chooser: the frame brightens under the cursor,
 * the label is bright when active and muted otherwise, and both segments are
 * padded to a common width so the control keeps its shape as the selection
 * moves. A toggle that resizes when you use it reads as a layout bug rather
 * than as feedback.
 *
 * Drawn here rather than with `SegmentedControl`, whose borders are hover-driven:
 * it frames whichever segment the mouse is over, and with no mouse it frames the
 * last one, which reads as "Swarm is selected" when it is not.
 *
 * The store is the display state; the orchestrator is the truth. This reads the
 * orchestrator once on mount so a project whose `.jean.json` sets `swarm` shows
 * swarm immediately rather than flashing the default and correcting itself.
 */
export function RunModeSwitcher() {
  const theme = useTheme()
  const [hovered, setHovered] = useState<RunMode | null>(null)

  const mode = useRunModeStore((state) => state.mode)
  const switching = useRunModeStore((state) => state.switching)
  const setMode = useRunModeStore((state) => state.setMode)
  const setSwitching = useRunModeStore((state) => state.setSwitching)

  useEffect(() => {
    let cancelled = false

    const readFromAgent = async () => {
      try {
        const client = await getCodebuffClient()
        if (!client || cancelled) return

        const orchestrator = await client.agent()
        const current = orchestrator.currentMode()
        if (!cancelled && (current === 'autonomous' || current === 'swarm')) {
          setMode(current)
        }
      } catch (error) {
        // The switcher still works if this fails — it just starts on the
        // default. Not worth a message on screen at startup.
        logger.debug({ err: error }, 'could not read the run mode from the agent')
      }
    }

    void readFromAgent()
    return () => {
      cancelled = true
    }
  }, [setMode])

  const change = useCallback(
    async (next: RunMode) => {
      if (next === mode || switching) return

      // Optimistic: the control responds to the click immediately and is put
      // back if the orchestrator refuses. Waiting for a round trip to redraw a
      // two-item toggle feels broken.
      const previous = mode
      setMode(next)
      setSwitching(true)

      try {
        const client = await getCodebuffClient()
        const orchestrator = await client?.agent()
        orchestrator?.setMode(next)
      } catch (error) {
        setMode(previous)
        logger.error({ err: error, next }, 'could not switch the run mode')
      } finally {
        setSwitching(false)
      }
    },
    [mode, switching, setMode, setSwitching],
  )

  // Ctrl+O cycles. A control that can only be clicked is unreachable over SSH,
  // in a terminal with mouse reporting off, and to anyone who does not use a
  // mouse — and this one changes how the whole session runs.
  //
  // Ctrl+O because C, T, and V are already bound and Shift+Tab belongs to the
  // slash menu.
  useKeyboard(
    useCallback(
      (key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => {
        if (key.ctrl && !key.meta && !key.shift && key.name === 'o') {
          const next = RUN_MODES[(RUN_MODES.indexOf(mode) + 1) % RUN_MODES.length]!
          void change(next)
        }
      },
      [mode, change],
    ),
  )

  return (
    <box
      style={{
        width: '100%',
        // Three rows, because each segment draws its own top, middle, and
        // bottom. Without an explicit height the last row overflows the parent
        // and wraps to column zero, which looks like a broken border.
        height: 3,
        flexDirection: 'row',
        justifyContent: 'center',
        backgroundColor: 'transparent',
      }}
    >
      {RUN_MODES.map((candidate, index) => {
        const active = candidate === mode
        const isHovered = hovered === candidate

        const content = ` ${centre(RUN_MODE_LABELS[candidate].label, RUN_MODE_LABEL_WIDTH)} `

        // Each segment draws its own *left* edge and the closing edge is added
        // once at the end, so neighbours share a divider (`┬`) rather than
        // butting two rounded corners together (`╮╭`).
        const first = index === 0
        const top = first ? '╭' : '┬'
        const bottom = first ? '╰' : '┴'
        const width = content.length + 1

        const frameColor = isHovered ? theme.foreground : theme.border
        const textColor = active
          ? theme.primary
          : isHovered
            ? theme.foreground
            : theme.muted

        return (
          <Button
            key={candidate}
            onClick={() => void change(candidate)}
            onMouseOver={() => setHovered(candidate)}
            onMouseOut={() => setHovered(null)}
            style={{
              flexDirection: 'column',
              gap: 0,
              width,
              minWidth: width,
            }}
          >
            <text fg={frameColor} selectable={false}>
              {`${top}${'─'.repeat(content.length)}`}
            </text>

            <text fg={frameColor} selectable={false}>
              {'│'}
              {active ? (
                <b>
                  <span style={{ fg: textColor }}>{content}</span>
                </b>
              ) : (
                <span style={{ fg: textColor }}>{content}</span>
              )}
            </text>

            <text fg={frameColor} selectable={false}>
              {`${bottom}${'─'.repeat(content.length)}`}
            </text>
          </Button>
        )
      })}

      {/* The right-hand edge, which belongs to the control rather than to the
          last segment — otherwise clicking it would select that segment. */}
      <box style={{ flexDirection: 'column', gap: 0, width: 1, minWidth: 1 }}>
        <text fg={theme.border} selectable={false}>╮</text>
        <text fg={theme.border} selectable={false}>│</text>
        <text fg={theme.border} selectable={false}>╯</text>
      </box>
    </box>
  )
}

/**
 * The current mode as one line, for the status bar.
 *
 * Exported so the status bar does not import the store and duplicate the label
 * table.
 */
export function useRunModeLabel(): string {
  const mode = useRunModeStore((state) => state.mode)
  return RUN_MODE_LABELS[mode].label
}
