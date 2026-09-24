import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { jeanHome } from '@jean/config'
import { isTrusted } from '@jean/hooks'
import { parseFrontMatter } from '@jean/skills'
import { defaultShell, isSecretFile, type Tool } from '@jean/tools'

/**
 * `@jean/commands` — custom slash commands, written as Markdown.
 *
 * A command is a prompt the user reuses: `/review`, `/fix-issue 123`,
 * `/frontend:component Button`. Each is a `.md` file whose body is the prompt,
 * with optional front matter. The format and the locations are Claude Code's,
 * so a team's existing `.claude/commands/` works here unchanged:
 *
 *     ---
 *     description: Review the staged diff for bugs
 *     argument-hint: [focus area]
 *     allowed-tools: Bash(git diff:*), Read
 *     model: opus
 *     ---
 *     Review this change. Focus on $ARGUMENTS.
 *
 *     !`git diff --staged`
 *
 * In the body, `$ARGUMENTS` is everything after the command name and `$1`…`$9`
 * the individual words. `@path` inlines a file. `` !`cmd` `` runs a command
 * and inlines its output — which is code execution, so for a project's own
 * commands it happens only in a project the user has trusted.
 */

export interface CustomCommand {
  /** `review`, or `frontend:component` for `commands/frontend/component.md`. */
  name: string
  description: string
  argumentHint?: string
  allowedTools?: string[]
  /** Model alias or id to run the command's prompt on. */
  model?: string
  body: string
  path: string
  source: 'user' | 'project'
  /** False when front matter sets `disable-model-invocation: true`. */
  modelInvocable: boolean
}

export interface DiscoverOptions {
  env?: NodeJS.ProcessEnv
  /** Also read Claude Code's directories. Default true. */
  importClaude?: boolean
}

/**
 * Every command available in a project. Project commands override user
 * commands of the same name; Jean's directories override Claude Code's.
 */
export function discoverCommands(cwd: string, options: DiscoverOptions = {}): CustomCommand[] {
  const env = options.env ?? process.env
  const home = env.HOME ?? env.USERPROFILE ?? homedir()
  const claude = options.importClaude !== false
  const roots: [string, CustomCommand['source']][] = [
    ...(claude ? [[join(home, '.claude', 'commands'), 'user'] as [string, CustomCommand['source']]] : []),
    [join(jeanHome(env), 'commands'), 'user'],
    ...(claude ? [[join(cwd, '.claude', 'commands'), 'project'] as [string, CustomCommand['source']]] : []),
    [join(cwd, '.jean', 'commands'), 'project'],
  ]

  const found = new Map<string, CustomCommand>()
  for (const [root, source] of roots) {
    for (const file of markdownFiles(root)) {
      const command = loadCommand(root, file, source)
      if (command) found.set(command.name, command)
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function loadCommand(root: string, file: string, source: CustomCommand['source']): CustomCommand | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const { data, body } = parseFrontMatter(text)
  const rel = relative(root, file).replace(/\.md$/i, '')
  const name = rel.split(sep).join(':').replace(/\//g, ':')
  if (!/^[A-Za-z0-9][A-Za-z0-9_:.-]*$/.test(name)) return undefined

  const str = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : undefined)
  const tools = data['allowed-tools']
  // `argument-hint: [focus]` reads as a YAML list; the brackets are the point.
  const hint = data['argument-hint']
  return {
    name,
    description: str('description') ?? firstLine(body) ?? name,
    argumentHint: Array.isArray(hint) ? `[${hint.join(', ')}]` : hint,
    allowedTools: Array.isArray(tools) ? tools : typeof tools === 'string' ? splitList(tools) : undefined,
    model: str('model'),
    body: body.trim(),
    path: file,
    source,
    modelInvocable: str('disable-model-invocation') !== 'true',
  }
}

/** Parses `/name rest of line` into the command name and its argument string. */
export function parseSlash(input: string): { name: string; args: string } | undefined {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9_:.-]*)(?:\s+([\s\S]*))?$/.exec(input.trim())
  if (!match) return undefined
  return { name: match[1]!, args: (match[2] ?? '').trim() }
}

/** Splits an argument string the way a shell would: quotes group words. */
export function splitArgs(args: string): string[] {
  const out: string[] = []
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g
  for (const match of args.matchAll(pattern)) {
    out.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : (match[2] ?? match[3]!))
  }
  return out
}

export interface ExpandOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Overrides the trust check for `!` commands (tests). */
  allowShell?: boolean
  /** Per-command timeout for `!` execution. */
  shellTimeoutMs?: number
}

export interface Expansion {
  prompt: string
  /** Things the user should know: a skipped `!` command, a missing file. */
  notes: string[]
}

