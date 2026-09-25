/**
 * The bridge between the interface and Jean's agent.
 *
 * The interface was written against a client whose `run()` streams events back;
 * `@jean/agent` exposes an `Orchestrator` that emits `LoopEvent`s. This
 * translates one into the other, so neither side has to know about the other's
 * vocabulary.
 *
 * Everything the interface needs from a run passes through here, which is the
 * point: when the agent's event shape changes, this file is the only thing that
 * moves.
 */

import { Orchestrator } from '@jean/agent'
import { EventStore, newSessionId } from '@jean/core'
import { ModelClient } from '@jean/model'
import { loadConfig, type Effort, type PermissionMode } from '@jean/config'
import { openMemory, type MemoryBackend } from '@jean/memory'

import { adaptInput, adaptOutput, renameTool } from './tool-names'

import type {
  MessageContent,
  PrintModeEvent,
  RunConfig,
  RunState,
  StreamChunk,
} from './types'

export interface ClientOptions {
  cwd: string
  /** Answers the `ask` tool. Absent means questions fail rather than hang. */
  ask?: (request: {
    question: string
    options?: { label: string; description?: string }[]
    multiple?: boolean
  }) => Promise<string | undefined>
  /** Asks the user to approve a destructive action. */
  confirm?: (request: { summary: string; detail?: string }) => Promise<boolean>
}

/**
 * A long-lived agent session.
 *
 * One orchestrator across runs, not one per run: it owns the `EventStore`, and
 * the whole point of that store is that turn N+1 can see turn N. Rebuilding it
 * per message would give the agent amnesia between prompts.
 */
export class JeanClient {
  private orchestrator?: Orchestrator
  private memory?: MemoryBackend
  private readonly sessionId = newSessionId()
  /** The configured effort and permission mode, which DEFAULT returns to. */
  private baseline?: { effort: Effort; permissionMode: PermissionMode }

  constructor(private readonly options: ClientOptions) {}

  /** Builds the orchestrator on first use, so construction cannot fail. */
  private async ensure(): Promise<Orchestrator> {
    if (this.orchestrator) return this.orchestrator

    const loaded = loadConfig({ cwd: this.options.cwd })
    this.baseline = { effort: loaded.config.effort, permissionMode: loaded.config.permissionMode }
    const client = new ModelClient({ config: loaded.config })
    this.memory ??= openMemory(loaded.config).backend

    this.orchestrator = new Orchestrator({
      config: loaded.config,
      client,
      cwd: this.options.cwd,
      sessionId: this.sessionId,
      memory: this.memory,
      store: new EventStore(),
      ask: this.options.ask,
      confirm: this.options.confirm,
    })

    return this.orchestrator
  }

  /** The orchestrator, for callers that need mode and config directly. */
  async agent(): Promise<Orchestrator> {
    return this.ensure()
  }

