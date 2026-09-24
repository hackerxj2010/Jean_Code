import { readFile } from 'node:fs/promises'
import { nativeReady } from '@jean/native'
import { awk, column, cut, fold, head, nl, sed, sort, tail, tr, uniq, wc } from './text.ts'
import { bc, diff, jq } from './data.ts'
import type { UtilResult } from './text.ts'

/**
 * The in-process text pipeline, as one tool.
 *
 * The alternative — the agent writing `cat x | jq '.a' | head -5` — costs a
 * shell, four processes, and behaves differently on Windows, where none of
 * these binaries reliably exist. Running the stages here makes the result the
 * same everywhere and removes a class of "command not found" turns.
 */

export interface Stage {
  op: string
  args?: Record<string, unknown>
}

/** Applies a pipeline of stages to text. */
export function runPipeline(input: string, stages: Stage[]): UtilResult {
  let current = input

  for (const stage of stages) {
    const result = applyStage(current, stage)
    if (result.exitCode !== 0) return result
    current = result.stdout
  }

  return { stdout: current, stderr: '', exitCode: 0 }
}

function applyStage(input: string, stage: Stage): UtilResult {
  const args = stage.args ?? {}
  const number = (key: string, fallback: number): number => {
    const value = args[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }
  const text = (key: string): string | undefined => {
    const value = args[key]
    return typeof value === 'string' ? value : undefined
  }
  const flag = (key: string): boolean => args[key] === true

  switch (stage.op) {
    case 'head':
      return head(input, number('count', 10))
    case 'tail':
      return tail(input, number('count', 10))
    case 'sort':
      return sort(input, {
        numeric: flag('numeric'),
        reverse: flag('reverse'),
        unique: flag('unique'),
        ignoreCase: flag('ignoreCase'),
        key: args.key === undefined ? undefined : number('key', 1),
      })
    case 'uniq':
      return uniq(input, {
        count: flag('count'),
        duplicatesOnly: flag('duplicatesOnly'),
        uniqueOnly: flag('uniqueOnly'),
      })
    case 'cut':
      return cut(input, {
        fields: Array.isArray(args.fields) ? (args.fields as number[]) : undefined,
        delimiter: text('delimiter'),
      })
    case 'tr': {
      const from = text('from')
      if (!from) return { stdout: '', stderr: 'tr: `from` is required', exitCode: 1 }
      return tr(input, from, text('to') ?? '', { delete: flag('delete') })
    }
    case 'sed': {
      const script = text('script')
      if (!script) return { stdout: '', stderr: 'sed: `script` is required', exitCode: 1 }
      return sed(input, script)
    }
    case 'awk': {
      const program = text('program')
      if (!program) return { stdout: '', stderr: 'awk: `program` is required', exitCode: 1 }
      return awk(input, program, text('separator'))
    }
    case 'jq': {
      const filter = text('filter') ?? '.'
      return jq(input, filter)
    }
    case 'wc': {
      const counts = wc(input)
      return {
        stdout: `${counts.lines} ${counts.words} ${counts.bytes}\n`,
        stderr: '',
        exitCode: 0,
      }
    }
    case 'nl':
      return nl(input)
    case 'fold':
      return fold(input, number('width', 80))
    case 'column':
      return column(input)
    case 'bc':
      return bc(input)
    default:
      return {
        stdout: '',
        stderr: (NATIVE_ONLY_OPS as readonly string[]).includes(stage.op)
          ? `"${stage.op}" runs in the Rust coreutils, and the native bridge is not built — run \`jean native build\``
          : `unknown operation "${stage.op}"`,
        exitCode: 1,
      }
  }
}

export const PIPELINE_OPS = [
  'head', 'tail', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk', 'jq', 'wc', 'nl', 'fold', 'column', 'bc',
] as const

/**
 * Operations only the Rust coreutils provide. They need the native bridge; the
 * TypeScript pipeline answers them with an error saying so.
 */
export const NATIVE_ONLY_OPS = [
  'grep', 'rev', 'fmt', 'expand', 'unexpand', 'shuf', 'sha256sum', 'md5sum', 'cksum',
] as const

/**
 * How a stage becomes a `pi-builtins` invocation.
 *
 * Every argument is built here from the stage's named fields, and none of them
 * is ever a path: the builtins read a file when handed one, and this is a
 * read-only tool with no business opening anything the workspace checks have
 * not already cleared. Values that could start with `-` go after `--`, so a
 * pattern like `-v` is a pattern and not a flag.
 */
export function toBuiltin(stage: Stage): { name: string; args: string[] } | { error: string } {
  const args = stage.args ?? {}
  const number = (key: string): number | undefined => {
    const value = args[key]
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined
  }
  const text = (key: string): string | undefined => {
    const value = args[key]
    return typeof value === 'string' ? value : undefined
  }
  const flag = (key: string, letter: string): string[] => (args[key] === true ? [`-${letter}`] : [])

  switch (stage.op) {
    case 'head':
    case 'tail':
      return { name: stage.op, args: [`--lines=${number('count') ?? 10}`] }
    case 'sort': {
      const key = number('key')
      return {
        name: 'sort',
        args: [
          ...flag('numeric', 'n'),
          ...flag('reverse', 'r'),
          ...flag('unique', 'u'),
          ...flag('ignoreCase', 'f'),
          ...(key === undefined ? [] : [`--key=${key}`]),
        ],
      }
    }
    case 'uniq':
      return {
        name: 'uniq',
        args: [...flag('count', 'c'), ...flag('duplicatesOnly', 'd'), ...flag('uniqueOnly', 'u')],
      }
    case 'cut': {
      const fields = Array.isArray(args.fields)
        ? (args.fields as unknown[]).filter((field) => typeof field === 'number')
        : []
      const delimiter = text('delimiter')
      return {
        name: 'cut',
        args: [
          `--fields=${fields.length > 0 ? fields.join(',') : '1'}`,
          ...(delimiter ? [`--delimiter=${delimiter}`] : []),
        ],
      }
    }
    case 'tr': {
      const from = text('from')
      if (!from) return { error: 'tr: `from` is required' }
      const to = text('to')
      return { name: 'tr', args: [...flag('delete', 'd'), '--', from, ...(to ? [to] : [])] }
    }
    case 'sed': {
      const script = text('script')
      return script ? { name: 'sed', args: ['--', script] } : { error: 'sed: `script` is required' }
    }
    case 'awk': {
      const program = text('program')
      if (!program) return { error: 'awk: `program` is required' }
      const separator = text('separator')
      return {
        name: 'awk',
        args: [...(separator ? [`--field-separator=${separator}`] : []), '--', program],
      }
    }
    case 'jq':
      return { name: 'jq', args: ['--', text('filter') ?? '.'] }
    case 'grep': {
      const pattern = text('pattern')
      if (pattern === undefined) return { error: 'grep: `pattern` is required' }
      return {
        name: 'grep',
        args: [
          ...flag('ignoreCase', 'i'),
          ...flag('invert', 'v'),
          ...flag('count', 'c'),
          ...flag('lineNumbers', 'n'),
          ...flag('fixed', 'F'),
          ...flag('wholeLine', 'x'),
          '--',
          pattern,
        ],
      }
    }
    case 'fold':
      return { name: 'fold', args: [`--width=${number('width') ?? 80}`] }
    case 'fmt':
      return { name: 'fmt', args: [`--width=${number('width') ?? 75}`] }
    case 'expand':
    case 'unexpand':
      return { name: stage.op, args: [`--tabs=${number('tabs') ?? 8}`] }
    case 'shuf': {
      const count = number('count')
      return { name: 'shuf', args: count === undefined ? [] : [`--head-count=${count}`] }
    }
    case 'wc':
    case 'nl':
    case 'column':
    case 'bc':
    case 'rev':
    case 'sha256sum':
    case 'md5sum':
    case 'cksum':
      return { name: stage.op, args: [] }
    default:
      return { error: `unknown operation "${stage.op}"` }
  }
}

/**
 * Runs a pipeline in the Rust coreutils, in one round trip. `undefined` when
 * the bridge is unavailable, so the caller can use {@link runPipeline}.
 */
export async function runPipelineNative(input: string, stages: Stage[]): Promise<UtilResult | undefined> {
  const invocations: { name: string; args: string[] }[] = []
  for (const stage of stages) {
    const built = toBuiltin(stage)
    if ('error' in built) return { stdout: '', stderr: built.error, exitCode: 1 }
    invocations.push(built)
  }

  const native = await nativeReady()
  if (!native) return undefined

  try {
    const result = await native.builtinPipeline(invocations, input)
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code }
  } catch {
    return undefined
  }
}

