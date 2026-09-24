import type { Effort, Mode } from '@jean/config'

/**
 * Magic keywords (architecture §4).
 *
 * Words the user can drop into any prompt to change how that one turn runs.
 * They apply to a single turn, never to the session — a keyword that silently
 * raised the cost of every later prompt would be a trap.
 */

export interface KeywordEffect {
  /** Reasoning depth for this turn. */
  effort?: Effort
  /** Switch modes before running. */
  mode?: Mode
  /** Force read-only for this turn. */
  planOnly?: boolean
  /** Extra system-prompt sections. */
  notes: string[]
  /** Which keywords fired, for display. */
  matched: string[]
}

interface KeywordSpec {
  keyword: string
  pattern: RegExp
  description: string
  effort?: Effort
  mode?: Mode
  planOnly?: boolean
  note?: string
}

export const MAGIC_KEYWORDS: KeywordSpec[] = [
  {
    keyword: 'ultrathink',
    pattern: /\bultrathink\b/i,
    description: 'Maximum reasoning depth',
    effort: 'xhigh',
    note: `## This turn: ultrathink

Reason this through properly before acting. Consider the approaches available, what each would break, and what you might be assuming. State the reasoning that led to your choice.`,
  },
  {
    keyword: 'orchestrate',
    pattern: /\borchestrate\b/i,
    description: 'Fan out to sub-agents and verify each phase',
    mode: 'autonomous',
    note: `## This turn: orchestrate

Decompose the work and delegate the separable parts with \`spawn\`, running independent investigations in parallel. Verify each phase before building on it.`,
  },
  {
    keyword: 'workflowz',
    pattern: /\bworkflowz\b/i,
    description: 'Deterministic multi-agent workflow',
    mode: 'autonomous',
    note: `## This turn: workflow

Follow a fixed sequence: find the relevant files, plan, implement, review, verify. Do not skip a stage because the task looks small, and report the outcome of each.`,
  },
  {
    keyword: 'deep-review',
    pattern: /\bdeep[- ]review\b/i,
    description: 'Spawn a fleet of bug-hunting agents',
    effort: 'high',
    note: `## This turn: deep review

Spawn several \`librarian\` agents over different parts of the change, then consolidate. Report only findings you can tie to a concrete failure — a specific input or state that produces a wrong result.`,
  },
  {
    keyword: 'plan-first',
    pattern: /\bplan[- ]first\b/i,
    description: 'Read-only until the plan is approved',
    planOnly: true,
    effort: 'high',
    note: `## This turn: plan first

This turn is read-only. Investigate, then present the plan you would carry out and stop. Do not describe changes as though you made them.`,
  },
]

/** Scans a prompt for keywords and combines their effects. */
export function detectKeywords(prompt: string): KeywordEffect {
  const effect: KeywordEffect = { notes: [], matched: [] }

  for (const spec of MAGIC_KEYWORDS) {
    if (!spec.pattern.test(prompt)) continue
    effect.matched.push(spec.keyword)
    // Highest effort wins when several keywords are present.
    if (spec.effort && rank(spec.effort) > rank(effect.effort)) effect.effort = spec.effort
    if (spec.mode) effect.mode = spec.mode
    if (spec.planOnly) effect.planOnly = true
    if (spec.note) effect.notes.push(spec.note)
  }

  return effect
}

function rank(effort: Effort | undefined): number {
  return effort ? ['fast', 'normal', 'high', 'xhigh'].indexOf(effort) : -1
}

/** Keyword list for `/help`. */
export function describeKeywords(): string {
  return MAGIC_KEYWORDS.map((k) => `  ${k.keyword.padEnd(14)} ${k.description}`).join('\n')
}
