import { createInterface, type Interface } from 'node:readline'
import type { JeanConfig } from '@jean/config'
import { Orchestrator } from '@jean/agent'
import { EventStore, newSessionId } from '@jean/core'
import { estimateCost, ModelClient, defaultStreamRules } from '@jean/model'
import { openMemory, type MemoryBackend } from '@jean/memory'
import type { ConfirmRequest } from '@jean/tools'
import { runSlashCommand, slashCommandNames } from './commands/slash.ts'
import { Renderer } from './render.ts'
import { color, line, symbols, wrapText, write } from './ui.ts'

/**
 * The interactive session.
 *
 * Readline rather than a raw-mode TUI: it gives history, editing, and paste
 * handling for free, works over SSH and inside every terminal emulator, and
 * leaves scrollback intact. The full-screen renderer lives in `@jean/tui2`.
 */

export interface SessionOptions {
  config: JeanConfig
  cwd: string
  /** Resume this session instead of starting a new one. */
  store?: EventStore
  sessionId?: string
  showThinking?: boolean
  showDiffs?: boolean
  noSession?: boolean
  /** Run this as the first turn before handing control to the prompt. */
  initialPrompt?: string
  /** A command that must pass before the agent may stop. */
  verify?: string
}

export async function runInteractive(options: SessionOptions): Promise<number> {
  const sessionId = options.sessionId ?? newSessionId()
  const { backend: memory, warning } = openMemory(options.config)

  let spent = 0
  const client = new ModelClient({
    config: options.config,
    streamRules: defaultStreamRules(),
    onUsage: (event) => {
      spent += event.costUsd
    },
  })

  const renderer = new Renderer({
    showThinking: options.showThinking,
    showDiffs: options.showDiffs ?? true,
  })

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
    completer: (partial: string) => completer(partial),
  })

  const reader = new LineReader(rl)

  let finished = false
  const orchestrator = new Orchestrator({
    config: options.config,
    client,
    cwd: options.cwd,
    sessionId,
    memory,
    store: options.store,
    verify: options.verify,
    onEvent: (event) => renderer.handle(event),
    confirm: (request) => confirm(reader, request),
  })

  printBanner(options, orchestrator, client, warning)

  // Ctrl+C interrupts the run in progress rather than killing the process; a
  // second one, with nothing running, exits.
  let running = false
  const onInterrupt = () => {
    if (running) {
      orchestrator.interrupt()
      line(color.yellow(`\n${symbols.warn} interrupted`))
    } else {
      line(color.dim('\n(Ctrl+D or /exit to quit)'))
      rl.prompt()
    }
  }
  rl.on('SIGINT', onInterrupt)

  const slashContext = {
    orchestrator,
    client,
    cwd: options.cwd,
    sessionId,
    exit: () => {
      finished = true
      rl.close()
    },
  }

  // An inline prompt runs first; afterwards the loop reads from the terminal.
  let pending = options.initialPrompt

  while (!finished) {
    let input: string | undefined
    if (pending !== undefined) {
      input = pending
      pending = undefined
      line(`${prompt(orchestrator)}${input}`)
    } else {
      input = await reader.ask(prompt(orchestrator))
    }
    if (input === undefined) break // Ctrl+D

    const trimmed = input.trim()
    if (!trimmed) continue

    const slash = await runSlashCommand(trimmed, slashContext)
    if (slash === true) {
      if (finished) break
      continue
    }

    running = true
    const result = await orchestrator.send(typeof slash === 'object' ? slash.send : trimmed)
    running = false
    renderer.finish()

    if (result.stopReason === 'error') {
      line(color.red(`${symbols.cross} ${result.error ?? 'the run failed'}`))
    } else if (result.stopReason === 'max_turns') {
      line(color.yellow(`${symbols.warn} ${result.error}`))
      line(color.dim('  Ask it to continue, or raise --max-turns.'))
    }

    printFooter(result, spent)
  }

  orchestrator.end()
  if (!options.noSession) {
    line()
    line(color.dim(`Session saved as ${sessionId}. Resume with \`jean resume ${sessionId}\`.`))
  }
  memory.close()
  rl.close()
  return 0
}

