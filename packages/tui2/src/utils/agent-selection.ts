/**
 * What the mode toggle in the input bar actually selects.
 *
 * The interface cycles through four labels — DEFAULT, LITE, MAX, PLAN. In the
 * tool this was ported from, those chose a *billing tier* and a hosted agent id.
 * Jean has neither: it has an effort level and a permission mode, both local.
 * So the toggle maps onto those instead, which is what those labels meant to a
 * user anyway. `compat/client.ts` applies them to each turn.
 *
 * | label   | effort     | permissions | what the user gets                   |
 * |---------|------------|-------------|--------------------------------------|
 * | DEFAULT | configured | configured  | whatever the config says             |
 * | LITE    | fast       | configured  | quick answers, minimal reasoning     |
 * | MAX     | xhigh      | configured  | the deepest reasoning the model has  |
 * | PLAN    | configured | plan        | reads and plans, cannot write or run |
 *
 * DEFAULT inherits rather than naming values: a user who configured `ask`
 * permissions must not be switched to `auto` by picking the default mode.
 * PLAN is the one that changes safety rather than spend: it hides every
 * mutating tool from the model, so the agent cannot edit or execute even if it
 * decides it should.
 */

import type { AgentMode } from './constants'

export interface ModeSettings {
  /** Absent: the configured effort. */
  effort?: 'fast' | 'normal' | 'high' | 'xhigh'
  /** Absent: the configured permission mode. */
  permissionMode?: 'auto' | 'ask' | 'plan' | 'full'
  /** One line for the menu. */
  description: string
}

const SETTINGS: Record<AgentMode, ModeSettings> = {
  DEFAULT: {
    description: 'Default mode: the configured effort and permissions',
  },
  LITE: {
    effort: 'fast',
    description: 'Lite mode: quick answers, minimal reasoning',
  },
  MAX: {
    effort: 'xhigh',
    description: 'Max mode: the deepest reasoning the model offers',
  },
  PLAN: {
    permissionMode: 'plan',
    description: 'Plan mode: reads and plans, changes nothing',
  },
}

export function getModeSettings(mode: AgentMode): ModeSettings {
  return SETTINGS[mode] ?? SETTINGS.DEFAULT
}

/**
 * Which agent a mode runs as.
 *
 * Always the main agent. The mode changes how it thinks and what it is allowed
 * to do, not who it is — and a mode toggle that silently swapped in a different
 * agent would make the conversation history mean something different from one
 * turn to the next.
 */
export function getAgentIdForMode(_mode: AgentMode): string {
  return 'main'
}

/** Whether a mode forbids writes and commands. */
export function isReadOnlyMode(mode: AgentMode): boolean {
  return getModeSettings(mode).permissionMode === 'plan'
}
