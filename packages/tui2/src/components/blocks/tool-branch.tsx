import { memo, useCallback } from 'react'

import { useTheme } from '../../hooks/use-theme'
import { useChatStore } from '../../state/chat-store'
import { renderToolComponent } from '../tools/registry'
import { ToolCard } from '../tools/tool-card'
import { describeToolCall } from '../tools/tool-specs'

import type { ContentBlock } from '../../types/chat'
import type { MarkdownPalette } from '../../utils/markdown-renderer'

interface ToolBranchProps {
  toolBlock: Extract<ContentBlock, { type: 'tool' }>
  keyPrefix: string
  availableWidth: number
  onToggleCollapsed: (id: string) => void
  markdownPalette: MarkdownPalette
}

/**
 * One tool call, drawn as a card: what ran, on what, how it ended, and its
 * result in readable form. A plugin that registered its own renderer for the
 * tool gets that instead.
 */
export const ToolBranch = memo(
  ({ toolBlock, keyPrefix, availableWidth, onToggleCollapsed }: ToolBranchProps) => {
    const theme = useTheme()
    // Derive streaming boolean for this specific tool to avoid re-renders when other tools/agents change
    const isStreaming = useChatStore((state) => state.streamingAgents.has(toolBlock.toolCallId))

    const handleToggle = useCallback(() => {
      onToggleCollapsed(toolBlock.toolCallId)
    }, [onToggleCollapsed, toolBlock.toolCallId])

    if (toolBlock.toolName === 'end_turn' || toolBlock.toolName === 'ask_user') {
      return null
    }
    if ('includeToolCall' in toolBlock && toolBlock.includeToolCall === false) {
      return null
    }

    const override = renderToolComponent(toolBlock, theme, {
      availableWidth,
      indentationOffset: 0,
      previewPrefix: '',
      labelWidth: 0,
      onToggle: handleToggle,
    })
    if (override) {
      return <box key={keyPrefix}>{override.content}</box>
    }

    const view = describeToolCall(toolBlock, isStreaming)
    const hasBody = view.body !== null && view.body !== undefined && view.body !== false
    const collapsed = hasBody ? (toolBlock.isCollapsed ?? view.collapsed) : false

    return (
      <box key={keyPrefix} style={{ width: '100%' }}>
        <ToolCard
          icon={view.icon}
          title={view.title}
          subtitle={view.subtitle}
          category={view.category}
          status={view.status}
          meta={view.meta}
          availableWidth={availableWidth}
          collapsed={collapsed}
          onToggle={hasBody ? handleToggle : undefined}
          preview={view.preview}
        >
          {view.body}
        </ToolCard>
      </box>
    )
  },
)
