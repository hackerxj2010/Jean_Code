import type { JeanConfig, ModelRole } from '@jean/config'
import type { CompletionResponse, ContentBlock, ModelClient, StreamEvent } from '@jean/model'
import { ruleHitsOf } from '@jean/model'
import type { Registry, ToolContext, ToolResult } from '@jean/tools'
import { runsInParallel } from '@jean/tools'
import { compact } from './compaction.ts'
import { measureContextExact, trimToolResults } from './context.ts'
import type { EventStore } from './eventstore.ts'

/**
 * The multi-turn agent loop (architecture §6.2).
 *
 * One turn is: send the transcript, stream the response, run any tool calls,
 * append the results, repeat until the model stops calling tools. Everything
 * that happens is written to the [`EventStore`] first — the loop holds no state
 * of its own that could drift from it.
 *
 * Around that core sit the behaviours that separate a loop that finishes tasks
 * from one that merely runs:
 *
 * * Independent reads in one turn run **concurrently**. A model that asks for
 *   six files at once is waiting on the slowest, not the sum.
 * * A response **cut off** by the output limit is continued rather than
 *   mistaken for a finished answer.
 * * A call that keeps **failing identically** is named back to the model, which
 *   otherwise tends to retry it until the turn budget runs out.
 * * **Hooks** can veto or rewrite a call, annotate a result, or refuse to let
 *   the agent stop before a condition holds — the seam through which shell
 *   hooks, permission rules, and goal checks attach without the loop knowing
 *   which of them exist.
 */

/** A tool call as the hooks see it. */
export interface ToolCallRef {
  id: string
  name: string
  input: unknown
}

export interface BeforeToolDecision {
  /** Refuse the call; the model sees this reason as the tool's error. */
  deny?: string
  /** Run the call with these arguments instead of the model's. */
  input?: unknown
  /** Skip the confirmation the permission mode would otherwise ask for. */
  approve?: boolean
  /** Ask the user first, with this reason, whatever the mode says. */
  ask?: string
}

export interface AfterToolDecision {
  /** Appended to the result the model sees. */
  context?: string
}

export interface LoopHooks {
  beforeTool?: (call: ToolCallRef) => Promise<BeforeToolDecision | undefined> | BeforeToolDecision | undefined
  afterTool?: (
    call: ToolCallRef,
    result: ToolResult,
  ) => Promise<AfterToolDecision | undefined> | AfterToolDecision | undefined
  /**
   * The model has stopped calling tools. Return `continueWith` to hand it that
   * text and keep going — a failing test suite, an unmet goal, a hook's veto.
   */
  beforeStop?: (finalText: string) => Promise<{ continueWith?: string } | undefined> | { continueWith?: string } | undefined
  /** The context is about to be compacted. Observational: it cannot prevent it. */
  beforeCompact?: (trigger: 'auto' | 'manual') => Promise<void> | void
}

export interface LoopOptions {
  store: EventStore
  client: ModelClient
  registry: Registry
  config: JeanConfig
  toolContext: ToolContext
  /** System prompt. Rebuilt per turn so it can carry live state. */
  systemPrompt: string | (() => string)
  role?: ModelRole
  signal?: AbortSignal
  /** Called for every streaming event, for the TUI. */
  onEvent?: (event: LoopEvent) => void
  /** Hard cap on turns. Defaults to `config.maxTurns`. */
  maxTurns?: number
  hooks?: LoopHooks
  /**
   * Notes for the model gathered before each request — files changed on disk,
   * a stale task list. Each becomes a `reminder` event.
   */
  reminders?: () => string[] | Promise<string[]>
  /**
   * Waits before re-sending a turn that failed transiently (rate limit,
   * overloaded provider), after the HTTP layer's own quick retries gave up.
   */
  retryDelaysMs?: number[]
  /** How many times `beforeStop` may push the agent on. Default 8. */
  maxStopContinuations?: number
  /**
   * What to ask for when the turns run out. Given, the agent is warned on
   * its last turn with tools and then answers once more without them — so a
   * sub-agent that searched for eighteen turns reports what it found instead
   * of returning its last "let me check one more file".
   */
  wrapUp?: string
}

/**
 * Turn-level retry schedule. The HTTP layer retries within a second or two,
 * which clears a blip but not a rate limit — those need tens of seconds, and
 * a long autonomous run that dies on the first 429 loses all its progress.
 */
const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000]

