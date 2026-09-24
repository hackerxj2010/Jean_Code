import type { JeanConfig } from '@jean/config'
import type { EventStore, JeanEvent } from '@jean/core'
import { renderTranscript } from '@jean/core'
import { collect, type ModelClient } from '@jean/model'

/**
 * `@jean/advisor` — a second model watching the first (architecture §13).
 *
 * The advisor sees what the main agent just did and can raise a note, a
 * concern, or a blocker. It runs on its own context and its own model, so it is
 * not subject to the same tunnel vision as the agent it is reviewing.
 *
 * It is on by default in autonomous mode and off in focus mode, because the
 * value is proportional to how long the agent runs unattended.
 */

export type Level = 'note' | 'concern' | 'blocker'

export interface Advice {
  level: Level
  text: string
}

const LEVELS: Level[] = ['note', 'concern', 'blocker']

const SYSTEM_PROMPT = `You are reviewing another coding agent's most recent actions, as they happen.

Your job is to catch what the agent rushed past. Raise something only when it is concrete and specific to what you just saw. Silence is the correct output most of the time.

Respond with exactly one line, in one of these forms:

  OK
  NOTE: <one sentence>
  CONCERN: <one sentence>
  BLOCKER: <one sentence>

Use each level for what it means:

- NOTE — worth knowing, does not change what the agent should do next.
- CONCERN — the agent is likely to produce a wrong or incomplete result unless it adjusts.
- BLOCKER — continuing will destroy work, break something, or produce something actively wrong.

Raise a BLOCKER for: destructive commands run without cause, edits to files the user did not ask about, credentials or secrets about to be written into a file, a claim that tests pass when no test was run, or an approach that has already failed twice.

Do not comment on style. Do not restate what the agent did. Do not encourage. If nothing meets the bar, answer exactly "OK".`

export interface AdvisorOptions {
  client: ModelClient
  config: JeanConfig
  /** How many recent events to show the advisor. */
  window?: number
}

export class Advisor {
  private readonly options: AdvisorOptions
  /** Advice already raised, so the same point is not made twice. */
  private readonly said = new Set<string>()

  constructor(options: AdvisorOptions) {
    this.options = options
  }

  get enabled(): boolean {
    return this.options.config.advisor.enabled === true
  }

  /**
   * Reviews the most recent turn.
   *
   * Returns `undefined` when the advisor has nothing to say, which is the
   * common case and costs one cheap call.
   */
  async review(store: EventStore, signal?: AbortSignal): Promise<Advice | undefined> {
    if (!this.enabled) return undefined

    const recent = this.recentEvents(store)
    if (recent.length === 0) return undefined

    let text: string
    try {
      const response = await collect(
        this.options.client.stream(
          {
            system: SYSTEM_PROMPT,
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: `What the agent just did:\n\n${recent}` }],
              },
            ],
            maxTokens: 200,
            temperature: 0,
            signal,
          },
          'advisor',
        ),
      )
      text = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()
    } catch {
      // The advisor is an enhancement. If its model is unavailable, the agent
      // carries on rather than stopping — a watchdog that halts the process it
      // watches is worse than no watchdog.
      return undefined
    }

    const advice = parseAdvice(text)
    if (!advice) return undefined

    // Deduplicate: the same concern raised every turn becomes noise the agent
    // learns to ignore.
    const key = `${advice.level}:${advice.text.toLowerCase().slice(0, 60)}`
    if (this.said.has(key)) return undefined
    this.said.add(key)

    return advice
  }

  /** Whether this advice should be surfaced to the user, not just the agent. */
  shouldEscalate(advice: Advice): boolean {
    const threshold = this.options.config.advisor.escalateAt ?? 'blocker'
    return LEVELS.indexOf(advice.level) >= LEVELS.indexOf(threshold)
  }

  /** Renders the last few events as text for the advisor to read. */
  private recentEvents(store: EventStore): string {
    const window = this.options.window ?? 12
    const events = store.all().slice(-window)
    const lines: string[] = []

    for (const event of events as JeanEvent[]) {
      switch (event.type) {
        case 'user_message':
          lines.push(`USER: ${clamp(event.text, 500)}`)
          break
        case 'assistant_message':
          lines.push(clamp(renderTranscript([{ role: 'assistant', content: event.content }]), 1200))
          break
        case 'tool_call':
          lines.push(`TOOL CALL ${event.name}(${clamp(JSON.stringify(event.input ?? {}), 400)})`)
          break
        case 'tool_result':
          lines.push(
            `TOOL RESULT ${event.name}${event.isError ? ' [error]' : ''}: ${clamp(event.output, 600)}`,
          )
          break
        default:
          break
      }
    }

    return lines.join('\n')
  }
}

/** Parses the advisor's single-line response. */
export function parseAdvice(text: string): Advice | undefined {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  if (!line || /^ok\b/i.test(line)) return undefined

  const match = /^(NOTE|CONCERN|BLOCKER)\s*:\s*(.+)$/i.exec(line)
  if (!match) return undefined

  const body = match[2]!.trim()
  if (body.length < 8) return undefined

  return { level: match[1]!.toLowerCase() as Level, text: body }
}

/** Appends advice to the store so the agent sees it on its next turn. */
export function injectAdvice(store: EventStore, advice: Advice): void {
  store.append({ type: 'advisor_note', at: Date.now(), level: advice.level, text: advice.text })
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`
}
