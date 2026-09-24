/**
 * Leaving the alternate screen properly.
 *
 * The interface draws into the alternate screen buffer with the cursor hidden,
 * mouse reporting on, and bracketed paste enabled. Exiting without undoing all
 * of that leaves the user's shell in a state where the cursor is invisible and
 * every mouse move prints escape gibberish — a terminal they have to `reset`.
 *
 * So this runs on every exit path, including a crash, and it is idempotent
 * because several of those paths can fire together.
 */

import { closeCodebuffClient } from './codebuff-client'
import { logger } from './logger'

/** The sequences that undo everything the renderer turned on. */
export const TERMINAL_RESET_SEQUENCES = [
  '[?1003l', // stop reporting any-motion mouse events
  '[?1002l', // stop reporting button-drag events
  '[?1000l', // stop reporting clicks
  '[?1006l', // leave SGR mouse mode
  '[?2004l', // disable bracketed paste
  '[?25h', // show the cursor
  '[0m', // reset colours and attributes
  '[?1049l', // leave the alternate screen
].join('')

let alreadyExiting = false

/**
 * Restores the terminal and exits.
 *
 * `code` defaults to 0. A non-zero code is written after the reset, so the
 * message lands in the user's normal scrollback rather than on a screen that
 * is about to be torn down.
 */
export async function exitCliCleanly(code = 0, message?: string): Promise<never> {
  // Several paths can fire at once — a signal handler, an error boundary, and
  // the user's own quit. Running the teardown twice writes the escape
  // sequences twice, which is visible as a flicker.
  if (alreadyExiting) {
    await never()
  }
  alreadyExiting = true

  try {
    process.stdout.write(TERMINAL_RESET_SEQUENCES)
  } catch {
    // A closed stdout (piped output, killed parent) is not worth failing over:
    // there is no terminal left to restore.
  }

  try {
    closeCodebuffClient(code === 0 ? 'user exit' : 'error')
  } catch {
    /* never blocks an exit */
  }

  if (message !== undefined && message !== '') {
    const stream = code === 0 ? process.stdout : process.stderr
    try {
      stream.write(`${message}\n`)
    } catch {
      /* as above */
    }
  }

  try {
    logger.info({ code }, 'exit')
  } catch {
    /* as above */
  }

  process.exit(code)
}

/** Installs the handlers that restore the terminal on an abnormal exit. */
export function installProcessCleanupHandlers(): void {
  const restore = () => {
    try {
      process.stdout.write(TERMINAL_RESET_SEQUENCES)
    } catch {
      /* nothing to restore */
    }
  }

  // `exit` cannot be async, so it only restores the terminal. The signal
  // handlers below do the full teardown.
  process.on('exit', restore)

  process.on('SIGINT', () => {
    void exitCliCleanly(130)
  })
  process.on('SIGTERM', () => {
    void exitCliCleanly(143)
  })

  process.on('uncaughtException', (error) => {
    restore()
    // Printed after the reset so it lands in normal scrollback where it can be
    // read and copied, rather than on a screen that is being torn down.
    process.stderr.write(`\n${error.stack ?? error.message}\n`)
    process.exit(1)
  })

  process.on('unhandledRejection', (reason) => {
    restore()
    process.stderr.write(`\n${String(reason)}\n`)
    process.exit(1)
  })
}

function never(): Promise<never> {
  // The first caller is already tearing down; this one just stops here.
  return new Promise<never>(() => {})
}
