/**
 * The full-screen interface's entry point.
 *
 * Sets up the terminal, mounts the React tree onto it, and gets out of the way.
 * Everything that used to happen here and does not apply to a local tool —
 * account login, telemetry init, update checks against a release channel — is
 * gone rather than stubbed.
 *
 * The one ordering rule that matters: the terminal's theme is probed *before*
 * the renderer takes over the screen. The probe works by writing an OSC query
 * and reading the reply off stdin, and once the renderer owns stdin that reply
 * is consumed as a keypress instead.
 */

import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import React from 'react'

import { App } from './app'
import { getProjectFileTree } from './compat/common'
import { initializeApp } from './init/init-app'
import { getProjectRoot, setProjectRoot } from './project-files'
import { initializeAgentRegistry } from './utils/local-agent-registry'
import { logger } from './utils/logger'
import { initializeSkillRegistry } from './utils/skill-registry'
import { detectTerminalTheme } from './utils/terminal-color-detection'
import { installProcessCleanupHandlers } from './utils/exit-cleanly'
import { setOscDetectedTheme } from './utils/theme-system'

import type { AgentMode } from './utils/constants'

export interface LaunchOptions {
  /** Sent as the first message once the interface is up. */
  initialPrompt?: string | null
  cwd?: string
  /** Resume the most recent conversation, or one by id. */
  continueChat?: boolean
  continueChatId?: string | null
  initialMode?: AgentMode
  agentId?: string
}

/**
 * A query client tuned for a terminal.
 *
 * The defaults assume a browser tab that can be backgrounded. A terminal has no
 * visibility API, so without `setFocused(true)` below every interval-based
 * query silently never fires — the app looks alive and quietly stops updating.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        gcTime: 10 * 60 * 1000,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        refetchOnMount: false,
      },
      mutations: { retry: 1 },
    },
  })
}

export async function launch(options: LaunchOptions = {}): Promise<void> {
  installProcessCleanupHandlers()

  if (options.cwd !== undefined && options.cwd !== '') {
    setProjectRoot(options.cwd)
  }

  // Must run before anything renders. It builds the theme store, which every
  // component reads on its first pass — a tree that mounts before this throws
  // "useThemeStore not initialized" from the root component down.
  await initializeApp({ cwd: options.cwd })


  const root = getProjectRoot()

  // Registries are optional: a project with no local agents or skills is
  // normal, and neither failing should stop the interface from opening.
  try {
    await initializeAgentRegistry()
  } catch (error) {
    logger.warn({ err: error }, 'agent registry unavailable')
  }

  try {
    await initializeSkillRegistry()
  } catch (error) {
    logger.warn({ err: error }, 'skill registry unavailable')
  }

  // Probed before the renderer starts: the reply arrives on stdin, and once the
  // renderer is reading stdin it would be swallowed as input.
  try {
    const detected = await detectTerminalTheme()
    if (detected) setOscDetectedTheme(detected)
  } catch {
    // A terminal that does not answer the query is not an error — it just
    // means the theme falls back to the configured default.
  }

  focusManager.setEventListener(() => () => {})
  focusManager.setFocused(true)

  // Built before the renderer so a slow filesystem shows as a slow start
  // rather than as an empty interface that fills in a second later.
  const fileTree = getProjectFileTree(root)

  const renderer = await createCliRenderer({
    // Ctrl+C is handled inside the app, which has to flush the event store and
    // restore the terminal. Letting the renderer exit first would skip both.
    exitOnCtrlC: false,
  })

  const queryClient = createQueryClient()

  createRoot(renderer).render(
    <QueryClientProvider client={queryClient}>
      <App
        initialPrompt={options.initialPrompt ?? null}
        agentId={options.agentId}
        fileTree={fileTree}
        continueChat={options.continueChat ?? false}
        continueChatId={options.continueChatId ?? null}
        initialMode={options.initialMode}
      />
    </QueryClientProvider>,
  )

  logger.info({ root }, 'interface started')
}
