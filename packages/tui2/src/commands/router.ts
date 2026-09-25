import { runTerminalCommand } from '@codebuff/sdk'


import {
  findCommand,
  type RouterParams,
  type CommandResult,
} from './command-registry'
import { isCustomCommand } from './jean'
import {
  isSlashCommand,
  parseCommandInput,
} from './router-utils'
import { buildInterviewPrompt, buildPlanPrompt, buildReviewPrompt } from './prompt-builders'
import { getProjectRoot } from '../project-files'
import { useChatStore } from '../state/chat-store'
import {
  buildBashHistoryMessages,
  createRunTerminalToolResult,
} from '../utils/bash-messages'
import { showClipboardMessage } from '../utils/clipboard'
import { getSystemProcessEnv } from '../utils/env'
import { getSystemMessage, getUserMessage } from '../utils/message-history'
import {
  capturePendingAttachments,
  hasProcessingFiles,
  hasProcessingImages,
  validateAndAddImage,
} from '../utils/pending-attachments'

/**
 * Run a bash command with automatic ghost/direct mode selection.
 * Uses ghost mode when streaming or chain in progress, otherwise adds directly to chat history.
 */
export function runBashCommand(command: string) {
  const {
    streamingAgents,
    isChainInProgress,
    setMessages,
    addPendingBashMessage,
    updatePendingBashMessage,
  } = useChatStore.getState()

  const ghost = streamingAgents.size > 0 || isChainInProgress
  const id = crypto.randomUUID()
  const commandCwd = process.cwd()
  const startTime = Date.now()

  if (ghost) {
    // Ghost mode: add to pending messages
    addPendingBashMessage({
      id,
      command,
      stdout: '',
      stderr: '',
      exitCode: 0,
      isRunning: true,
      startTime: Date.now(),
      cwd: commandCwd,
    })
  } else {
    // Direct mode: add to chat history with placeholder output (user + assistant)
    const { assistantMessage } = buildBashHistoryMessages({
      command,
      cwd: commandCwd,
      toolCallId: id,
    })
    setMessages((prev) => [...prev, assistantMessage])
  }

  runTerminalCommand(command, { cwd: commandCwd, env: getSystemProcessEnv() })
    .then(({ stdout, stderr, exitCode }) => {
      if (ghost) {
        updatePendingBashMessage(id, {
          stdout,
          stderr,
          exitCode,
          isRunning: false,
        })
      } else {
        const toolResultOutput = createRunTerminalToolResult({
          command,
          cwd: commandCwd,
          stdout: stdout || null,
          stderr: stderr || null,
          exitCode,
        })
        const outputJson = JSON.stringify(toolResultOutput)

        setMessages((prev) =>
          prev.map((msg) => {
            if (!msg.blocks) return msg
            let didUpdate = false
            const blocks = msg.blocks.map((block) => {
              if ('toolCallId' in block && block.toolCallId === id) {
                didUpdate = true
                return { ...block, output: outputJson }
              }
              return block
            })
            return didUpdate ? { ...msg, blocks, isComplete: true } : msg
          }),
        )

        // Also add to pending bash messages so the next user message includes this context for the LLM
        // Mark as already added to history to avoid duplicate UI entries
        addPendingBashMessage({
          id,
          command,
          stdout,
          stderr,
          exitCode,
          isRunning: false,
          cwd: commandCwd,
          addedToHistory: true,
        })
      }
    })
    .catch((error) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error)

      if (ghost) {
        updatePendingBashMessage(id, {
          stdout: '',
          stderr: errorMessage,
          exitCode: 1,
          isRunning: false,
        })
      } else {
        const errorToolResultOutput = createRunTerminalToolResult({
          command,
          cwd: commandCwd,
          stdout: null,
          stderr: null,
          exitCode: 1,
          errorMessage,
        })
        const errorOutputJson = JSON.stringify(errorToolResultOutput)

        setMessages((prev) =>
          prev.map((msg) => {
            if (!msg.blocks) return msg
            let didUpdate = false
            const blocks = msg.blocks.map((block) => {
              if ('toolCallId' in block && block.toolCallId === id) {
                didUpdate = true
                return { ...block, output: errorOutputJson }
              }
              return block
            })
            return didUpdate ? { ...msg, blocks, isComplete: true } : msg
          }),
        )

        // Also add to pending bash messages so the next user message includes this context for the LLM
        // Mark as already added to history to avoid duplicate UI entries
        addPendingBashMessage({
          id,
          command,
          stdout: '',
          stderr: errorMessage,
          exitCode: 1,
          isRunning: false,
          cwd: commandCwd,
          addedToHistory: true,
        })
      }
    })
}

/**
 * Add a completed bash command result to the chat message history.
 * Note: This is UI-only; we no longer send these commands to the AI context.
 */
export function addBashMessageToHistory(params: {
  command: string
  stdout: string
  stderr: string | null
  exitCode: number
  cwd: string
  setMessages: RouterParams['setMessages']
}) {
  const { command, stdout, stderr, exitCode, cwd, setMessages } = params
  const toolResultOutput = createRunTerminalToolResult({
    command,
    cwd,
    stdout: stdout || null,
    stderr: stderr ?? null,
    exitCode,
  })
  const toolCallId = crypto.randomUUID()
  const outputJson = JSON.stringify(toolResultOutput)
  const { assistantMessage } = buildBashHistoryMessages({
    command,
    cwd,
    toolCallId,
    output: outputJson,
    isComplete: true,
  })

  setMessages((prev) => [...prev, assistantMessage])
}