/** What the loop reports as it runs. */
export type LoopEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown; summary: string }
  | { type: 'tool_end'; id: string; name: string; result: ToolResult; durationMs: number }
  | { type: 'turn_end'; turn: number; stopReason: string }
  | { type: 'compacted'; tokensBefore: number; tokensAfter: number }
  | { type: 'notice'; text: string }
  | { type: 'error'; message: string; fatal: boolean }
  /** Something a sub-agent did, under the `spawn` call that started it. */
  | { type: 'subagent'; agent: string; spawnId?: string; event: LoopEvent }

export interface LoopResult {
  /** The assistant's final text, with tool traffic removed. */
  text: string
  turns: number
  /** Why the loop stopped. */
  stopReason: 'complete' | 'max_turns' | 'aborted' | 'error' | 'blocked'
  toolCalls: number
  files: string[]
  error?: string
}

/** Consecutive "you were cut off, continue" nudges before giving up. */
const MAX_CONTINUATIONS = 3
/** Times a stop hook may push the agent on before the loop stops anyway. */
const MAX_STOP_CONTINUATIONS = 8
/** Identical failing calls in a row before the model is told it is looping. */
const FAILING_REPEAT_LIMIT = 3
/** Identical calls in a row, failing or not, before the same warning. */
const ANY_REPEAT_LIMIT = 5

/**
 * Runs the loop until the model stops calling tools.
 *
 * The caller has already appended the user's message to the store; this drives
 * the conversation from there.
 */
