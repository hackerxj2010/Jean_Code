import React from 'react'

import { BottomBanner } from './bottom-banner'
import { useTheme } from '../hooks/use-theme'
import { useChatStore } from '../state/chat-store'

const HELP_TIMEOUT = 60 * 1000 // 60 seconds

/** Section header component for consistent styling */
const SectionHeader = ({ children }: { children: React.ReactNode }) => {
  const theme = useTheme()
  return <text style={{ fg: theme.muted }}>{children}</text>
}

/** Keyboard shortcut item */
const Shortcut = ({ keys, action }: { keys: string; action: string }) => {
  const theme = useTheme()
  return (
    <box style={{ flexDirection: 'row', gap: 1 }}>
      <text style={{ fg: theme.foreground }}>{keys}</text>
      <text style={{ fg: theme.muted }}>{action}</text>
    </box>
  )
}

/** Help banner showing keyboard shortcuts and tips in an organized layout. */
export const HelpBanner = () => {
  const setInputMode = useChatStore((state) => state.setInputMode)
  const theme = useTheme()

  // Auto-hide after timeout
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setInputMode('default')
    }, HELP_TIMEOUT)
    return () => clearTimeout(timer)
  }, [setInputMode])

  return (
    <BottomBanner borderColorKey="info" onClose={() => setInputMode('default')}>
      <box style={{ flexDirection: 'column', gap: 1, flexGrow: 1 }}>
        <box style={{ flexDirection: 'column', gap: 0 }}>
          <SectionHeader>Shortcuts</SectionHeader>
          <box style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, paddingLeft: 2 }}>
            <Shortcut keys="Ctrl+C / Esc" action="stop" />
            <Shortcut keys="Ctrl+J / Opt+Enter" action="newline" />
            <Shortcut keys="↑↓" action="history" />
            <Shortcut keys="Ctrl+T" action="collapse/expand agents" />
            <Shortcut keys="Ctrl+O" action="autonomous / swarm" />
          </box>
        </box>

        <box style={{ flexDirection: 'column', gap: 0 }}>
          <SectionHeader>Features</SectionHeader>
          <box style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, paddingLeft: 2 }}>
            <Shortcut keys="/" action="commands" />
            <Shortcut keys="@files" action="mention" />
            <Shortcut keys="@agents" action="use agent" />
            <Shortcut keys="!bash" action="run command" />
          </box>
        </box>

        <box style={{ flexDirection: 'column', gap: 0 }}>
          <SectionHeader>Tips</SectionHeader>
          <box style={{ flexDirection: 'column', paddingLeft: 2 }}>
            <text style={{ fg: theme.muted }}>Try: /interview → /plan → implement → /review</text>
            <text style={{ fg: theme.muted }}>/goal npm test keeps the agent working until the command passes</text>
            <text style={{ fg: theme.muted }}>/lsp and /debug show the language servers and debuggers in use</text>
            <text style={{ fg: theme.muted }}>/connect for provider keys, /models to switch model</text>
          </box>
        </box>
      </box>
    </BottomBanner>
  )
}
