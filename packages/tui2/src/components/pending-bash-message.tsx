import { TextAttributes } from '@opentui/core'

import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'
import { TerminalBody } from './tools/tool-bodies'
import { ToolCard } from './tools/tool-card'

import type { PendingBashMessage as PendingBashMessageType } from '../types/store'

interface PendingBashMessageProps {
  message: PendingBashMessageType
}

/**
 * A `!command` run while the agent is busy: drawn as the same card a shell
 * tool call gets, with a note that it joins the history once the turn ends.
 */
export const PendingBashMessage = ({ message }: PendingBashMessageProps) => {
  const theme = useTheme()
  const { separatorWidth } = useTerminalDimensions()
  const output = `${message.stdout ?? ''}${message.stderr ?? ''}`
  const failed = !message.isRunning && message.exitCode !== 0

  return (
    <box style={{ flexDirection: 'column', width: '100%', paddingBottom: 1 }}>
      <ToolCard
        icon="❯"
        title="Shell"
        subtitle={message.command}
        category="run"
        status={message.isRunning ? 'running' : failed ? 'error' : 'done'}
        meta={message.isRunning ? undefined : `exit ${message.exitCode}`}
        availableWidth={separatorWidth}
      >
        <TerminalBody
          command={message.command}
          output={output}
          cwd={message.cwd}
          pending={message.isRunning}
        />
        <text fg={theme.muted} attributes={TextAttributes.ITALIC}>
          Joins the chat history when the agent's turn ends
        </text>
      </ToolCard>
    </box>
  )
}