export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const { store, registry, config, toolContext, signal, onEvent, hooks } = options
  const maxTurns = options.maxTurns ?? config.maxTurns
  const role = options.role ?? 'default'

  let turns = 0
  let toolCalls = 0
  let finalText = ''
  let continuations = 0
  let stopContinuations = 0
  let nudgedEmpty = false
  const repeats = new RepeatTracker()

  const remind = (source: string, text: string) => {
    store.append({ type: 'reminder', at: Date.now(), source, text })
  }

  while (turns < maxTurns) {
    if (signal?.aborted) {
      return finish('aborted', 'The run was interrupted.')
    }

    turns++
    onEvent?.({ type: 'turn_start', turn: turns })

    for (const text of await gatherReminders(options)) remind('harness', text)
    if (options.wrapUp && maxTurns > 4 && turns === maxTurns) {
      remind('turn-limit', 'This is your last turn with tools. Check only what your report still needs; after this turn you will write it.')
    }

    const systemPrompt =
      typeof options.systemPrompt === 'function' ? options.systemPrompt() : options.systemPrompt

    // Compact before sending, not after: the point is to keep this request
    // inside the window, and afterwards is too late.
    await maybeCompact(options, systemPrompt, role)

    const messages = trimToolResults(store.transcript())
    const tools = registry.schemas(config.permissionMode)

    let response: CompletionResponse | undefined
    const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    for (let attempt = 0; response === undefined; attempt++) {
      try {
        response = await streamTurn(options, messages, systemPrompt, tools, role)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (signal?.aborted) return finish('aborted', 'The run was interrupted.')
        const delay = delays[attempt]
        if (isTransient(err) && delay !== undefined) {
          onEvent?.({
            type: 'notice',
            text: `${firstLine(message)} — retrying in ${Math.round(delay / 1000)}s (${attempt + 1}/${delays.length})`,
          })
          if (!(await pause(delay, signal))) return finish('aborted', 'The run was interrupted.')
          continue
        }
        store.append({ type: 'error', at: Date.now(), message, fatal: true })
        onEvent?.({ type: 'error', message, fatal: true })
        return finish('error', message)
      }
    }

    store.append({
      type: 'assistant_message',
      at: Date.now(),
      content: response.content,
      usage: response.usage,
      model: response.model,
    })

    const text = textOf(response.content)
    if (text) finalText = text

    const calls = response.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool_call' }> => block.type === 'tool_call',
    )

    onEvent?.({ type: 'turn_end', turn: turns, stopReason: response.stopReason })

    if (calls.length === 0) {
      // Cut off mid-answer: the text so far is not the answer, and stopping
      // here would hand the user half a sentence as the final result.
      if (response.stopReason === 'length' && continuations < MAX_CONTINUATIONS) {
        continuations++
        remind(
          'truncation',
          'Your response was cut off by the output token limit. Continue exactly where it stopped, without repeating what you already wrote.',
        )
        continue
      }

      // An empty turn is almost always a provider hiccup rather than a
      // decision; one nudge recovers it, more would mask a real problem.
      if (!text && !nudgedEmpty && turns > 1) {
        nudgedEmpty = true
        remind(
          'empty-response',
          'Your last response was empty. Continue working on the task, or state plainly that it is complete and what you verified.',
        )
        continue
      }

      const verdict = await safely(() => hooks?.beforeStop?.(finalText))
      if (
        verdict?.continueWith &&
        stopContinuations < (options.maxStopContinuations ?? MAX_STOP_CONTINUATIONS)
      ) {
        stopContinuations++
        remind('stop-hook', verdict.continueWith)
        onEvent?.({ type: 'notice', text: `Not done yet: ${firstLine(verdict.continueWith)}` })
        continue
      }

      return finish('complete')
    }
    continuations = 0

    const outcome = await runCalls(calls)
    if (outcome === 'aborted') return finish('aborted', 'The run was interrupted.')

    if (response.stopReason === 'length') {
      remind(
        'truncation',
        'Your last response hit the output token limit, so its final tool call may have been cut off. Keep each call smaller — for a large file, `write` a skeleton and fill it with `edit`s.',
      )
    }

    for (const warning of repeats.warnings()) {
      remind('repeat', warning)
      onEvent?.({ type: 'notice', text: firstLine(warning) })
    }
  }

  if (options.wrapUp && !signal?.aborted) {
    const closing = await closingTurn(options, options.wrapUp, role)
    if (closing) {
      finalText = closing
      return finish('max_turns')
    }
  }
  return finish('max_turns', `Stopped after ${maxTurns} turns without finishing.`)

  /**
   * Runs one turn's calls: consecutive parallel-safe calls as a batch, every
   * other call on its own, in the order the model issued them.
   */
  async function runCalls(
    calls: Extract<ContentBlock, { type: 'tool_call' }>[],
  ): Promise<'ok' | 'aborted'> {
    const batches = partition(calls, (call) => {
      const tool = registry.get(call.name)
      // An unknown tool fails instantly without touching anything.
      return tool === undefined || runsInParallel(tool)
    })

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b]!
      if (signal?.aborted) {
        // Every call the model issued must get a result, or the transcript
        // holds a tool call with no answer and the provider rejects the next
        // request outright. Recording the interruption keeps it valid.
        for (const call of batches.slice(b).flat()) {
          store.append({ type: 'tool_call', at: Date.now(), id: call.id, name: call.name, input: call.input })
          store.append({
            type: 'tool_result',
            at: Date.now(),
            id: call.id,
            name: call.name,
            output: 'Interrupted by the user before this ran.',
            isError: true,
          })
        }
        return 'aborted'
      }

      for (const call of batch) {
        toolCalls++
        const tool = registry.get(call.name)
        store.append({ type: 'tool_call', at: Date.now(), id: call.id, name: call.name, input: call.input })
        onEvent?.({
          type: 'tool_start',
          id: call.id,
          name: call.name,
          input: call.input,
          summary: safeSummarize(tool, call, toolContext),
        })
      }

      const results = await Promise.all(batch.map((call) => runOne(call)))

      batch.forEach((call, i) => {
        const { result, durationMs } = results[i]!
        store.append({
          type: 'tool_result',
          at: Date.now(),
          id: call.id,
          name: call.name,
          output: result.output,
          isError: result.isError,
          durationMs,
          touched: result.touched,
        })
        onEvent?.({ type: 'tool_end', id: call.id, name: call.name, result, durationMs })
        repeats.record(call.name, call.input, result)
      })
    }
    return 'ok'
  }

  async function runOne(call: ToolCallRef): Promise<{ result: ToolResult; durationMs: number }> {
    const started = Date.now()
    let input = call.input

    const before = await safely(() => hooks?.beforeTool?.(call))
    if (before?.deny) {
      return { result: { output: before.deny, isError: true }, durationMs: Date.now() - started }
    }
    if (before?.input !== undefined) input = before.input

    let result = await registry.call(call.name, input, { ...toolContext, callId: call.id }, {
      approve: before?.approve,
      ask: before?.ask,
    })

    const after = await safely(() => hooks?.afterTool?.({ ...call, input }, result))
    if (after?.context) {
      result = { ...result, output: `${result.output}\n\n${after.context}` }
    }
    return { result, durationMs: Date.now() - started }
  }

  function finish(stopReason: LoopResult['stopReason'], error?: string): LoopResult {
    return {
      text: finalText,
      turns,
      stopReason,
      toolCalls,
      files: store.touchedFiles(),
      error,
    }
  }
}

