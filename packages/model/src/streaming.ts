import type { StreamEvent } from './types.ts'

/**
 * Mid-stream rules (architecture §9.4).
 *
 * A rule watches the text as it streams. When its pattern matches, the stream
 * is annotated with a reminder the agent loop injects on the next turn — the
 * model course-corrects without a whole extra round trip spent on scolding it.
 *
 * Rules see a sliding window, not the whole output, so a long generation costs
 * the same to watch as a short one.
 */

export interface StreamRule {
  name: string
  /** Matched against recent output. Use `g`-free patterns; matching is per-check. */
  pattern: RegExp
  /** Text handed back to the model as a system reminder. */
  reminder: string
  /** Stop the generation entirely rather than just noting it. */
  abort?: boolean
  /** Fire at most this many times per stream. Defaults to 1. */
  maxFires?: number
}

/** A rule that fired during a stream. */
export interface RuleHit {
  rule: string
  reminder: string
  abort: boolean
  /** The text that triggered it, trimmed for display. */
  match: string
}

/** Characters of recent output each rule is matched against. */
const WINDOW = 2000

/**
 * Wraps a provider stream, applying rules to the text as it arrives.
 *
 * Hits are attached to the terminal `done` event under `ruleHits`, so the
 * caller sees them exactly once and in order.
 */
export async function* applyStreamRules(
  source: AsyncGenerator<StreamEvent, void, void>,
  rules: StreamRule[],
): AsyncGenerator<StreamEvent, void, void> {
  if (rules.length === 0) {
    yield* source
    return
  }

  let window = ''
  const hits: RuleHit[] = []
  const fired = new Map<string, number>()

  for await (const event of source) {
    if (event.type === 'text' || event.type === 'thinking') {
      window = (window + event.delta).slice(-WINDOW)

      for (const rule of rules) {
        const count = fired.get(rule.name) ?? 0
        if (count >= (rule.maxFires ?? 1)) continue
        const match = rule.pattern.exec(window)
        if (!match) continue

        fired.set(rule.name, count + 1)
        hits.push({
          rule: rule.name,
          reminder: rule.reminder,
          abort: rule.abort ?? false,
          match: match[0].slice(0, 200),
        })

        if (rule.abort) {
          yield {
            type: 'error',
            error: new Error(`stream rule "${rule.name}" aborted generation: ${rule.reminder}`),
          }
          return
        }
        // Clear the window so one match does not re-fire on the same text.
        window = ''
      }
    }

    if (event.type === 'done' && hits.length > 0) {
      yield { ...event, ruleHits: hits } as StreamEvent & { ruleHits: RuleHit[] }
      continue
    }
    yield event
  }
}

/** Reads rule hits off a `done` event, if any fired. */
export function ruleHitsOf(event: StreamEvent): RuleHit[] {
  if (event.type !== 'done') return []
  return (event as StreamEvent & { ruleHits?: RuleHit[] }).ruleHits ?? []
}

/**
 * Default rules.
 *
 * Each one targets a specific failure this harness sees in practice, not a
 * general style preference — a rule that fires on ordinary output is worse than
 * no rule at all.
 */
export function defaultStreamRules(): StreamRule[] {
  return [
    {
      name: 'placeholder-code',
      pattern: /(\/\/|#)\s*(\.\.\.|rest of|implementation goes here|your code here|TODO: implement)/i,
      reminder:
        'You left a placeholder instead of real code. Write the actual implementation — the file is being written to disk exactly as you produce it.',
    },
    {
      name: 'fabricated-success',
      pattern: /\b(tests? (now )?pass|all tests? (are )?(now )?passing|build succeeds?)\b/i,
      reminder:
        'You claimed a test or build outcome. Run the command and quote its output, or say you have not verified it.',
    },
    {
      name: 'unverified-file-claim',
      pattern: /\bI (have )?(already )?(created|updated|deleted) (the )?file\b/i,
      reminder:
        'State file changes only after the corresponding tool call has returned successfully.',
    },
  ]
}

/**
 * Collects a stream into its final response, discarding incremental events.
 * Useful for callers that want streaming's fallback behaviour but not its
 * chunks (sub-agents, the advisor, commit-message generation).
 */
export async function collect(
  source: AsyncGenerator<StreamEvent, void, void>,
): Promise<import('./types.ts').CompletionResponse> {
  for await (const event of source) {
    if (event.type === 'error') throw event.error
    if (event.type === 'done') return event.response
  }
  throw new Error('stream ended without a final response')
}
