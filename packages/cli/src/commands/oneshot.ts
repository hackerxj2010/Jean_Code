import type { JeanConfig } from '@jean/config'
import { Orchestrator } from '@jean/agent'
import { EventStore, newSessionId } from '@jean/core'
import { defaultStreamRules, ModelClient, providerEnv } from '@jean/model'
import { openMemory } from '@jean/memory'
import { Renderer } from '../render.ts'
import { color, errorLine, line, symbols } from '../ui.ts'

/**
 * One-shot mode: `jean -p "..."`.
 *
 * Non-interactive, so there is nobody to answer a confirmation prompt. Gated
 * calls are refused rather than assumed-approved — a script that silently
 * escalated its own permissions would be a genuinely bad surprise.
 */

export interface OneShotOptions {
  prompt: string
  config: JeanConfig
  cwd: string
  /** `stream-json` writes one JSON event per line as the run happens. */
  format: 'text' | 'json' | 'stream-json'
  quiet: boolean
  noSession: boolean
  /** Restored events, when `--resume` named a session. */
  store?: EventStore
  /** The resumed session's id, so the run appends to it rather than forking. */
  sessionId?: string
  /** A command that must pass before the run may finish. */
  verify?: string
}

export interface OneShotOutput {
  ok: boolean
  text: string
  turns: number
  toolCalls: number
  files: string[]
  stopReason: string
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    costUsd: number
  }
  sessionId: string
  error?: string
}

export async function runOneShot(options: OneShotOptions): Promise<number> {
  // A resumed run continues the same session file, so `jean --resume <id> -p ...`
  // carries the earlier conversation into the model's context.
  const sessionId = options.sessionId ?? newSessionId()
  const { backend: memory } = openMemory(options.config)

  let costUsd = 0
  const client = new ModelClient({
    config: options.config,
    streamRules: defaultStreamRules(),
    onUsage: (event) => {
      costUsd += event.costUsd
    },
  })

  if (!client.isConfigured()) {
    const resolved = client.resolve('default')
    // Name the variable this provider actually reads: "set the provider-specific
    // key" is exactly the part the user does not know.
    const expected = providerEnv(resolved.provider, options.config.providers)[0]
    const message = expected
      ? `No API key for ${resolved.provider}. Run \`jean auth login ${resolved.provider}\` or set ${expected}.`
      : `No API key for ${resolved.provider}. Run \`jean auth login ${resolved.provider}\`, or pick a connected provider with -m.`
    if (options.format !== 'text') {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`)
    } else {
      errorLine(color.red(`${symbols.cross} ${message}`))
    }
    return 2
  }

  // JSON output must stay parseable, so progress rendering is off in that mode
  // regardless of --quiet.
  const renderer =
    options.quiet || options.format !== 'text'
      ? undefined
      : new Renderer({ showDiffs: false })

  const orchestrator = new Orchestrator({
    config: options.config,
    client,
    cwd: options.cwd,
    sessionId,
    memory,
    store: options.store,
    verify: options.verify,
    onEvent:
      options.format === 'stream-json'
        ? (event) => emitJson(event)
        : renderer
          ? (event) => renderer.handle(event)
          : undefined,
  })

  const controller = new AbortController()
  const onSignal = () => {
    orchestrator.interrupt()
    controller.abort()
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  // A custom command works headless too: `jean -p "/review auth"`.
  const expanded = options.prompt.startsWith('/')
    ? await orchestrator.expandSlash(options.prompt)
    : undefined
  const result = await orchestrator.send(expanded?.prompt ?? options.prompt)
  renderer?.finish()
  orchestrator.end('one-shot complete')
  memory.close()

  const usage = orchestrator.store.usage()
  const output: OneShotOutput = {
    ok: result.stopReason === 'complete',
    text: result.text,
    turns: result.turns,
    toolCalls: result.toolCalls,
    files: result.files,
    stopReason: result.stopReason,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      costUsd: Number(costUsd.toFixed(6)),
    },
    sessionId,
    error: result.error,
  }

  if (options.format === 'json') {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  } else if (options.format === 'stream-json') {
    emitJson({ type: 'result', ...output })
  } else {
    if (renderer) line()
    else if (result.text) process.stdout.write(`${result.text}\n`)
    if (result.error) errorLine(color.red(`${symbols.cross} ${result.error}`))
  }

  // Cast to the plain emitter interface: the `process` typings overload these
  // names per-signal, and the union does not narrow from a variable.
  const emitter = process as NodeJS.EventEmitter
  emitter.off('SIGINT', onSignal)
  emitter.off('SIGTERM', onSignal)

  return output.ok ? 0 : 1
}

/**
 * One event per line, flushed as it happens — the shape CI and other harnesses
 * consume, since a long run can be followed (and cut short) while it works
 * rather than parsed only at the end.
 *
 * Streamed text and reasoning arrive a token at a time; they are coalesced
 * into one `text` or `thinking` event per block, flushed when anything else
 * happens. A line per token would bury the tool calls a consumer cares about.
 */
let pending: { type: 'text' | 'thinking'; text: string } | undefined

function emitJson(event: object): void {
  const e = event as { type?: string; delta?: string }
  if ((e.type === 'text' || e.type === 'thinking') && typeof e.delta === 'string') {
    if (pending && pending.type !== e.type) flushPending()
    pending ??= { type: e.type, text: '' }
    pending.text += e.delta
    return
  }
  flushPending()
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

function flushPending(): void {
  if (!pending) return
  if (pending.text) process.stdout.write(`${JSON.stringify(pending)}\n`)
  pending = undefined
}