/**
 * Groups calls into runs that may execute together.
 *
 * Order is preserved and only *consecutive* parallel-safe calls share a batch:
 * a read issued after a write must see the write, so a serial call is a
 * barrier the batches never cross.
 */
export function partition<T>(items: T[], parallel: (item: T) => boolean): T[][] {
  const batches: T[][] = []
  let current: T[] = []
  for (const item of items) {
    if (parallel(item)) {
      current.push(item)
      continue
    }
    if (current.length > 0) batches.push(current)
    current = []
    batches.push([item])
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * Notices a model repeating itself.
 *
 * A model that gets the same error back tends to assume the fault was
 * transient and try again — indefinitely, since nothing in the transcript
 * changes. Naming the loop is usually enough to break it.
 */
export class RepeatTracker {
  private last?: { signature: string; name: string; count: number; failures: number; error: string }
  private pending: string[] = []

  record(name: string, input: unknown, result: ToolResult): void {
    const signature = `${name}:${stableStringify(input)}`
    if (this.last?.signature === signature) {
      this.last.count++
      if (result.isError) this.last.failures++
      else this.last.failures = 0
      this.last.error = result.isError ? result.output : this.last.error
    } else {
      this.last = {
        signature,
        name,
        count: 1,
        failures: result.isError ? 1 : 0,
        error: result.isError ? result.output : '',
      }
    }

    const { count, failures } = this.last
    if (failures === FAILING_REPEAT_LIMIT) {
      this.pending.push(
        `You have made the same \`${name}\` call ${failures} times in a row and it failed every time with:\n${clamp(firstLine(this.last.error), 300)}\nRepeating it will not change the result. Stop and re-examine: re-read the file or output involved, check the assumption the call rests on, and try a different approach.`,
      )
    } else if (count === ANY_REPEAT_LIMIT) {
      this.pending.push(
        `You have made the identical \`${name}\` call ${count} times in a row. Its result has not changed. Use what it returned, or do something different.`,
      )
    }
  }

  /** Warnings produced since the last call, each delivered once. */
  warnings(): string[] {
    const out = this.pending
    this.pending = []
    return out
  }
}

/** JSON with sorted keys, so argument order does not hide a repeat. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

async function gatherReminders(options: LoopOptions): Promise<string[]> {
  if (!options.reminders) return []
  try {
    return (await options.reminders()).filter((text) => text.trim() !== '')
  } catch {
    // A reminder source is an enhancement; it must not stop the turn.
    return []
  }
}

/** Streams one model turn, forwarding events and returning the final response. */
async function streamTurn(
  options: LoopOptions,
  messages: import('@jean/model').Message[],
  systemPrompt: string,
  tools: import('@jean/model').ToolSchema[],
  role: ModelRole,
): Promise<CompletionResponse> {
  const { client, store, config, signal, onEvent } = options

  const stream = client.stream(
    {
      messages,
      system: systemPrompt,
      tools: tools.length > 0 ? tools : undefined,
      effort: config.effort,
      signal,
    },
    role,
  )

  let response: CompletionResponse | undefined

  for await (const event of stream as AsyncGenerator<StreamEvent, void, void>) {
    switch (event.type) {
      case 'text':
        onEvent?.({ type: 'text', delta: event.delta })
        break
      case 'thinking':
        onEvent?.({ type: 'thinking', delta: event.delta })
        break
      case 'error':
        throw event.error
      case 'done': {
        response = event.response
        // A stream rule fired: the model went off-script mid-generation. Land
        // the reminder in the transcript so the next turn sees it.
        for (const hit of ruleHitsOf(event)) {
          store.append({
            type: 'advisor_note',
            at: Date.now(),
            level: 'concern',
            text: hit.reminder,
          })
          onEvent?.({ type: 'notice', text: hit.reminder })
        }
        break
      }
      default:
        break
    }
  }

  if (!response) throw new Error('the model stream ended without a response')
  return response
}

/**
 * One more answer, in words only: the report a run owes when its turns are
 * spent. Tool calls a provider sends anyway are dropped, so the transcript
 * never holds a call without a result.
 */
async function closingTurn(options: LoopOptions, ask: string, role: ModelRole): Promise<string | undefined> {
  const { store, registry, config, client, signal } = options
  store.append({ type: 'reminder', at: Date.now(), source: 'turn-limit', text: ask })
  const systemPrompt = typeof options.systemPrompt === 'function' ? options.systemPrompt() : options.systemPrompt
  try {
    const stream = client.stream(
      {
        messages: trimToolResults(store.transcript()),
        system: systemPrompt,
        tools: registry.schemas(config.permissionMode),
        toolChoice: 'none',
        effort: config.effort,
        signal,
      },
      role,
    )
    let response: CompletionResponse | undefined
    for await (const event of stream as AsyncGenerator<StreamEvent, void, void>) {
      if (event.type === 'text') options.onEvent?.({ type: 'text', delta: event.delta })
      if (event.type === 'error') throw event.error
      if (event.type === 'done') response = event.response
    }
    const content = (response?.content ?? []).filter((block) => block.type !== 'tool_call')
    const text = textOf(content)
    if (!text) return undefined
    store.append({ type: 'assistant_message', at: Date.now(), content, usage: response?.usage, model: response?.model })
    return text
  } catch {
    return undefined
  }
}

/** Compacts when the context is close to full. */
async function maybeCompact(
  options: LoopOptions,
  systemPrompt: string,
  role: ModelRole,
): Promise<void> {
  const { store, client, config, onEvent, signal } = options
  if (!config.autoCompact) return

  const resolved = client.resolve(role)
  const status = await measureContextExact(
    store.transcript(),
    systemPrompt,
    `${resolved.provider}:${resolved.modelId}`,
    config.compactThreshold,
    resolved.maxTokens,
  )
  if (!status.shouldCompact) return

  onEvent?.({
    type: 'notice',
    text: `Context is ${Math.round(status.ratio * 100)}% full — compacting.`,
  })

  await safely(() => options.hooks?.beforeCompact?.('auto'))
  const result = await compact(store, client, {
    reason: 'threshold',
    signal,
    appendix: compactionAppendix(options),
  })
  if (result) {
    onEvent?.({
      type: 'compacted',
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
    })
  }
}

/** The state a summary must carry exactly: the task list and the files touched. */
function compactionAppendix(options: LoopOptions): string {
  const sections: string[] = []
  const todos = options.toolContext.session.todos
  if (todos.length > 0) {
    const mark = { completed: '[x]', in_progress: '[~]', pending: '[ ]' } as const
    sections.push(
      ['## Task list at compaction (exact)', ...todos.map((t) => `- ${mark[t.status]} ${t.text}`)].join('\n'),
    )
  }
  const touched = options.store.touchedFiles()
  if (touched.length > 0) {
    sections.push(['## Files changed so far', ...touched.slice(-40).map((f) => `- ${f}`)].join('\n'))
  }
  return sections.join('\n\n')
}

/** Concatenated text blocks of a response, ignoring thinking and tool traffic. */
export function textOf(content: ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

/**
 * Runs a hook, treating a throw as "no opinion".
 *
 * A broken hook must not take the turn down with it — the same rule the
 * registry applies to tools. Whoever wrote the hook sees nothing happen and
 * can debug it; the agent keeps working either way.
 */
async function safely<T>(run: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch {
    return undefined
  }
}

/** A provider failure worth waiting out: rate limits, overload, network drops. */
function isTransient(err: unknown): boolean {
  return (err as { retryable?: unknown })?.retryable === true
}

/** Sleeps, waking early on abort. Resolves false when interrupted. */
function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * Builds the display summary for a tool call, tolerating malformed arguments.
 *
 * `summarize` runs before the registry validates anything, because the user
 * should see what the agent is attempting before it happens. That means it is
 * handed whatever the model produced, including calls missing required
 * arguments — and most `summarize` implementations reasonably assume their
 * arguments are well-formed (`args.path.split(...)`).
 *
 * Without this guard such a call throws *outside* the registry's try/catch and
 * takes down the whole turn, instead of coming back as a tool error the model
 * can see and correct on its next turn.
 */
function safeSummarize(
  tool: { name: string; summarize?: (args: never, context: ToolContext) => string } | undefined,
  call: { name: string; input: unknown },
  context: ToolContext,
): string {
  if (!tool?.summarize) return call.name
  try {
    return tool.summarize(call.input as never, context)
  } catch {
    return call.name
  }
}
