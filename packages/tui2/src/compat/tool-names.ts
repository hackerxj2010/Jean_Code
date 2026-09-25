/**
 * Translates Jean's tool calls into the vocabulary the interface renders.
 *
 * The interface has a rich component per tool — an expandable command card, a
 * diff viewer, a file list — and it selects them *by tool name*, in more than
 * one place: the component registry, and a special case in
 * `updateToolBlockWithOutput` that pulls `stdout`/`stderr` out of a terminal
 * result before anything else sees it.
 *
 * Registering Jean's names alongside the originals only fixed the first of
 * those. The block still said `bash`, so the special case was skipped, the
 * result was JSON-stringified by the generic path, and the terminal component
 * then looked for `stdout` in a string that held `{"output":"..."}`. It found
 * nothing and rendered its no-output branch: the command appeared, the output
 * did not.
 *
 * So the translation happens here instead, at the boundary. Downstream, every
 * tool *is* the tool the interface was written for — same name, same argument
 * shape, same result shape — and all of it works unmodified.
 */

/** Jean's tool name to the interface's. */
const NAMES: Record<string, string> = {
  bash: 'run_terminal_command',
  bash_output: 'run_terminal_command',
  read: 'read_files',
  write: 'write_file',
  edit: 'str_replace',
  grep: 'code_search',
  ast_grep: 'code_search',
  todo: 'write_todos',
  web_fetch: 'read_url',
  // `glob` and `web_search` already carry the names the interface expects.
}

export function renameTool(jeanName: string): string {
  return NAMES[jeanName] ?? jeanName
}

/**
 * Reshapes a tool's arguments into what the component reads.
 *
 * Only the differences are handled; anything unlisted passes through, because
 * a component that does not recognise a field ignores it, while one missing a
 * field it does read renders blank.
 */
export function adaptInput(
  jeanName: string,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!input) return input

  switch (jeanName) {
    case 'bash':
      return {
        ...input,
        command: input.command ?? '',
        // The card labels this in seconds; Jean's tool takes milliseconds.
        timeout_seconds:
          typeof input.timeout === 'number' ? Math.round(input.timeout / 1000) : undefined,
      }

    case 'bash_output':
      return {
        ...input,
        // A background job is identified by id rather than by command line, so
        // the id is what the card can meaningfully show.
        command:
          typeof input.command === 'string' && input.command !== ''
            ? input.command
            : `background job ${String(input.job ?? input.id ?? '')}`.trim(),
      }

    case 'read':
      return {
        ...input,
        // The file list renders `paths` as an array; Jean reads one file.
        paths: Array.isArray(input.paths)
          ? input.paths
          : input.path !== undefined
            ? [input.path]
            : [],
      }

    case 'grep':
    case 'ast_grep':
      return { ...input, pattern: input.pattern ?? '', cwd: input.path ?? input.cwd }

    default:
      return input
  }
}

/** What Jean's tools hand back. */
export interface JeanToolResult {
  output?: string
  isError?: boolean
  display?: unknown
  touched?: string[]
}

/**
 * Reshapes a tool result into what the component parses.
 *
 * The interface reads a result as `[{ type: 'json', value: … }]` and reaches
 * into `value` for per-tool fields. Jean returns `{ output, isError, display }`
 * for every tool, so the interesting text has to be moved to where each
 * component looks for it.
 */
export function adaptOutput(
  jeanName: string,
  result: unknown,
): { type: 'json'; value: unknown }[] {
  const typed = (result ?? {}) as JeanToolResult
  const text = typeof typed.output === 'string' ? typed.output : ''

  switch (jeanName) {
    case 'bash':
    case 'bash_output':
      return [
        {
          type: 'json',
          value: {
            // Jean interleaves the two streams as the command produces them,
            // which is what a terminal shows and what makes an error legible
            // next to the line that caused it. Splitting them back apart would
            // be a guess, so it all goes to stdout and `errorMessage` carries
            // the failure separately.
            stdout: text,
            stderr: '',
            ...(typed.isError === true && { errorMessage: text }),
            // How it ended, for the box's status: an exit code, or a timeout.
            ...(isRecord(typed.display) && 'exitCode' in typed.display
              ? { exitCode: typed.display.exitCode as number | null }
              : {}),
            ...(isRecord(typed.display) && typed.display.timedOut === true ? { timedOut: true } : {}),
            ...(isRecord(typed.display) && typeof typed.display.cwd === 'string'
              ? { startingCwd: typed.display.cwd }
              : {}),
            // The card shows how the command ended, not just what it printed.
            ...(isRecord(typed.display) && typeof typed.display.exitCode === 'number'
              ? { exitCode: typed.display.exitCode }
              : {}),
            ...(isRecord(typed.display) && typed.display.timedOut === true
              ? { timedOut: true }
              : {}),
          },
        },
      ]

    default:
      // Everything else: the structured payload a tool provides, *plus* its
      // text. `display` is often only counts (`{ kind, count }`) while the
      // readable answer lives in `output`, so dropping either leaves the card
      // with nothing a person can read.
      return [
        {
          type: 'json',
          value: {
            ...(isRecord(typed.display) ? typed.display : {}),
            output: text,
            isError: typed.isError === true,
          },
        },
      ]
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
