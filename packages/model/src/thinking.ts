import type { Effort } from '@jean/config'
import { supportsThinking } from './catalog.ts'

/**
 * Adaptive thinking and the effort slider (architecture §9.4).
 *
 * Two mechanisms, deliberately separate:
 *
 * * The **effort slider** is the user's explicit setting — `fast` to `xhigh`.
 * * **Adaptive thinking** raises effort for a single turn when the prompt looks
 *   hard, so the common case stays cheap without the user having to manage it.
 */

const ORDER: Effort[] = ['fast', 'normal', 'high', 'xhigh']

/** Moves effort up or down the scale, clamped at the ends. */
export function adjustEffort(effort: Effort, steps: number): Effort {
  const index = ORDER.indexOf(effort)
  const next = Math.min(Math.max(index + steps, 0), ORDER.length - 1)
  return ORDER[next]!
}

/** Magic keywords that pin effort regardless of heuristics (architecture §4). */
const KEYWORD_EFFORT: [RegExp, Effort][] = [
  [/\bultrathink\b/i, 'xhigh'],
  [/\bthink (harder|deeply|step by step)\b/i, 'high'],
  [/\bdeep[- ]review\b/i, 'high'],
  [/\bquick(ly)?\b|\bjust\b.*\bone[- ]liner\b/i, 'fast'],
]

/** Signals that a request is doing real engineering rather than a lookup. */
const HARD_SIGNALS = [
  /\brefactor\b/i,
  /\bmigrat(e|ion)\b/i,
  /\barchitect(ure)?\b/i,
  /\bdebug\b/i,
  /\brace condition\b/i,
  /\bdeadlock\b/i,
  /\bperformance\b/i,
  /\bwhy (does|is|are|do)\b/i,
  /\btrade[- ]?offs?\b/i,
  /\bdesign\b.*\bsystem\b/i,
]

/** Signals that a request is mechanical. */
const EASY_SIGNALS = [
  /^\s*(what|where|which)\s+(is|are)\b/i,
  /\brename\b/i,
  /\btypo\b/i,
  /\bformat\b/i,
  /\badd a comment\b/i,
  /^\s*(ls|cat|run|show)\b/i,
]

/**
 * Picks the effort for one turn.
 *
 * An explicit keyword always wins. Otherwise the base effort moves one step in
 * whichever direction the prompt suggests — never more, so the heuristic can
 * never take a `fast` session to `xhigh` behind the user's back.
 */
export function adaptiveEffort(prompt: string, base: Effort, enabled = true): Effort {
  for (const [pattern, effort] of KEYWORD_EFFORT) {
    if (pattern.test(prompt)) return effort
  }
  if (!enabled) return base

  const hard = HARD_SIGNALS.some((p) => p.test(prompt))
  const easy = EASY_SIGNALS.some((p) => p.test(prompt))
  if (hard && !easy) return adjustEffort(base, 1)
  if (easy && !hard) return adjustEffort(base, -1)
  // Long prompts carry more constraints to hold at once.
  if (prompt.length > 1500) return adjustEffort(base, 1)
  return base
}

/** Whether thinking should be requested at all for this model and effort. */
export function shouldThink(modelId: string, effort: Effort): boolean {
  return supportsThinking(modelId) && (effort === 'high' || effort === 'xhigh')
}

export { ORDER as EFFORT_LEVELS }
export type { Effort }
