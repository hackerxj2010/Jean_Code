import type { JeanConfig } from '@jean/config'
import type { EventStore } from '@jean/core'

/**
 * The full-screen session (architecture §16.1).
 *
 * A thin bridge: `@jean/tui2` owns the interface *and* the agent behind it, so
 * there is nothing to wire here beyond handing over the working directory and
 * the first prompt. The line-based session in `session.ts` keeps its own
 * orchestrator, which is why both can exist without one degrading the other.
 *
 * The import is dynamic on purpose. The interface pulls in React, a terminal
 * renderer, and a query client — tens of megabytes that a piped `jean -p "..."`
 * has no use for, and that would otherwise be loaded on every invocation just
 * to decide not to use them.
 */

export interface TuiSessionOptions {
  config: JeanConfig
  cwd: string
  store?: EventStore
  sessionId?: string
  initialPrompt?: string
  noSession?: boolean
}

export async function runTui(options: TuiSessionOptions): Promise<number> {
  try {
    // Dynamic: it pulls in React and a terminal renderer, and a piped
    // `jean -p "..."` needs neither.
    const { launch } = await import('@jean/tui2')

    await launch({
      cwd: options.cwd,
      initialPrompt: options.initialPrompt ?? null,
      // A resumed session arrives as a store the caller already loaded; the
      // interface reopens it by id rather than being handed the events.
      continueChat: options.store !== undefined && options.store.length > 0,
      continueChatId: options.sessionId ?? null,
    })

    // `launch` returns once the tree is mounted. The renderer owns the process
    // from here — it exits through `exitCliCleanly`, which restores the
    // terminal — so this promise is never expected to settle.
    await new Promise<never>(() => {})
    return 0
  } catch (error) {
    // Falling back rather than failing: a missing native binding or an
    // unsupported terminal should cost the user the fancy view, not the
    // session. The line-based renderer does the same job.
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `The full-screen interface could not start: ${message}\n` +
        'Continuing with the line-based view. Use --no-tui to skip this next time.\n\n',
    )

    const { runInteractive } = await import('./session.ts')
    return runInteractive({
      config: options.config,
      cwd: options.cwd,
      store: options.store,
      sessionId: options.sessionId,
      initialPrompt: options.initialPrompt,
      showThinking: options.config.debug,
      noSession: options.noSession,
    })
  }
}
