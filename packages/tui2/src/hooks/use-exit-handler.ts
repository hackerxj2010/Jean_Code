import { useCallback, useEffect, useRef, useState } from 'react'

import { getCurrentChatId } from '../project-files'
import { closeCodebuffClient } from '../utils/codebuff-client'

import type { InputValue } from '../types/store'

interface UseExitHandlerOptions {
  inputValue: string
  setInputValue: (value: InputValue) => void
}

let exitHandlerRegistered = false

function setupExitMessageHandler() {
  if (exitHandlerRegistered) return
  exitHandlerRegistered = true

  process.on('exit', () => {
    try {
      const chatId = getCurrentChatId()
      if (chatId) {
        // This runs synchronously during the exit phase
        // OpenTUI has already cleaned up by this point
        // Matches what `jean sessions` prints and what the CLI accepts, so the
        // line can be copied straight into a shell.
        process.stdout.write(
          `\nTo continue this session later, run:\n  jean resume ${chatId}\n`,
        )
      }
    } catch {
      // Silent fail - don't block exit
    }
  })
}

function exitCli(): void {
  // The agent's session ends first, so what it started stops with it.
  closeCodebuffClient()
  process.exit(0)
}

export const useExitHandler = ({
  inputValue,
  setInputValue,
}: UseExitHandlerOptions) => {
  const [nextCtrlCWillExit, setNextCtrlCWillExit] = useState(false)
  const exitWarningTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )

  useEffect(() => {
    setupExitMessageHandler()
  }, [])

  const handleCtrlC = useCallback(() => {
    if (inputValue) {
      setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
      return true
    }

    if (!nextCtrlCWillExit) {
      setNextCtrlCWillExit(true)
      setTimeout(() => {
        setNextCtrlCWillExit(false)
      }, 2000)
      return true
    }

    if (exitWarningTimeoutRef.current) {
      clearTimeout(exitWarningTimeoutRef.current)
      exitWarningTimeoutRef.current = null
    }

    exitCli()
    return true
  }, [inputValue, setInputValue, nextCtrlCWillExit])

  useEffect(() => {
    const handleSigint = () => {
      if (exitWarningTimeoutRef.current) {
        clearTimeout(exitWarningTimeoutRef.current)
        exitWarningTimeoutRef.current = null
      }

      exitCli()
    }

    // Bun's typings narrow `process.removeListener` to its own events; the
    // emitter underneath takes any name, as Node's does.
    const events: NodeJS.EventEmitter = process
    events.on('SIGINT', handleSigint)
    return () => {
      events.removeListener('SIGINT', handleSigint)
    }
  }, [])

  return { handleCtrlC, nextCtrlCWillExit }
}
