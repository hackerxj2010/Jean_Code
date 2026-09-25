import { defineToolComponent } from './types'
import { TerminalCommandDisplay } from '../terminal-command-display'

import type { ToolRenderConfig } from './types'

export interface ParsedTerminalOutput {
  output: string | null
  startingCwd?: string
  /** Jean's results say how the command ended; the box shows it. */
  exitCode?: number | null
  timedOut?: boolean
}

/** Jean appends `[exit code N]` to a failed command's output; the box says it instead. */
const EXIT_TRAILER = /\n?\[exit code -?\d+\]\s*$/

/**
 * Parse terminal command output from JSON or raw string format.
 * Exported for testing.
 */
export const parseTerminalOutput = (rawOutput: string | undefined): ParsedTerminalOutput => {
  if (!rawOutput) {
    return { output: null }
  }

  try {
    const parsed = JSON.parse(rawOutput)
    // Handle array format [{ type: 'json', value: {...} }]
    const value = Array.isArray(parsed) ? parsed[0]?.value : parsed
    if (value) {
      const startingCwd = value.startingCwd
      // Jean's shape: the exit status is known, so the output stays the
      // output rather than becoming an "Error:" message.
      if ('exitCode' in value || value.timedOut === true) {
        const text = String(value.stdout ?? '') + String(value.stderr ?? '')
        return {
          output: text.replace(EXIT_TRAILER, '').trimEnd() || null,
          startingCwd,
          exitCode: value.exitCode ?? null,
          timedOut: value.timedOut === true,
        }
      }
      // Handle error case
      if (value.errorMessage) {
        return { output: `Error: ${value.errorMessage}`, startingCwd }
      }
      // Combine stdout and stderr for display
      // Use trimEnd() to preserve leading spaces (used for UI elements like trees/tables)
      const stdout = value.stdout || ''
      const stderr = value.stderr || ''
      const output = (stdout + stderr).trimEnd() || null
      return { output, startingCwd }
    }
    return { output: null }
  } catch {
    // If not JSON, use raw output (preserve leading spaces)
    return { output: rawOutput.trimEnd() || null }
  }
}

/**
 * UI component for run_terminal_command tool: the command in a box titled
 * `bash`, its output folded until it is asked for (a click, or Ctrl+T for
 * every block at once).
 */
export const RunTerminalCommandComponent = defineToolComponent({
  toolName: 'run_terminal_command',

  render(toolBlock, _theme, options): ToolRenderConfig {
    // Extract command and timeout from input
    const input = toolBlock.input as { command?: string; timeout_seconds?: number } | undefined
    const command = typeof input?.command === 'string' ? input.command.trim() : ''
    const timeoutSeconds = typeof input?.timeout_seconds === 'number' ? input.timeout_seconds : undefined

    // No result yet — or the placeholder a `!command` shows until it ends.
    const running = toolBlock.output === undefined || toolBlock.output === '...'
    const { output, startingCwd, exitCode, timedOut } = running ? { output: null } : parseTerminalOutput(toolBlock.output)

    // Custom content component using shared TerminalCommandDisplay
    const content = (
      <TerminalCommandDisplay
        command={command}
        output={output}
        maxVisibleLines={5}
        cwd={startingCwd}
        timeoutSeconds={timeoutSeconds}
        availableWidth={options.availableWidth}
        isRunning={running}
        exitCode={exitCode}
        timedOut={timedOut}
        collapsed={toolBlock.isCollapsed ?? true}
        onToggle={options.onToggle}
      />
    )

    return {
      content,
      collapsedPreview: `$ ${command}`,
    }
  },
})
