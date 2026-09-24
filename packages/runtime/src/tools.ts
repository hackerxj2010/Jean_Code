import { ToolError, type Tool, type ToolResult } from '@jean/tools'
import { Kernel, type ExecuteResult, type KernelLanguage } from './kernel.ts'

/**
 * Runtime worker tools (architecture §8.4).
 *
 * A kernel earns its cost when work is exploratory — inspecting a dataset,
 * probing an API, reshaping JSON. `bash` re-runs the setup on every call; a
 * kernel keeps it, so the tenth step costs the same as the first.
 */

export class KernelRegistry {
  private readonly kernels = new Map<KernelLanguage, Kernel>()

  constructor(
    private readonly cwd: string,
    private readonly onToolCall?: (tool: string, args: unknown) => Promise<unknown>,
  ) {}

  get(language: KernelLanguage): Kernel {
    const existing = this.kernels.get(language)
    if (existing?.isRunning) return existing

    const kernel = new Kernel({
      language,
      cwd: this.cwd,
      onToolCall: this.onToolCall,
    })
    this.kernels.set(language, kernel)
    return kernel
  }

  running(): KernelLanguage[] {
    return [...this.kernels.entries()]
      .filter(([, kernel]) => kernel.isRunning)
      .map(([language]) => language)
  }

  stopAll(): void {
    for (const kernel of this.kernels.values()) kernel.stop()
    this.kernels.clear()
  }
}

/** Renders a kernel result for the model. */
function render(result: ExecuteResult, language: string): ToolResult {
  if (result.timedOut) {
    return {
      output: `The ${language} kernel timed out and was restarted, so its state is gone. Break the work into smaller steps.`,
      isError: true,
    }
  }

  const sections: string[] = []
  if (result.stdout.trim()) sections.push(result.stdout.trimEnd())
  if (result.stderr.trim()) sections.push(result.stderr.trimEnd())
  if (result.value !== undefined) sections.push(`=> ${result.value}`)

  if (result.error) {
    sections.push(result.error.trimEnd())
    return { output: sections.join('\n') || result.error, isError: true }
  }

  return {
    output: sections.join('\n') || '(no output)',
    display: { kind: 'kernel', language, durationMs: result.durationMs },
  }
}

export function createKernelTools(registry: KernelRegistry): Tool[] {
  const pythonTool: Tool<{ code: string; reset?: boolean }> = {
    name: 'python',
    risk: 'execute',
    description: [
      'Run Python in a persistent interpreter. State survives between calls.',
      '',
      'Use this over `bash python -c` for anything exploratory: variables, imports,',
      'and loaded data persist, so step ten costs the same as step one instead of',
      're-running the setup every time.',
      '',
      'The value of the last expression is reported, as in a REPL.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python source to execute.' },
        reset: { type: 'boolean', description: 'Discard all state first.' },
      },
      required: ['code'],
    },
    summarize: (args) => `python ${args.code.split('\n')[0]!.slice(0, 60)}`,

    async execute(args): Promise<ToolResult> {
      const kernel = registry.get('python')
      if (args.reset) await kernel.reset()

      if (!(await kernel.start())) {
        throw new ToolError(
          'No Python interpreter is available.',
          'Install Python, or use `bash` for one-off scripts.',
        )
      }

      return render(await kernel.execute(args.code), 'python')
    },
  }

  const jsTool: Tool<{ code: string; reset?: boolean }> = {
    name: 'javascript',
    risk: 'execute',
    description: [
      'Run JavaScript or TypeScript in a persistent runtime. State survives between calls.',
      '',
      'Top-level `await` works. Use this for exploring an API or reshaping data',
      'across several steps, where re-running the setup each time would be slow',
      'or have side effects.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript source to execute.' },
        reset: { type: 'boolean', description: 'Discard all state first.' },
      },
      required: ['code'],
    },
    summarize: (args) => `js ${args.code.split('\n')[0]!.slice(0, 60)}`,

    async execute(args): Promise<ToolResult> {
      const kernel = registry.get('javascript')
      if (args.reset) await kernel.reset()

      if (!(await kernel.start())) {
        throw new ToolError('The JavaScript kernel could not start.')
      }

      return render(await kernel.execute(args.code), 'javascript')
    },
  }

  return [pythonTool as Tool, jsTool as Tool]
}