/** Turns a command and its arguments into the prompt to send. */
export async function expandCommand(
  command: CustomCommand,
  args: string,
  options: ExpandOptions,
): Promise<Expansion> {
  const notes: string[] = []
  const words = splitArgs(args)

  let text = command.body
    .replace(/\$ARGUMENTS/g, args)
    .replace(/\$([1-9])/g, (_, n: string) => words[Number(n) - 1] ?? '')

  const shellAllowed =
    options.allowShell ?? (command.source === 'user' || isTrusted(options.cwd, options.env))

  // `!`cmd``: run it and inline the output.
  const shellCalls = [...text.matchAll(/!`([^`\n]+)`/g)]
  for (const match of shellCalls) {
    const cmd = match[1]!
    let replacement: string
    if (!shellAllowed) {
      replacement = `[not run: \`${cmd}\` — this project is not trusted; run \`jean trust\` to allow its commands to execute]`
      notes.push(`Skipped \`${cmd}\` from /${command.name}: the project is not trusted.`)
    } else {
      replacement = await runInline(cmd, options.cwd, options.shellTimeoutMs ?? 30_000)
    }
    text = text.replace(match[0], () => replacement)
  }

  // `@path` on its own or mid-sentence: inline a file from the project.
  text = text.replace(/(^|\s)@((?:\.{1,2}\/|\/|\.?[A-Za-z0-9_])[^\s`'"]*)/g, (whole, lead: string, ref: string) => {
    const inlined = inlineFile(ref, options.cwd)
    if (inlined === undefined) {
      // `@decorator` or `@username` is prose, not a missed file.
      if (/[./\\]/.test(ref)) {
        notes.push(`@${ref} was not inlined: it is missing, outside the project, or holds credentials.`)
      }
      return whole
    }
    return `${lead}${inlined}`
  })

  return { prompt: text.trim(), notes }
}

function inlineFile(ref: string, cwd: string): string | undefined {
  const absolute = isAbsolute(ref) ? ref : resolve(cwd, ref)
  const rel = relative(cwd, absolute)
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined
  if (isSecretFile(absolute)) return undefined
  try {
    if (!statSync(absolute).isFile()) return undefined
    const content = readFileSync(absolute, 'utf8')
    const clipped = content.length > 60_000 ? `${content.slice(0, 60_000)}\n[truncated]` : content
    return `\n<file path="${rel.split(sep).join('/')}">\n${clipped}\n</file>\n`
  } catch {
    return undefined
  }
}

function runInline(command: string, cwd: string, timeoutMs: number): Promise<string> {
  const shell = defaultShell()
  return new Promise((resolvePromise) => {
    let output = ''
    const child = spawn(shell.path, [...shell.args, command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolvePromise(`${output}\n[timed out after ${timeoutMs / 1000}s]`)
    }, timeoutMs)
    const collect = (chunk: Buffer) => {
      if (output.length < 100_000) output += chunk.toString('utf8')
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePromise(`[failed to run \`${command}\`: ${err.message}]`)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolvePromise(output.trimEnd())
    })
  })
}

/** One line per command, for `/help` and the TUI palette. */
export function describeCommands(commands: CustomCommand[]): string {
  if (commands.length === 0) {
    return 'No custom commands. Add one at .jean/commands/<name>.md (or .claude/commands/) — the file body is the prompt, $ARGUMENTS is replaced with what follows the command.'
  }
  return commands
    .map((c) => `  /${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}  — ${c.description} [${c.source}]`)
    .join('\n')
}

/**
 * Lets the model run a custom command itself.
 *
 * A command encodes how this team wants something done — `/release`,
 * `/review` — and a model that can reach it follows the team's procedure
 * instead of improvising one. The expanded prompt comes back as the tool
 * result, for the model to carry out.
 */
export function createSlashCommandTool(
  commands: () => CustomCommand[],
  cwd: string,
): Tool<{ command: string; arguments?: string }> {
  const invocable = () => commands().filter((c) => c.modelInvocable)
  return {
    name: 'slash_command',
    risk: 'read',
    concurrency: 'serial',
    get description() {
      const list = invocable()
        .map((c) => `- /${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}: ${c.description}`)
        .join('\n')
      return [
        "Run one of this project's custom commands. It returns the command's instructions, which you then carry out.",
        'Use one when the user asks for something a command covers — the command is how they want it done.',
        '',
        list ? `Available:\n${list}` : 'No custom commands are defined.',
      ].join('\n')
    },
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command name, without the slash.' },
        arguments: { type: 'string', description: 'Everything that would follow the command name.' },
      },
      required: ['command'],
    },
    summarize: (args) => `/${String(args.command ?? '').replace(/^\//, '')} ${args.arguments ?? ''}`.trim(),
    async execute(args) {
      const name = String(args.command).replace(/^\//, '')
      const command = invocable().find((c) => c.name === name)
      if (!command) {
        const names = invocable().map((c) => `/${c.name}`).join(', ')
        return { output: `No command /${name}.${names ? ` Available: ${names}.` : ''}`, isError: true }
      }
      const { prompt, notes } = await expandCommand(command, args.arguments ?? '', { cwd })
      const suffix = notes.length > 0 ? `\n\n(${notes.join(' ')})` : ''
      return { output: `Instructions from /${command.name}:\n\n${prompt}${suffix}` }
    },
  }
}

// ---------------------------------------------------------------------------

function markdownFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries.sort()) {
      if (entry.startsWith('.')) continue
      const full = join(dir, entry)
      try {
        const info = statSync(full)
        if (info.isDirectory()) walk(full, depth + 1)
        else if (/\.md$/i.test(entry)) out.push(full)
      } catch {
        // Skip what cannot be read.
      }
    }
  }
  walk(root, 0)
  return out
}

function splitList(value: string): string[] {
  // Split on commas that are not inside a rule's parentheses.
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of value) {
    if (ch === '(') depth++
    if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      if (current.trim()) out.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) out.push(current.trim())
  return out
}

function firstLine(text: string): string | undefined {
  const line = text.split('\n').find((l) => l.trim() !== '' && !l.startsWith('#'))
  return line ? line.trim().slice(0, 100) : undefined
}
