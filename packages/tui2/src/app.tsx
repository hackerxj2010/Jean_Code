/**
 * The root screen.
 *
 * There are three of them, and which one shows is decided here: the project
 * picker when there is no sensible working directory, the chat history browser
 * when the user asks for it, and the chat itself the rest of the time.
 *
 * Notably absent is a login gate. Jean authenticates to a model provider with
 * an API key from the environment — there is no account to sign into, so there
 * is no screen between the user and the prompt. A missing key is reported by
 * the status bar rather than blocking the interface, because the user can still
 * read history and browse files without one.
 */

import { useCallback, useMemo, useRef, useState } from 'react'

import { Chat } from './chat'
import { ChatHistoryScreen } from './components/chat-history-screen'
import { ProjectPickerScreen } from './components/project-picker-screen'
import { RunModeSwitcher } from './components/run-mode-switcher'
import { TerminalLink } from './components/terminal-link'
import { useLogo } from './hooks/use-logo'
import { useTerminalDimensions } from './hooks/use-terminal-dimensions'
import { useTheme } from './hooks/use-theme'
import { getProjectRoot } from './project-files'
import { findGitRoot } from './utils/git'
import { openFileAtPath } from './utils/open-file'
import { formatCwd } from './utils/path-helpers'
import { getLogoAccentColor, getLogoBlockColor } from './utils/theme-system'

import type { MultilineInputHandle } from './components/multiline-input'
import type { FileTreeNode } from './compat/types'
import type { AgentMode } from './utils/constants'

interface AppProps {
  initialPrompt: string | null
  agentId?: string
  fileTree: FileTreeNode[]
  continueChat?: boolean
  continueChatId?: string | null
  initialMode?: AgentMode
  /** Set when the launcher decided the cwd is not a project. */
  showProjectPicker?: boolean
  onProjectChange?: (path: string) => void
}

export function App({
  initialPrompt,
  agentId,
  fileTree,
  continueChat = false,
  continueChatId = null,
  initialMode,
  showProjectPicker = false,
  onProjectChange,
}: AppProps) {
  const theme = useTheme()
  const { terminalWidth } = useTerminalDimensions()
  const inputRef = useRef<MultilineInputHandle>(null)

  const [projectRoot, setProjectRoot] = useState(() => getProjectRoot())
  const [showChatHistory, setShowChatHistory] = useState(false)
  const [resumeChatId, setResumeChatId] = useState<string | null>(null)

  const gitRoot = useMemo(() => findGitRoot({ cwd: projectRoot }), [projectRoot])

  const { component: logoComponent } = useLogo({
    availableWidth: terminalWidth,
    blockColor: getLogoBlockColor(theme.mode),
    accentColor: getLogoAccentColor(theme.mode),
  })

  const headerContent = useMemo(() => {
    const displayPath = formatCwd(projectRoot)

    return (
      <box
        style={{
          flexDirection: 'column',
          gap: 0,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        {/* Above the wordmark, centred: it sets how the session runs, so it
            belongs with the session's identity rather than with the prompt. */}
        <box style={{ flexDirection: 'column', marginTop: 1 }}>
          <RunModeSwitcher />
        </box>

        <box style={{ flexDirection: 'column', marginBottom: 1, marginTop: 1 }}>
          {logoComponent}
        </box>

        <text style={{ wrapMode: 'word', marginBottom: 1, fg: theme.foreground }}>
          Jean Code will read your files and run commands on your behalf to help you build.
        </text>

        <text style={{ wrapMode: 'word', marginBottom: 1, fg: theme.foreground }}>
          Directory{' '}
          <TerminalLink
            text={displayPath}
            color={theme.muted}
            inline={true}
            underlineOnHover={true}
            onActivate={() => openFileAtPath(projectRoot)}
          />
        </text>
      </box>
    )
  }, [logoComponent, projectRoot, theme])

  const handleProjectChange = useCallback(
    (path: string) => {
      setProjectRoot(path)
      onProjectChange?.(path)
    },
    [onProjectChange],
  )

  const handleResumeChat = useCallback((id: string) => {
    setResumeChatId(id)
    setShowChatHistory(false)
  }, [])

  const handleNewChat = useCallback(() => {
    setResumeChatId(null)
    setShowChatHistory(false)
  }, [])

  const handleSwitchToGitRoot = useCallback(() => {
    if (gitRoot) handleProjectChange(gitRoot)
  }, [gitRoot, handleProjectChange])

  // The picker comes first. Choosing where to work precedes everything else,
  // and a screen that appeared *after* the chat had mounted would read as
  // being thrown out of a session the user had already started.
  if (showProjectPicker) {
    return (
      <ProjectPickerScreen
        onSelectProject={handleProjectChange}
        initialPath={projectRoot}
      />
    )
  }

  if (showChatHistory) {
    return (
      <ChatHistoryScreen
        onSelectChat={handleResumeChat}
        onCancel={() => setShowChatHistory(false)}
        onNewChat={handleNewChat}
      />
    )
  }

  return (
    <Chat
      // Remounts when a different conversation is resumed, so no state from
      // the previous one survives into it.
      key={resumeChatId ?? 'current'}
      headerContent={headerContent}
      initialPrompt={initialPrompt}
      agentId={agentId}
      fileTree={fileTree}
      inputRef={inputRef}
      continueChat={continueChat || resumeChatId !== null}
      continueChatId={resumeChatId ?? continueChatId ?? undefined}
      initialMode={initialMode}
      gitRoot={gitRoot}
      onSwitchToGitRoot={handleSwitchToGitRoot}
      onShowChatHistory={() => setShowChatHistory(true)}
    />
  )
}