  /**
   * Runs one turn, streaming events to the interface.
   *
   * Resolves with a `RunState` to hand back next turn. It carries no history —
   * the `EventStore` has that — only what the footer needs.
   */
  async run(config: RunConfig): Promise<RunState> {
    const orchestrator = await this.ensure()

    // The mode picked in the interface decides how hard this turn thinks and
    // whether it may change anything; what it leaves unset is the config's.
    const mode = config.modeSettings ?? {}
    if (this.baseline) {
      orchestrator.config.effort = mode.effort ?? this.baseline.effort
      orchestrator.config.permissionMode = mode.permissionMode ?? this.baseline.permissionMode
    }

    // Sub-agents arrive as `tool_start` for `spawn` and have to be announced as
    // agents, not tools, or the interface renders a fan-out as a single opaque
    // call. Tracked by tool-call id so the matching finish can be paired.
    const spawned = new Map<string, string>()

    // Tool-call id to Jean's original tool name. The result event carries the
    // id but not the name the call went out under, and the result has to be
    // shaped the same way the input was.
    const calls = new Map<string, string>()

    const forward = (event: PrintModeEvent) => {
      try {
        config.handleEvent(event)
      } catch {
        // A render failure must not abort the agent mid-turn: the work is
        // already done and losing it to a UI bug is the worse outcome.
      }
    }

    // Tracked so a failure is only announced when the turn produced nothing —
    // a run that streamed an answer and *then* hit an error has already told
    // the user something, and appending a raw provider message to it reads as
    // part of the answer.
    let text = ''

    /** Ordinary assistant text, which the renderer takes as a bare string. */
    const say = (value: string) => {
      if (value === '') return
      text += value
      try {
        config.handleStreamChunk(value)
      } catch {
        /* as above */
      }
    }

    /** Reasoning, which renders collapsed rather than inline. */
    const think = (value: string) => {
      if (value === '') return
      try {
        config.handleStreamChunk({
          type: 'reasoning_chunk',
          chunk: value,
          // Empty means "the top-level agent", which is what puts this under
          // the main message rather than under a sub-agent's block.
          ancestorRunIds: [],
        })
      } catch {
        /* as above */
      }
    }

    const unsubscribe = attach(orchestrator, (raw) => {
      const event = raw as LoopEventLike
      switch (event.type) {
        case 'text':
          say(event.delta)
          break

        case 'thinking':
          think(event.delta)
          break

        case 'tool_start': {
          if (event.name === 'spawn') {
            const input = event.input as { agent?: string; prompt?: string } | undefined
            const agentType = input?.agent ?? 'general'
            spawned.set(event.id, agentType)
            forward({
              type: 'subagent_start',
              agentId: event.id,
              agentType,
              prompt: input?.prompt,
            })
            break
          }

          // Renamed here so every downstream consumer — the component
          // registry and the result-shaping special cases in
          // `updateToolBlockWithOutput` — sees the tool it was written for.
          forward({
            type: 'tool_call',
            toolCallId: event.id,
            toolName: renameTool(event.name),
            sourceToolName: event.name,
            input: adaptInput(
              event.name,
              event.input as Record<string, unknown> | undefined,
            ),
          })
          // The result arrives under a different event, by id, so the original
          // name has to be remembered to shape it the same way.
          calls.set(event.id, event.name)
          break
        }

        case 'tool_end': {
          const agentType = spawned.get(event.id)
          if (agentType !== undefined) {
            spawned.delete(event.id)
            forward({
              type: 'subagent_finish',
              agentId: event.id,
              agentType,
              output: event.result,
            })
            break
          }

          const jeanName = calls.get(event.id) ?? event.name
          calls.delete(event.id)

          forward({
            type: 'tool_result',
            toolCallId: event.id,
            output: adaptOutput(jeanName, event.result),
          })
          break
        }

        case 'error':
          // Non-fatal errors are shown and the run continues; a fatal one ends
          // the turn, and `finish` below reports it.
          if (!event.fatal) {
            say(`\n${event.message}\n`)
          }
          break

        default:
          break
      }
    })

    const abort = () => orchestrator.interrupt()
    config.signal.addEventListener('abort', abort, { once: true })

    try {
      // A custom command (`/review`, from .jean/commands or .claude/commands)
      // expands to its prompt before the agent sees it.
      const expanded = config.prompt.startsWith('/')
        ? await orchestrator.expandSlash(config.prompt)
        : undefined
      const prompt = buildPrompt(expanded?.prompt ?? config.prompt, config.content)
      const result = await orchestrator.send(prompt, { images: imagesOf(config.content) })

      // A failed turn has to *say* so. The interface renders `finish` as the
      // end of a message and does not display its `error` field, so a run that
      // died on a 402 or a bad key would otherwise look like the agent simply
      // had nothing to say — the user retries, it fails again, and nothing on
      // screen ever explains why.
      if (result.error !== undefined && result.error !== '' && text.length === 0) {
        say(`\n${result.error}\n`)
      }

      forward({
        type: 'finish',
        stopReason: result.stopReason,
        error: result.error,
      })

      return {
        sessionId: this.sessionId,
        turns: result.turns,
        output: { type: 'lastMessage', value: result.text },
      }
    } finally {
      config.signal.removeEventListener('abort', abort)
      unsubscribe()
    }
  }

  /** Ends the session and flushes the store. */
  close(reason = 'user exit'): void {
    this.orchestrator?.end(reason)
  }
}

/**
 * Subscribes to an orchestrator's events for the duration of one run.
 *
 * The orchestrator takes a single `onEvent` at construction, so this swaps in a
 * fan-out and restores it after. Not elegant, but it keeps the orchestrator's
 * interface small — and a subscriber list on a single-consumer object would be
 * dead weight everywhere else.
 */
function attach(
  orchestrator: Orchestrator,
  listener: (event: LoopEventLike) => void,
): () => void {
  const holder = orchestrator as unknown as {
    options: { onEvent?: (event: LoopEventLike) => void }
  }
  const previous = holder.options.onEvent

  holder.options.onEvent = (event) => {
    previous?.(event)
    listener(event)
  }

  return () => {
    holder.options.onEvent = previous
  }
}

/**
 * The subset of `LoopEvent` this file reads.
 *
 * Only the members that are actually destructured are listed. A catch-all
 * `{ type: string }` member would widen the union and defeat narrowing in the
 * switch, so the events this file ignores fall through `default` instead.
 */
type LoopEventLike =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown; summary: string }
  | { type: 'tool_end'; id: string; name: string; result: unknown; durationMs: number }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'turn_start' | 'turn_end' | 'compacted' | 'notice' }

/** Folds text attachments into the prompt; images travel separately. */
function buildPrompt(prompt: string, content: MessageContent[] | undefined): string {
  if (!content || content.length === 0) return prompt

  const extra = content
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .filter((text) => text.length > 0)

  return extra.length > 0 ? `${prompt}\n\n${extra.join('\n\n')}` : prompt
}

/**
 * The attached images, as the model receives them.
 *
 * They used to be reduced to "[1 image attached]" — the interface accepted a
 * pasted screenshot and the model never saw it, which is worse than refusing
 * the paste, because the user believes it was seen.
 */
function imagesOf(content: MessageContent[] | undefined): { mediaType: string; data: string }[] | undefined {
  const images = (content ?? [])
    .filter((part): part is Extract<MessageContent, { type: 'image' }> => part.type === 'image')
    .map((part) => ({
      mediaType: part.mediaType ?? 'image/png',
      // Tolerate a data URL as well as bare base64.
      data: part.image.replace(/^data:[^;]+;base64,/, ''),
    }))
  return images.length > 0 ? images : undefined
}