export async function routeUserPrompt(
  params: RouterParams,
): Promise<CommandResult> {
  const {
    agentMode,
    inputRef,
    inputValue,
    isChainInProgressRef,
    isStreaming,
    streamMessageIdRef,
    addToQueue,
    saveToHistory,
    scrollToLatest,
    sendMessage,
    setInputFocused,
    setInputValue,
    setMessages,
  } = params

  const inputMode = useChatStore.getState().inputMode
  const setInputMode = useChatStore.getState().setInputMode
  const pendingAttachments = useChatStore.getState().pendingAttachments
  const pendingImages = pendingAttachments.filter((a) => a.kind === 'image')
  const pendingTextAttachments = pendingAttachments.filter(
    (a) => a.kind === 'text',
  )

  const trimmed = inputValue.trim()
  // Allow empty messages if there are pending attachments (images or text)
  const hasAttachments = pendingAttachments.length > 0
  if (!trimmed && !hasAttachments) return

  // Handle bash mode commands
  if (inputMode === 'bash') {
    const commandWithBang = '!' + trimmed
    saveToHistory(commandWithBang)
    setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
    setInputMode('default')
    setInputFocused(true)
    inputRef.current?.focus()

    runBashCommand(trimmed)
    return
  }

  // Handle plan mode input
  if (inputMode === 'plan') {
    if (!trimmed) return
    saveToHistory(trimmed)
    setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
    setInputMode('default')
    setInputFocused(true)
    inputRef.current?.focus()

    sendMessage({ content: buildPlanPrompt(trimmed), agentMode })
    setTimeout(() => {
      scrollToLatest()
    }, 0)
    return
  }

  // Handle interview mode input
  if (inputMode === 'interview') {
    if (!trimmed) return
    saveToHistory(trimmed)
    setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
    setInputMode('default')
    setInputFocused(true)
    inputRef.current?.focus()

    sendMessage({ content: buildInterviewPrompt(trimmed), agentMode })
    setTimeout(() => {
      scrollToLatest()
    }, 0)
    return
  }

  // Handle review mode input
  if (inputMode === 'review') {
    if (!trimmed) return
    saveToHistory(trimmed)
    setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
    setInputMode('default')
    setInputFocused(true)
    inputRef.current?.focus()

    sendMessage({ content: buildReviewPrompt('custom', trimmed), agentMode })
    setTimeout(() => {
      scrollToLatest()
    }, 0)
    return
  }

  // Handle bash commands from queue (starts with '!')
  if (trimmed.startsWith('!') && trimmed.length > 1) {
    const command = trimmed.slice(1)
    saveToHistory(trimmed)
    setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
    runBashCommand(command)
    return
  }

  // Handle image mode input
  if (inputMode === 'image') {
    const imagePath = trimmed
    const projectRoot = getProjectRoot()

    // Validate and add the image (handles path resolution, format check, and processing)
    const result = await validateAndAddImage(imagePath, projectRoot)
    if (!result.success) {
      setMessages((prev) => [
        ...prev,
        getUserMessage(trimmed),
        getSystemMessage(`❌ ${result.error}`),
      ])
    }

    // Note: No system message added here - the PendingImagesBanner shows attached images
    saveToHistory(trimmed)
    setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
    setInputMode('default')
    return
  }

  // Handle slash commands or configured slashless exact commands.
  const parsedCommand = parseCommandInput(trimmed)
  if (parsedCommand) {
    const commandDef = findCommand(parsedCommand.command)
    if (commandDef) {
      // The command handler (via defineCommand/defineCommandWithArgs factories)
      // is responsible for validating and handling args
      return await commandDef.handler(params, parsedCommand.args)
    }
  }

  // Regular message or unknown slash command - send to agent

  // Block sending if attachments are still processing
  if (hasProcessingImages() || hasProcessingFiles()) {
    showClipboardMessage('processing attachments...', {
      durationMs: 2000,
    })
    return
  }

  saveToHistory(trimmed)
  setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })

  if (
    isStreaming ||
    streamMessageIdRef.current ||
    isChainInProgressRef.current
  ) {
    const pendingAttachmentsForQueue = capturePendingAttachments()
    // Pass a copy of pending attachments to the queue
    addToQueue(trimmed, pendingAttachmentsForQueue)

    setInputFocused(true)
    inputRef.current?.focus()
    return
  }

  // A custom command (.jean/commands, .claude/commands) goes to the agent,
  // which expands it into its prompt.
  const attempted = isSlashCommand(trimmed) ? trimmed.slice(1).split(/\s+/)[0] ?? '' : ''
  if (attempted && (await isCustomCommand(attempted))) {
    sendMessage({ content: trimmed, agentMode })
    setTimeout(() => {
      scrollToLatest()
    }, 0)
    return
  }

  // Unknown slash command - show error
  if (isSlashCommand(trimmed)) {
    setMessages((prev) => [
      ...prev,
      getUserMessage(trimmed),
      getSystemMessage(`Command not found: ${JSON.stringify(trimmed)}`),
    ])
    return
  }

  sendMessage({ content: trimmed, agentMode })

  setTimeout(() => {
    scrollToLatest()
  }, 0)

  return
}
