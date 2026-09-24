import type { LoopEvent } from '@jean/core'
import { clipToWidth, color, duration, line, renderDiff, Spinner, symbols, wrapText, write } from './ui.ts'

/**
 * Turns loop events into terminal output.
 *
 * The rule the whole renderer follows: show what the agent *did*, compactly,
 * and never make the user scroll past a tool's raw output to find the answer.
 * Tool calls become one-line cards; their results are summarized unless they
 * failed, in which case the error is what matters and is shown in full.
 */

export interface RendererOptions {
  quiet?: boolean
  /** Show the model's thinking as it streams. */
  showThinking?: boolean
  /** Print a diff for every file edit. */
  showDiffs?: boolean
}

export class Renderer {
  private readonly spinner: Spinner
  private streaming = false
  private thinkingOpen = false
  private readonly options: RendererOptions
  private readonly pending = new Map<string, { summary: string; started: number }>()

  constructor(options: RendererOptions = {}) {
    this.options = options
    this.spinner = new Spinner(!options.quiet)
  }

  handle(event: LoopEvent): void {
    switch (event.type) {
      case 'turn_start':
        if (!this.streaming) this.spinner.start('thinking')
        break

      case 'thinking':
        if (!this.options.showThinking) break
        this.spinner.stop()
        if (!this.thinkingOpen) {
          line()
          line(color.dim(`${symbols.bullet} thinking`))
          this.thinkingOpen = true
        }
        write(color.dim(event.delta))
        break

      case 'text':
        this.spinner.stop()
        if (this.thinkingOpen) {
          line()
          line()
          this.thinkingOpen = false
        }
        if (!this.streaming) {
          line()
          this.streaming = true
        }
        write(event.delta)
        break

      case 'tool_start': {
        this.endStream()
        this.pending.set(event.id, { summary: event.summary, started: Date.now() })
        this.spinner.start(event.summary)
        break
      }

      case 'tool_end': {
        this.spinner.stop()
        const pending = this.pending.get(event.id)
        this.pending.delete(event.id)

        const mark = event.result.isError ? color.red(symbols.cross) : color.green(symbols.check)
        const summary = pending?.summary ?? event.name
        const took = event.durationMs > 400 ? color.dim(` ${duration(event.durationMs)}`) : ''
        // Clipped for the same reason as the spinner: one record, one row.
        line(`${mark} ${color.cyan(clipToWidth(summary, took.length + 3))}${took}`)

        if (event.result.isError) {
          // A failure is the one thing worth showing in full: the agent is
          // about to act on it, and the user needs to see the same thing.
          line(wrapText(color.red(event.result.output.trim()), 2))
        } else {
          this.renderSuccess(event)
        }
        break
      }

      case 'turn_end':
        this.endStream()
        break

      case 'compacted':
        line(
          color.dim(
            `${symbols.bullet} compacted context (${event.tokensBefore.toLocaleString()} → ${event.tokensAfter.toLocaleString()} tokens)`,
          ),
        )
        break

      case 'notice':
        this.endStream()
        line(color.yellow(`${symbols.warn} ${event.text}`))
        break

      case 'error':
        this.endStream()
        this.spinner.stop()
        line(color.red(`${symbols.cross} ${event.message}`))
        break
    }
  }

  /** One or two lines describing what a successful tool call produced. */
  private renderSuccess(event: Extract<LoopEvent, { type: 'tool_end' }>): void {
    const display = event.result.display as Record<string, unknown> | undefined
    const kind = display?.kind

    if (kind === 'edit' && this.options.showDiffs) {
      const before = String(display?.before ?? '')
      const after = String(display?.after ?? '')
      line(renderDiff(before, after, 20))
      return
    }

    if (kind === 'grep' || kind === 'glob' || kind === 'subagent' || kind === 'todo') {
      // These tools already summarize themselves in their first line.
      const first = event.result.output.split('\n')[0] ?? ''
      if (first) line(color.dim(`  ${first.slice(0, 160)}`))
      return
    }

    if (kind === 'bash') {
      // Show the tail of command output: the interesting part of a build or a
      // test run is at the end.
      const lines = event.result.output.trimEnd().split('\n')
      const tail = lines.slice(-6)
      for (const l of tail) line(color.dim(`  ${l.slice(0, 200)}`))
      if (lines.length > tail.length) {
        line(color.dim(`  ${symbols.bullet} ${lines.length - tail.length} earlier lines`))
      }
      return
    }

    const first = event.result.output.split('\n')[0] ?? ''
    if (first && first.length < 200) line(color.dim(`  ${first}`))
  }

  private endStream(): void {
    if (this.streaming) {
      line()
      this.streaming = false
    }
    if (this.thinkingOpen) {
      line()
      this.thinkingOpen = false
    }
  }

  /** Called when a turn finishes, before the next prompt. */
  finish(): void {
    this.spinner.stop()
    this.endStream()
  }
}
