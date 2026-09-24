import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

/**
 * Which mode the agent runs in (architecture §4).
 *
 * Two, and the distinction is who does the work:
 *
 * - **autonomous** — one agent, working the request through itself. It
 *   delegates only when a sub-agent would save context: searching a large tree,
 *   sweeping the web, driving a browser, a second read on a diff.
 * - **swarm** — a team, with the main agent leading. Worth its cost when the
 *   work genuinely splits into parts that do not need to see each other.
 *
 * Not to be confused with `AgentMode` (LITE/DEFAULT/MAX/PLAN), the toggle in
 * the input bar. That one sets *effort and permissions* for a single agent;
 * this one sets *how many agents there are*. They compose — a swarm can run in
 * PLAN mode, and it will read and plan without writing anything.
 */
export type RunMode = 'autonomous' | 'swarm'

export const RUN_MODES: RunMode[] = ['autonomous', 'swarm']

/**
 * What the segmented control shows.
 *
 * `Auto` rather than `Autonomous`: the two segments are drawn to a common width
 * so the control does not jump when the selection changes, and that width is
 * set by the longest label. `Autonomous` made the pair twice as wide as it
 * needed to be, which put a ten-character word where a glance was wanted.
 */
export const RUN_MODE_LABELS: Record<RunMode, { label: string; description: string }> = {
  autonomous: {
    label: 'Auto',
    description: 'One agent, delegating only when it saves context',
  },
  swarm: {
    label: 'Swarm',
    description: 'A team of agents on one ambitious task',
  },
}

/** The width every segment is padded to, so neither is wider than the other. */
export const RUN_MODE_LABEL_WIDTH = Math.max(
  ...RUN_MODES.map((mode) => RUN_MODE_LABELS[mode].label.length),
)

interface RunModeState {
  mode: RunMode
  /** True while the orchestrator is being told about a change. */
  switching: boolean
  setMode: (mode: RunMode) => void
  setSwitching: (switching: boolean) => void
  toggle: () => void
}

export const useRunModeStore = create<RunModeState>()(
  immer((set, get) => ({
    // Matches the config default. The real value is read from the orchestrator
    // on mount, so a project that set `mode` in `.jean.json` shows that
    // instead of flashing this one first.
    mode: 'autonomous',
    switching: false,

    setMode: (mode) => {
      set((state) => {
        state.mode = mode
      })
    },

    setSwitching: (switching) => {
      set((state) => {
        state.switching = switching
      })
    },

    /** Cycles to the next mode, for a keyboard shortcut. */
    toggle: () => {
      const current = get().mode
      const next = RUN_MODES[(RUN_MODES.indexOf(current) + 1) % RUN_MODES.length]!
      set((state) => {
        state.mode = next
      })
    },
  })),
)