function prompt(orchestrator: Orchestrator): string {
  const mode = orchestrator.currentMode()
  // `autonomous` is the default, so labelling it would put a badge on every
  // prompt and stop meaning anything.
  const label = mode === 'autonomous' ? '' : color.magenta(`${mode} `)
  const permission = orchestrator.config.permissionMode
  const gate = permission === 'plan' ? color.yellow('plan ') : permission === 'full' ? color.red('full ') : ''
  return `${label}${gate}${color.cyan(symbols.prompt)} `
}

/**
 * Line-buffered input.
 *
 * `rl.question()` only captures the line that arrives *after* it is called.
 * With piped stdin, readline emits every buffered line immediately, so a
 * `question`-based loop silently drops all but the first — which makes
 * `printf '/tools\n/exit\n' | jean` run one command and quit.
 *
 * Buffering every line as it arrives and having `ask` pull from the queue works
 * identically for a terminal and for a pipe.
 */
class LineReader {
  private readonly queue: string[] = []
  private waiting?: (value: string | undefined) => void
  private closed = false

  constructor(rl: Interface) {
    rl.on('line', (text: string) => {
      const waiter = this.waiting
      if (waiter) {
        this.waiting = undefined
        waiter(text)
      } else {
        this.queue.push(text)
      }
    })
    rl.on('close', () => {
      this.closed = true
      // End of input, or Ctrl+D. `undefined` distinguishes it from a blank line.
      this.waiting?.(undefined)
      this.waiting = undefined
    })
  }

  /** Prints `question` and resolves with the next line, or `undefined` at EOF. */
  ask(question: string): Promise<string | undefined> {
    const buffered = this.queue.shift()
    if (buffered !== undefined) {
      // Echo it so a piped session reads like an interactive one.
      write(`${question}${buffered}\n`)
      return Promise.resolve(buffered)
    }
    if (this.closed) return Promise.resolve(undefined)

    write(question)
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }
}

/** Yes/no confirmation for gated tool calls. */
async function confirm(reader: LineReader, request: ConfirmRequest): Promise<boolean> {
  line()
  line(color.yellow(`${symbols.warn} ${request.summary}`))
  if (request.detail) {
    line(wrapText(color.dim(request.detail.slice(0, 1000)), 2))
  }
  const answer = await reader.ask(`  ${color.bold('Allow?')} ${color.dim('[y/N]')} `)
  const approved = /^y(es)?$/i.test((answer ?? '').trim())
  line(approved ? color.green(`  ${symbols.check} allowed`) : color.red(`  ${symbols.cross} declined`))
  return approved
}

function completer(partial: string): [string[], string] {
  if (!partial.startsWith('/')) return [[], partial]
  const matches = slashCommandNames().filter((c) => c.startsWith(partial))
  return [matches.length > 0 ? matches : slashCommandNames(), partial]
}

function printBanner(
  options: SessionOptions,
  orchestrator: Orchestrator,
  client: ModelClient,
  warning?: string,
): void {
  const resolved = client.resolve('default')
  line()
  line(`${color.bold('Jean Code')} ${color.dim('0.1.0')}`)
  line(
    color.dim(
      `  ${resolved.modelId} via ${resolved.provider} · ${orchestrator.currentMode()} mode · ${options.cwd}`,
    ),
  )

  if (!client.isConfigured()) {
    line()
    line(color.red(`${symbols.cross} No API key for ${resolved.provider}.`))
    line(color.dim('  Set OPENROUTER_API_KEY (reaches every provider) or the provider-specific key.'))
    line(color.dim('  Run `jean doctor` for details.'))
  }
  if (warning) line(color.yellow(`${symbols.warn} ${warning}`))
  if (options.store && options.store.length > 1) {
    line(color.dim(`  Resumed with ${options.store.length} prior events.`))
  }

  line()
  line(color.dim(`  /help for commands · Ctrl+C interrupts · Ctrl+D exits`))
  line()
}

function printFooter(result: { turns: number; toolCalls: number; files: string[] }, spent: number): void {
  const parts: string[] = []
  if (result.turns > 1) parts.push(`${result.turns} turns`)
  if (result.toolCalls > 0) parts.push(`${result.toolCalls} tool calls`)
  if (result.files.length > 0) {
    parts.push(`${result.files.length} file${result.files.length === 1 ? '' : 's'} changed`)
  }
  if (spent > 0.005) parts.push(`~$${spent.toFixed(2)}`)
  if (parts.length > 0) {
    line()
    line(color.dim(`  ${parts.join(' · ')}`))
  }
  line()
}

export { estimateCost }
export type { MemoryBackend }
