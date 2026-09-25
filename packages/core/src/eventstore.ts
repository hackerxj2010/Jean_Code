import type { ContentBlock, Message, Usage } from '@jean/model'

/**
 * The EventStore — single source of truth for a session (architecture §6.2).
 *
 * Everything that happens is an append-only event: a user turn, an assistant
 * turn, a tool call, a compaction. The message transcript sent to the model is
 * *derived* from those events, never mutated in place.
 *
 * That distinction is what makes the hard features tractable. Rewind is a
 * truncation. Compaction is an event that changes how earlier events project.
 * Session resume is a replay. The TUI is a subscriber. None of them need their
 * own bookkeeping.
 */

export type JeanEvent =
  | { type: 'session_start'; at: number; cwd: string; mode: string; model: string; title?: string }
  | {
      type: 'user_message'
      at: number
      text: string
      /** Images the user attached — screenshots, mockups, error dialogs. */
      images?: { mediaType: string; data: string }[]
    }
  | { type: 'assistant_message'; at: number; content: ContentBlock[]; usage?: Usage; model?: string }
  | { type: 'tool_call'; at: number; id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      at: number
      id: string
      name: string
      output: string
      isError?: boolean
      durationMs?: number
      touched?: string[]
    }
  | { type: 'thinking'; at: number; text: string }
  | {
      type: 'compaction'
      at: number
      /** Events before this index are replaced by `summary` in the transcript. */
      throughIndex: number
      summary: string
      tokensBefore: number
      tokensAfter: number
    }
  | { type: 'mode_change'; at: number; from: string; to: string }
  | { type: 'advisor_note'; at: number; level: 'note' | 'concern' | 'blocker'; text: string }
  /**
   * Something the harness needs the model to know that no tool reported: its
   * output was truncated, it is repeating a failing call, a file it read has
   * changed on disk. Rendered as a `<system-reminder>` so the model can tell
   * the harness's voice from the user's.
   */
  | { type: 'reminder'; at: number; source: string; text: string }
  | { type: 'error'; at: number; message: string; fatal: boolean }
  | { type: 'session_end'; at: number; reason: string }

export type EventListener = (event: JeanEvent, index: number) => void

export class EventStore {
  private readonly events: JeanEvent[] = []
  private readonly listeners = new Set<EventListener>()

  /** Appends an event and notifies subscribers. Returns its index. */
  append(event: JeanEvent): number {
    const index = this.events.length
    this.events.push(event)
    for (const listener of this.listeners) {
      // A misbehaving subscriber (a TUI render crash) must not corrupt state.
      try {
        listener(event, index)
      } catch {
        // Intentionally swallowed: the store is the source of truth, not the view.
      }
    }
    return index
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  all(): readonly JeanEvent[] {
    return this.events
  }

  get length(): number {
    return this.events.length
  }

  at(index: number): JeanEvent | undefined {
    return this.events[index]
  }

  /** Every event of one type, newest last. */
  ofType<T extends JeanEvent['type']>(type: T): Extract<JeanEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<JeanEvent, { type: T }> => e.type === type)
  }

  /** The most recent compaction, which bounds what the transcript replays. */
  lastCompaction(): { event: Extract<JeanEvent, { type: 'compaction' }>; index: number } | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i]!
      if (event.type === 'compaction') return { event, index: i }
    }
    return undefined
  }

  /**
   * Projects events into the message transcript sent to the model.
   *
   * Compaction is honoured here rather than by deleting events: the full
   * history stays on disk for rewind and for `jean sessions`, while the model
   * sees the summary plus everything after it.
   */
  transcript(): Message[] {
    const compaction = this.lastCompaction()
    const start = compaction ? compaction.index + 1 : 0
    const messages: Message[] = []

    if (compaction) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `[Earlier conversation, summarized]\n\n${compaction.event.summary}`,
          },
        ],
        timestamp: compaction.event.at,
      })
    }

    // Tool calls and their results must stay adjacent and correctly paired, or
    // providers reject the turn. Buffer results and flush them together.
    let pendingResults: ContentBlock[] = []

    const flush = () => {
      if (pendingResults.length === 0) return
      messages.push({ role: 'tool', content: pendingResults })
      pendingResults = []
    }

    for (let i = start; i < this.events.length; i++) {
      const event = this.events[i]!
      switch (event.type) {
        case 'user_message':
          flush()
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: event.text },
              ...(event.images ?? []).map((image) => ({
                type: 'image' as const,
                mediaType: image.mediaType,
                data: image.data,
              })),
            ],
            timestamp: event.at,
          })
          break
        case 'assistant_message':
          flush()
          messages.push({ role: 'assistant', content: event.content, timestamp: event.at })
          break
        case 'tool_result':
          pendingResults.push({
            type: 'tool_result',
            id: event.id,
            name: event.name,
            output: event.output,
            isError: event.isError,
          })
          break
        case 'advisor_note':
          flush()
          messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: `[Advisor — ${event.level}] ${event.text}`,
              },
            ],
            timestamp: event.at,
          })
          break
        case 'reminder':
          flush()
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: `<system-reminder>\n${event.text}\n</system-reminder>` },
            ],
            timestamp: event.at,
          })
          break
        default:
          break
      }
    }
    flush()

    return messages
  }

  /** Files touched by tool calls in this session, in first-touch order. */
  touchedFiles(): string[] {
    const seen = new Set<string>()
    for (const event of this.events) {
      if (event.type === 'tool_result') {
        for (const path of event.touched ?? []) seen.add(path)
      }
    }
    return [...seen]
  }

  /** Cumulative token usage. */
  usage(): Usage & { turns: number } {
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let turns = 0
    for (const event of this.events) {
      if (event.type === 'assistant_message') {
        turns++
        inputTokens += event.usage?.inputTokens ?? 0
        outputTokens += event.usage?.outputTokens ?? 0
        cacheReadTokens += event.usage?.cacheReadTokens ?? 0
        cacheWriteTokens += event.usage?.cacheWriteTokens ?? 0
      }
    }
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, turns }
  }

  /**
   * Truncates to `index` events, discarding the rest. This is `/rewind`: the
   * session returns to exactly the state it had at that point.
   */
  rewind(index: number): void {
    if (index < 0 || index >= this.events.length) return
    this.events.length = index
  }

  /** Serializes for session persistence. */
  toJSON(): JeanEvent[] {
    return [...this.events]
  }

  /** Rebuilds a store from persisted events. Listeners are not notified. */
  static fromJSON(events: JeanEvent[]): EventStore {
    const store = new EventStore()
    store.events.push(...events)
    return store
  }
}