/**
 * Builds the `text` tool.
 *
 * Kept out of `@jean/tools` so `@jean/coreutils` stays a pure library with no
 * dependency on the tool harness — it is useful on its own, and the parity
 * tests exercise it directly.
 */
export function createTextTool(deps: {
  resolvePath: (path: string, context: unknown) => string
  displayPath: (absolute: string, context: unknown) => string
}) {
  return {
    name: 'text',
    risk: 'read' as const,
    description: [
      'Process text through an in-process pipeline: sort, uniq, cut, sed, awk, jq, and more.',
      '',
      'Prefer this over `bash` for data manipulation. It runs in-process, so there',
      'is no shell to quote against, and it behaves identically on every platform —',
      '`jq`, `sed`, and `awk` are frequently absent on Windows.',
      '',
      'Give either `path` to read a file or `input` for literal text, then a list',
      'of stages applied in order.',
    ].join('\n'),
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File to read as input.' },
        input: { type: 'string', description: 'Literal text to process instead of a file.' },
        stages: {
          type: 'array',
          description: `Pipeline stages, applied in order: {op, args}. Operations: ${[...PIPELINE_OPS, ...NATIVE_ONLY_OPS].join(', ')}. grep takes {pattern, ignoreCase, invert, count, lineNumbers, fixed}.`,
        },
      },
      required: ['stages'],
    },
    summarize: (args: { stages?: Stage[] }) =>
      `text ${(args.stages ?? []).map((s) => s.op).join(' | ') || 'pipeline'}`,

    async execute(
      args: { path?: string; input?: string; stages: Stage[] },
      context: unknown,
    ): Promise<{ output: string; isError?: boolean }> {
      let input = args.input ?? ''

      if (args.path) {
        const absolute = deps.resolvePath(args.path, context)
        const shown = deps.displayPath(absolute, context)
        const content = await readFile(absolute, 'utf8').catch(() => undefined)
        if (content === undefined) {
          return { output: `${shown} could not be read.`, isError: true }
        }
        input = content
      }

      if (!Array.isArray(args.stages) || args.stages.length === 0) {
        return { output: '`stages` must be a non-empty array of operations.', isError: true }
      }

      // The Rust coreutils run the pipeline when the bridge is built; the
      // TypeScript implementations are the fallback for the ops they share.
      const result = (await runPipelineNative(input, args.stages)) ?? runPipeline(input, args.stages)
      if (result.exitCode !== 0) {
        return { output: result.stderr, isError: true }
      }

      const lines = result.stdout.split('\n').length
      const truncated =
        result.stdout.length > 30_000
          ? `${result.stdout.slice(0, 30_000)}\n[truncated — narrow the pipeline with head or a filter]`
          : result.stdout

      return { output: truncated || `(the pipeline produced no output; ${lines} lines in)` }
    },
  }
}

export { diff }
