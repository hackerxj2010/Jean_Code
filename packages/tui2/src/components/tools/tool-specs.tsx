/**
 * How each of Jean's tools is drawn.
 *
 * One entry per tool: its icon and category, which argument summarises the
 * call in the header, what outcome goes in the badge, and — where the default
 * "arguments then answer" body is not the best reading — a body of its own.
 * A tool missing from the table (an MCP tool, a plugin's) still gets a card
 * built from its name and arguments; nothing is ever shown as raw JSON.
 */

import { TextAttributes } from '@opentui/core'

import { useTheme } from '../../hooks/use-theme'
import { diffStats, unifiedDiff } from '../../utils/line-diff'
import {
  type ParsedToolResult,
  type ToolStatus,
  firstLine,
  formatBytes,
  formatDuration,
  humanizeKey,
  isRecord,
  parseToolResult,
  plural,
  stringArg,
  toolStatus,
  truncate,
} from '../../utils/tool-result'
import {
  Checklist,
  type ChecklistItem,
  CodeBlock,
  DiffBlock,
  ErrorText,
  GenericBody,
  TerminalBody,
} from './tool-bodies'
import { CardSection, FieldList, ItemList, TextBlock, type ToolCategory } from './tool-card'

import type { ReactNode } from 'react'
import type { ContentBlock } from '../../types/chat'

type ToolBlock = Extract<ContentBlock, { type: 'tool' }>

export interface ToolViewContext {
  /** Jean's name for the tool. */
  name: string
  input: Record<string, unknown>
  result: ParsedToolResult
  status: ToolStatus
}

export interface ToolView {
  icon: string
  category: ToolCategory
  title: string
  subtitle?: string
  meta?: string
  preview?: string
  body?: ReactNode
  collapsed: boolean
  status: ToolStatus
}

interface ToolSpec {
  icon: string
  category: ToolCategory
  title: string
  /** Arguments that summarise the call, first match wins. */
  primary?: string[]
  /** Start folded. Defaults by category; errors always start open. */
  collapsed?: boolean
  view?: (ctx: ToolViewContext) => Partial<Omit<ToolView, 'icon' | 'category' | 'status'>>
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** `src/app.ts:42`, the way an editor would cite a position. */
function location(input: Record<string, unknown>): string {
  const path = str(input.path)
  const line = num(input.line)
  return line !== undefined && path ? `${path}:${line}` : path
}

/** `symbol · src/app.ts:42` for the code-intelligence tools. */
function symbolAt(input: Record<string, unknown>): string {
  const symbol = str(input.symbol)
  const at = location(input)
  return symbol && at ? `${symbol} · ${at}` : symbol || at
}

function countMeta(
  result: ParsedToolResult,
  noun: string,
  pluralNoun?: string,
): string | undefined {
  const count = num(result.fields.count)
  return count === undefined ? undefined : plural(count, noun, pluralNoun)
}

function diffMeta(diff: string): string | undefined {
  const { added, removed } = diffStats(diff)
  if (added === 0 && removed === 0) return undefined
  return `+${added} −${removed}`
}

// ---------------------------------------------------------------------------
// Bodies specific to one tool
// ---------------------------------------------------------------------------

const GrepMatches = ({ matches }: { matches: { path: string; line: number; text: string }[] }) => {
  const theme = useTheme()
  const byFile = new Map<string, { line: number; text: string }[]>()
  for (const match of matches) {
    const hits = byFile.get(match.path) ?? []
    hits.push(match)
    byFile.set(match.path, hits)
  }
  const files = [...byFile.entries()].slice(0, 8)
  const hiddenFiles = byFile.size - files.length

  return (
    <box style={{ flexDirection: 'column', width: '100%' }}>
      {files.map(([path, hits]) => (
        <box key={path} style={{ flexDirection: 'column', width: '100%' }}>
          <text fg={theme.directory} attributes={TextAttributes.BOLD} style={{ wrapMode: 'none' }}>
            {path}
          </text>
          {hits.slice(0, 5).map((hit, index) => (
            <text key={index} style={{ wrapMode: 'none' }}>
              <span fg={theme.muted}>{`  ${String(hit.line).padStart(4)}  `}</span>
              <span fg={theme.foreground}>{truncate(hit.text.trim(), 160)}</span>
            </text>
          ))}
          {hits.length > 5 ? (
            <text
              fg={theme.muted}
            >{`        … ${plural(hits.length - 5, 'more match', 'more matches')}`}</text>
          ) : null}
        </box>
      ))}
      {hiddenFiles > 0 ? (
        <text fg={theme.muted}>{`… ${plural(hiddenFiles, 'more file')}`}</text>
      ) : null}
    </box>
  )
}

const GIT_CODES: Record<
  string,
  { label: string; tone: 'added' | 'removed' | 'changed' | 'other' }
> = {
  M: { label: 'modified', tone: 'changed' },
  A: { label: 'added', tone: 'added' },
  D: { label: 'deleted', tone: 'removed' },
  R: { label: 'renamed', tone: 'changed' },
  C: { label: 'copied', tone: 'changed' },
  U: { label: 'conflict', tone: 'removed' },
  '??': { label: 'untracked', tone: 'other' },
}

const GitFiles = ({ files }: { files: { code: string; path: string }[] }) => {
  const theme = useTheme()
  const tone = {
    added: theme.success,
    removed: theme.error,
    changed: theme.warning,
    other: theme.muted,
  }
  return (
    <ItemList
      maxItems={15}
      items={files.map((file) => {
        const code = file.code.trim()
        const known = GIT_CODES[code] ??
          GIT_CODES[code.replace(/\s/g, '').charAt(0)] ?? { label: code, tone: 'other' as const }
        return {
          glyph: code.padEnd(2),
          glyphColor: tone[known.tone],
          text: file.path,
          detail: known.label,
        }
      })}
    />
  )
}

const QuestionBody = ({
  question,
  options,
  answer,
}: { question: string; options: string[]; answer: string }) => {
  const theme = useTheme()
  return (
    <box style={{ flexDirection: 'column', width: '100%' }}>
      <text fg={theme.foreground} style={{ wrapMode: 'word' }}>
        {question}
      </text>
      {options.length > 0 ? (
        <ItemList
          items={options.map((option) => ({
            glyph: option === answer ? '●' : '○',
            text: option,
            dim: answer !== '' && option !== answer,
          }))}
        />
      ) : null}
      {answer ? (
        <text style={{ wrapMode: 'word' }}>
          <span fg={theme.muted}>{'Answer  '}</span>
          <span fg={theme.primary} attributes={TextAttributes.BOLD}>
            {answer}
          </span>
        </text>
      ) : null}
    </box>
  )
}

/** The main answer of a tool, or its error. */
function answer(result: ParsedToolResult, maxLines = 14): ReactNode {
  if (result.isError) return <ErrorText text={result.text} />
  if (!result.text.trim()) return null
  return <TextBlock text={result.text} maxLines={maxLines} />
}

/** Arguments beyond those named, as labelled fields. */
function otherArgs(input: Record<string, unknown>, omit: string[]): ReactNode {
  const rest = Object.fromEntries(Object.entries(input).filter(([key]) => !omit.includes(key)))
  if (!Object.values(rest).some((v) => v !== undefined && v !== '' && v !== false)) return null
  return <FieldList fields={rest} maxValueLength={160} />
}

function stack(...parts: ReactNode[]): ReactNode {
  const present = parts.filter((part) => part !== null && part !== undefined && part !== false)
  if (present.length === 0) return null
  return (
    <box style={{ flexDirection: 'column', width: '100%' }}>
      {present.map((part, index) => (
        <box key={index} style={{ flexDirection: 'column', width: '100%' }}>
          {part}
        </box>
      ))}
    </box>
  )
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const lspSpec = (title: string, view?: ToolSpec['view']): ToolSpec => ({
  icon: 'λ',
  category: 'code',
  title,
  view: (ctx) => ({ subtitle: symbolAt(ctx.input), ...view?.(ctx) }),
})

const debugSpec = (title: string, view?: ToolSpec['view']): ToolSpec => ({
  icon: '◉',
  category: 'debug',
  title,
  view: (ctx) => ({
    meta: str(ctx.result.fields.status) || undefined,
    ...view?.(ctx),
  }),
})

const SPECS: Record<string, ToolSpec> = {
  // --- Files ---------------------------------------------------------------
  read: {
    icon: '◇',
    category: 'read',
    title: 'Read',
    view: ({ input, result }) => {
      const path = str(input.path) || str(list(input.paths)[0])
      const f = result.fields
      let meta: string | undefined
      switch (f.kind) {
        case 'file': {
          const total = num(f.lines) ?? 0
          const shown = num(f.shown) ?? total
          const offset = num(f.offset) ?? 1
          meta =
            shown < total
              ? `lines ${offset}–${offset + shown - 1} of ${total}`
              : plural(total, 'line')
          break
        }
        case 'directory':
          meta = plural(list(f.entries).length || num(f.entries) || 0, 'entry', 'entries')
          break
        case 'binary':
          meta = `binary · ${formatBytes(num(f.bytes) ?? 0)}`
          break
        case 'notebook':
          meta = plural(num(f.cells) ?? 0, 'cell')
          break
        case 'database':
          meta = plural(num(f.tables) ?? 0, 'table')
          break
        case 'archive':
          meta = plural(num(f.entries) ?? 0, 'entry', 'entries')
          break
        case 'audio':
          meta =
            num(f.durationMs) !== undefined
              ? `audio · ${formatDuration(num(f.durationMs)!)}`
              : 'audio'
          break
        case 'csv':
          meta = 'table'
          break
      }
      return { subtitle: path, meta, preview: '', body: answer(result, 16) }
    },
  },
  write: {
    icon: '✎',
    category: 'write',
    title: 'Write',
    view: ({ input, result }) => {
      const created = result.fields.created === true
      const content = str(input.content)
      const lines = num(result.fields.lines) ?? (content ? content.split('\n').length : 0)
      return {
        title: created ? 'Create' : 'Write',
        subtitle: str(input.path),
        meta: lines ? plural(lines, 'line') : undefined,
        body: result.isError ? (
          <ErrorText text={result.text} />
        ) : content ? (
          <CodeBlock code={content} maxLines={8} />
        ) : null,
      }
    },
  },
  edit: {
    icon: '✎',
    category: 'write',
    title: 'Edit',
    view: ({ input, result }) => {
      const f = result.fields
      let diff = ''
      if (typeof f.before === 'string' && typeof f.after === 'string') {
        diff = unifiedDiff(f.before, f.after)
      } else if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
        diff = unifiedDiff(str(input.old_string), str(input.new_string))
      } else if (Array.isArray(input.edits)) {
        diff = input.edits
          .filter(isRecord)
          .map((e) => unifiedDiff(str(e.old_string), str(e.new_string)))
          .filter(Boolean)
          .join('\n')
      } else if (typeof input.patch === 'string') {
        diff = input.patch
      }
      return {
        subtitle: str(input.path) || str(f.path),
        meta: result.isError ? undefined : diffMeta(diff),
        body: result.isError ? (
          stack(
            <ErrorText text={result.text} />,
            diff ? <DiffBlock diff={diff} maxLines={12} /> : null,
          )
        ) : diff ? (
          <DiffBlock diff={diff} />
        ) : (
          answer(result)
        ),
      }
    },
  },
  glob: {
    icon: '◎',
    category: 'search',
    title: 'Find files',
    view: ({ input, result }) => {
      const matches = list(result.fields.matches).map(String)
      const where = str(input.path) || str(input.cwd)
      return {
        subtitle: `${str(input.pattern)}${where ? `  in ${where}` : ''}`,
        meta: result.pending ? undefined : plural(matches.length, 'file'),
        preview: matches.slice(0, 4).join('  ') + (matches.length > 4 ? '  …' : ''),
        body: result.isError ? (
          <ErrorText text={result.text} />
        ) : result.pending ? null : (
          <ItemList items={matches.map((m) => ({ glyph: '·', text: m }))} />
        ),
      }
    },
  },
  grep: {
    icon: '◎',
    category: 'search',
    title: 'Search',
    view: ({ input, result }) => {
      const matches = list(result.fields.matches).filter(isRecord) as {
        path: string
        line: number
        text: string
      }[]
      const files = new Set(matches.map((m) => m.path)).size
      const where = str(input.path) || str(input.cwd)
      return {
        subtitle: `“${str(input.pattern)}”${input.include ? ` ${str(input.include)}` : ''}${where ? `  in ${where}` : ''}`,
        meta: result.pending
          ? undefined
          : matches.length === 0
            ? 'no matches'
            : `${plural(matches.length, 'match', 'matches')} · ${plural(files, 'file')}`,
        preview: matches.length
          ? [...new Set(matches.map((m) => m.path))].slice(0, 3).join('  ')
          : firstLine(result.text),
        body: result.isError ? (
          <ErrorText text={result.text} />
        ) : matches.length ? (
          <GrepMatches matches={matches} />
        ) : (
          answer(result)
        ),
      }
    },
  },
  ast_grep: {
    icon: '◎',
    category: 'search',
    title: 'Structural search',
    view: ({ input, result }) => ({
      subtitle: `${str(input.pattern)}${input.language ? `  (${str(input.language)})` : ''}`,
      meta: countMeta(result, 'match', 'matches'),
      body: answer(result),
    }),
  },

  // --- Shell -----------------------------------------------------------------
  bash: {
    icon: '❯',
    category: 'run',
    title: 'Run',
    view: ({ input, result }) => {
      const command = str(input.command)
      const f = result.fields
      const exit = num(f.exitCode)
      const meta =
        f.timedOut === true
          ? 'timed out'
          : input.background === true
            ? 'in background'
            : exit !== undefined
              ? `exit ${exit}`
              : undefined
      return {
        subtitle: command.split('\n')[0],
        meta: result.pending ? undefined : meta,
        preview: firstLine(result.text.split('\n').slice(-1)[0] ?? ''),
        body: (
          <TerminalBody
            command={command}
            output={result.text}
            cwd={str(f.startingCwd) || str(input.cwd)}
            pending={result.pending}
            timeoutSeconds={num(input.timeout_seconds)}
          />
        ),
      }
    },
  },
  bash_output: {
    icon: '❯',
    category: 'run',
    title: 'Job output',
    view: ({ input, result }) => ({
      subtitle: `job ${str(input.job)}${input.kill === true ? ' · stop' : ''}`,
      meta: result.fields.done === true ? 'finished' : result.pending ? undefined : 'still running',
      body: result.isError ? (
        <ErrorText text={result.text} />
      ) : (
        <TextBlock text={result.text || 'no new output'} maxLines={12} tail />
      ),
    }),
  },
  bash_input: {
    icon: '❯',
    category: 'run',
    title: 'Send input',
    view: ({ input, result }) => ({
      subtitle: `job ${str(input.job)}`,
      body: stack(
        <FieldList fields={{ input: str(input.input), 'press enter': input.enter !== false }} />,
        answer(result, 8),
      ),
    }),
  },

  // --- Planning and the conversation ----------------------------------------
  todo: {
    // Not ☰: renderers count it as two cells, which breaks the border. Every
    // icon here is one cell in common terminal fonts (⎇, ⌖ and ⬡ are not).
    icon: '▤',
    category: 'plan',
    title: 'Plan',
    view: ({ input, result }) => {
      const items = list(result.fields.items).filter(isRecord) as unknown as ChecklistItem[]
      const planned = items.length
        ? items
        : list(input.items).map(
            (text): ChecklistItem => ({ text: String(text), status: 'pending' }),
          )
      const done = planned.filter((item) => item.status === 'completed').length
      const action = str(input.action)
      const target = str(input.id)
      const current = planned.find((item) => item.id === target)
      const subtitle =
        action === 'set'
          ? plural(planned.length, 'step')
          : action === 'start'
            ? `start: ${current?.text ?? `#${target}`}`
            : action === 'complete'
              ? `done: ${current?.text ?? `#${target}`}`
              : 'current plan'
      return {
        subtitle,
        meta: planned.length ? `${done}/${planned.length} done` : undefined,
        body: result.isError ? (
          <ErrorText text={result.text} />
        ) : planned.length ? (
          <Checklist items={planned} />
        ) : (
          answer(result)
        ),
      }
    },
  },
  ask: {
    icon: '?',
    category: 'agent',
    title: 'Question',
    view: ({ input, result }) => ({
      subtitle: str(input.question),
      meta: str(result.fields.answer) ? 'answered' : undefined,
      body: (
        <QuestionBody
          question={str(input.question)}
          options={list(input.options).map(String)}
          answer={str(result.fields.answer)}
        />
      ),
    }),
  },
  checkpoint: {
    icon: '⚑',
    category: 'write',
    title: 'Checkpoint',
    view: ({ input, result }) => ({
      subtitle: [str(input.action), str(input.label) || str(input.id)].filter(Boolean).join(' · '),
      meta:
        num(result.fields.files) !== undefined
          ? plural(num(result.fields.files)!, 'file')
          : undefined,
      body: answer(result),
    }),
  },
  spawn: {
    icon: '◆',
    category: 'agent',
    title: 'Sub-agent',
    view: ({ input, result }) => ({
      subtitle: `${str(input.agent)}: ${str(input.task)}`,
      body: stack(<TextBlock text={str(input.task)} maxLines={6} />, answer(result)),
    }),
  },
  review: {
    icon: '◆',
    category: 'agent',
    title: 'Review',
    collapsed: false,
    view: ({ input, result }) => {
      const f = result.fields
      const files = num(f.files)
      return {
        subtitle: str(input.base) ? `against ${str(input.base)}` : 'working changes',
        meta:
          files !== undefined
            ? `${plural(files, 'file')} · +${num(f.added) ?? 0} −${num(f.removed) ?? 0}`
            : undefined,
        body: answer(result, 20),
      }
    },
  },
  skill: {
    icon: '✧',
    category: 'agent',
    title: 'Load skill',
    primary: ['name'],
    collapsed: true,
  },
  skill_save: {
    icon: '✧',
    category: 'write',
    title: 'Save skill',
    primary: ['name'],
    view: ({ input, result }) => ({
      body: stack(
        <FieldList
          fields={{ description: input.description, triggers: input.triggers, scope: input.scope }}
        />,
        <CardSection label="Instructions">
          <TextBlock text={str(input.instructions)} maxLines={8} />
        </CardSection>,
        result.isError ? <ErrorText text={result.text} /> : null,
      ),
    }),
  },
  slash_command: {
    icon: '/',
    category: 'agent',
    title: 'Command',
    view: ({ input, result }) => ({
      subtitle: `/${str(input.command)}${input.arguments ? ` ${str(input.arguments)}` : ''}`,
      body: answer(result),
    }),
  },

  // --- Git and GitHub --------------------------------------------------------
  git_status: {
    icon: '±',
    category: 'git',
    title: 'Git status',
    view: ({ input, result }) => {
      const files = list(result.fields.files).filter(isRecord) as { code: string; path: string }[]
      const branch =
        str(result.fields.branch) || /On branch (\S+?)[.,]/.exec(result.text)?.[1] || ''
      return {
        subtitle: branch ? `on ${branch}` : undefined,
        meta: result.pending ? undefined : files.length ? plural(files.length, 'change') : 'clean',
        preview: files.map((file) => file.path.split('/').pop()).join('  '),
        body: files.length ? <GitFiles files={files} /> : answer(result),
      }
    },
  },
  git_diff: {
    icon: '±',
    category: 'git',
    title: 'Git diff',
    view: ({ input, result }) => {
      const diff = str(result.fields.diff)
      return {
        subtitle: [input.staged === true ? 'staged' : 'working tree', str(input.path)]
          .filter(Boolean)
          .join(' · '),
        meta: diff ? diffMeta(diff) : undefined,
        body: diff ? <DiffBlock diff={diff} /> : answer(result),
      }
    },
  },
  git_log: {
    icon: '±',
    category: 'git',
    title: 'Git log',
    view: ({ input, result }) => ({
      subtitle:
        [str(input.path), num(input.limit) ? `last ${num(input.limit)}` : '']
          .filter(Boolean)
          .join(' · ') || 'history',
      body: answer(result, 16),
    }),
  },
  git_commit: {
    icon: '±',
    category: 'git',
    title: 'Commit',
    collapsed: false,
    view: ({ input, result }) => {
      const files = list(result.fields.files).map(String)
      const message = str(input.message)
      return {
        subtitle: firstLine(message),
        meta: files.length ? plural(files.length, 'file') : undefined,
        body: result.isError ? (
          <ErrorText text={result.text} />
        ) : (
          stack(
            message.includes('\n') ? <TextBlock text={message} maxLines={8} /> : null,
            files.length ? (
              <ItemList items={files.map((file) => ({ glyph: '+', text: file }))} />
            ) : null,
          )
        ),
      }
    },
  },
  gh_pr: {
    icon: '±',
    category: 'git',
    title: 'Pull request',
    view: ({ input, result }) => {
      const diff = str(result.fields.diff)
      return {
        subtitle: [
          str(input.action),
          num(input.number) ? `#${num(input.number)}` : '',
          str(input.repo),
          str(input.state),
        ]
          .filter(Boolean)
          .join(' · '),
        meta: diff ? diffMeta(diff) : undefined,
        body: diff ? <DiffBlock diff={diff} /> : answer(result, 16),
      }
    },
  },
  gh_issue: {
    icon: '±',
    category: 'git',
    title: 'Issue',
    view: ({ input, result }) => ({
      subtitle: [
        str(input.action),
        num(input.number) ? `#${num(input.number)}` : '',
        str(input.repo),
        str(input.state),
      ]
        .filter(Boolean)
        .join(' · '),
      body: answer(result, 16),
    }),
  },
  gh_checks: {
    icon: '±',
    category: 'git',
    title: 'CI checks',
    view: ({ input, result }) => ({
      subtitle: str(input.ref) || (num(input.runId) ? `run ${num(input.runId)}` : 'current branch'),
      body: answer(result, 16),
    }),
  },
  gh_search: {
    icon: '±',
    category: 'git',
    title: 'GitHub search',
    primary: ['query'],
  },
  gh_write: {
    icon: '±',
    category: 'git',
    title: 'GitHub',
    collapsed: false,
    view: ({ input, result }) => {
      const action = str(input.action)
      const title =
        action === 'comment'
          ? 'Comment'
          : action === 'create_pr'
            ? 'Open pull request'
            : action === 'create_issue'
              ? 'Open issue'
              : 'GitHub'
      return {
        title,
        subtitle: str(input.title) || (num(input.number) ? `#${num(input.number)}` : ''),
        body: stack(
          otherArgs(input, ['action', 'title', 'body']),
          str(input.body) ? <TextBlock text={str(input.body)} maxLines={8} /> : null,
          result.isError ? (
            <ErrorText text={result.text} />
          ) : result.text ? (
            <text>{firstLine(result.text)}</text>
          ) : null,
        ),
      }
    },
  },

  // --- Code intelligence ---------------------------------------------------------
  lsp_diagnostics: lspSpec('Diagnostics', ({ input, result }) => {
    const count = num(result.fields.count)
    return {
      subtitle: str(input.path) || list(input.paths).map(String).join(', ') || 'workspace',
      meta:
        count === undefined ? undefined : count === 0 ? 'no problems' : plural(count, 'problem'),
      body: answer(result, 16),
    }
  }),
  lsp_definition: lspSpec('Go to definition', ({ result }) => ({
    meta: countMeta(result, 'location'),
  })),
  lsp_references: lspSpec('References', ({ result }) => ({ meta: countMeta(result, 'reference') })),
  lsp_hover: lspSpec('Hover'),
  lsp_signature: lspSpec('Signature'),
  lsp_symbols: lspSpec('Symbols', ({ input, result }) => ({
    subtitle: str(input.query)
      ? `“${str(input.query)}”${input.path ? ` in ${str(input.path)}` : ''}`
      : str(input.path) || 'workspace',
    meta: countMeta(result, 'symbol'),
  })),
  lsp_hierarchy: lspSpec('Hierarchy', ({ input, result }) => ({
    title: `${humanizeKey(str(input.direction) || 'call')} hierarchy`,
    meta: countMeta(result, 'result'),
  })),
  lsp_completion: lspSpec('Completion', ({ input }) => ({
    subtitle: `${location(input)} after “${str(input.after)}”`,
  })),
  lsp_code_info: lspSpec('Code info', ({ input }) => ({
    title: humanizeKey(str(input.kind) || 'code info'),
    subtitle: symbolAt(input),
  })),
  lsp_rename: lspSpec('Rename symbol', ({ input, result }) => {
    const files = num(result.fields.files)
    const edits = num(result.fields.edits)
    return {
      subtitle: `${str(input.symbol)} → ${str(input.newName)}`,
      meta:
        edits !== undefined
          ? `${plural(edits, 'edit')} in ${plural(files ?? 0, 'file')}`
          : input.preview === true
            ? 'preview'
            : undefined,
      collapsed: false,
    }
  }),
  lsp_code_actions: lspSpec('Code actions', ({ input }) => ({
    subtitle: str(input.apply)
      ? `apply “${str(input.apply)}” · ${location(input)}`
      : location(input),
  })),
  lsp_format: lspSpec('Format', ({ input }) => ({
    subtitle: str(input.path),
    meta: input.preview === true ? 'preview' : undefined,
  })),
  lsp_rename_file: lspSpec('Rename file', ({ input }) => ({
    subtitle: `${str(input.from)} → ${str(input.to)}`,
    collapsed: false,
  })),
  lsp_servers: lspSpec('Language servers', ({ input }) => ({ subtitle: str(input.path) || 'all' })),

  // --- Debugger ------------------------------------------------------------------
  debug_start: debugSpec('Start debugging', ({ input, result }) => ({
    subtitle: [str(input.program) || str(input.address), list(input.args).map(String).join(' ')]
      .filter(Boolean)
      .join(' '),
    meta: str(result.fields.status) || str(result.fields.adapter) || undefined,
  })),
  debug_breakpoint: debugSpec('Breakpoint', ({ input }) => ({
    title: input.clear === true ? 'Clear breakpoints' : 'Breakpoint',
    subtitle:
      location(input) ||
      [str(input.path), list(input.lines).join(', ')].filter(Boolean).join(':') ||
      list(input.functions).map(String).join(', ') ||
      str(input.exceptions),
  })),
  debug_control: debugSpec('Step', ({ input }) => ({
    title: humanizeKey(str(input.action) || 'step'),
    subtitle: str(input.session) || undefined,
  })),
  debug_inspect: debugSpec('Inspect', ({ input, result }) => ({
    subtitle:
      str(input.expression) ||
      str(input.variable) ||
      (num(input.frame) !== undefined ? `frame ${num(input.frame)}` : 'current frame'),
    meta:
      num(result.fields.frames) !== undefined
        ? plural(num(result.fields.frames)!, 'frame')
        : undefined,
  })),
  debug_output: debugSpec('Program output', ({ input, result }) => ({
    subtitle: str(input.session) || undefined,
    body: result.isError ? (
      <ErrorText text={result.text} />
    ) : (
      <TextBlock text={result.text || 'no output'} maxLines={12} tail />
    ),
  })),
  debug_stop: debugSpec('Stop debugging', ({ input }) => ({
    subtitle: str(input.session) || undefined,
  })),
  debug_status: debugSpec('Debugger status', ({ input }) => ({
    subtitle: str(input.path) || undefined,
  })),

  // --- Codemap ------------------------------------------------------------------------
  codemap_find: {
    icon: '◈',
    category: 'code',
    title: 'Find in codebase',
    view: ({ input, result }) => ({
      subtitle: `“${str(input.query)}”`,
      meta: countMeta(result, 'result'),
    }),
  },
  codemap_symbol: {
    icon: '◈',
    category: 'code',
    title: 'Find symbol',
    view: ({ input, result }) => ({
      subtitle: str(input.name),
      meta: countMeta(result, 'definition'),
    }),
  },
  codemap_outline: {
    icon: '◈',
    category: 'code',
    title: 'Outline',
    view: ({ input, result }) => ({ subtitle: str(input.path), meta: countMeta(result, 'symbol') }),
  },
  codemap_overview: {
    icon: '◈',
    category: 'code',
    title: 'Project overview',
    view: ({ result }) => ({ meta: countMeta(result, 'file') }),
  },
  codemap_importers: {
    icon: '◈',
    category: 'code',
    title: 'Importers',
    view: ({ input, result }) => ({
      subtitle: str(input.module),
      meta: countMeta(result, 'importer'),
    }),
  },

  // --- Code execution -----------------------------------------------------------------
  python: { icon: '▶', category: 'run', title: 'Python', view: (ctx) => kernelView(ctx) },
  javascript: { icon: '▶', category: 'run', title: 'JavaScript', view: (ctx) => kernelView(ctx) },
  sql: {
    icon: '▦',
    category: 'read',
    title: 'SQL',
    view: ({ input, result }) => ({
      subtitle: `${firstLine(str(input.query))}  on ${str(input.path)}`,
      body: stack(<CodeBlock code={str(input.query)} maxLines={6} />, answer(result, 16)),
    }),
  },
  text: {
    icon: '≡',
    category: 'read',
    title: 'Text pipeline',
    view: ({ input, result }) => {
      const stages = list(input.stages)
        .map((stage) =>
          isRecord(stage)
            ? [stage.name ?? stage.op ?? stage.command, stage.args ?? stage.pattern ?? '']
                .filter(Boolean)
                .join(' ')
            : String(stage),
        )
        .join(' | ')
      return {
        subtitle: `${str(input.path) || 'input'} | ${stages}`,
        body: answer(result),
      }
    },
  },
  transcribe: {
    icon: '♪',
    category: 'network',
    title: 'Transcribe',
    view: ({ input, result }) => ({
      subtitle: str(input.path),
      meta:
        num(result.fields.chars) !== undefined
          ? plural(num(result.fields.chars)!, 'character')
          : undefined,
    }),
  },

  // --- Web and browser -------------------------------------------------------------
  web_search: {
    icon: '◍',
    category: 'network',
    title: 'Web search',
    view: ({ input, result }) => {
      const count = num(result.fields.count)
      const provider = str(result.fields.provider)
      return {
        subtitle: str(input.query),
        meta:
          count !== undefined
            ? `${plural(count, 'result')}${provider ? ` · ${provider}` : ''}`
            : undefined,
        body: answer(result, 16),
      }
    },
  },
  web_fetch: {
    icon: '◍',
    category: 'network',
    title: 'Fetch',
    view: ({ input, result }) => ({
      subtitle: str(input.url) || str(result.fields.url),
      meta:
        num(result.fields.bytes) !== undefined ? formatBytes(num(result.fields.bytes)!) : undefined,
      preview: '',
      body: answer(result, 14),
    }),
  },
  web_providers: { icon: '◍', category: 'network', title: 'Search providers' },
  browser_open: {
    icon: '◍',
    category: 'network',
    title: 'Open page',
    view: ({ input, result }) => {
      const errors = num(result.fields.errors)
      return {
        subtitle: str(input.url),
        meta: errors ? plural(errors, 'console error') : undefined,
      }
    },
  },
  browser_act: {
    icon: '◍',
    category: 'network',
    title: 'Browser',
    view: ({ input }) => ({
      title: humanizeKey(str(input.action) || 'act'),
      subtitle: [
        str(input.selector),
        str(input.text) ? `“${str(input.text)}”` : '',
        firstLine(str(input.expression)),
      ]
        .filter(Boolean)
        .join(' '),
      collapsed: false,
    }),
  },
  browser_inspect: {
    icon: '◍',
    category: 'network',
    title: 'Inspect page',
    view: ({ input }) => ({
      subtitle: [str(input.what), str(input.path)].filter(Boolean).join(' → '),
    }),
  },

  // --- Security ------------------------------------------------------------------------
  security_scan: {
    icon: '▲',
    category: 'security',
    title: 'Security scan',
    view: ({ input, result }) => {
      const findings = num(result.fields.findings)
      const files = num(result.fields.files)
      return {
        subtitle: str(input.path) || 'workspace',
        meta:
          findings !== undefined
            ? `${findings === 0 ? 'no findings' : plural(findings, 'finding')}${files !== undefined ? ` · ${plural(files, 'file')}` : ''}`
            : undefined,
        collapsed: !(findings && findings > 0),
        preview: findings ? firstLine(result.text) : '',
        body: answer(result, 16),
      }
    },
  },
  security_rules: { icon: '▲', category: 'security', title: 'Security rules' },

  // --- Memory -----------------------------------------------------------------------
  retain: {
    icon: '✦',
    category: 'memory',
    title: 'Remember',
    view: ({ input, result }) => ({
      subtitle: str(input.text),
      meta:
        [str(input.kind), input.global === true ? 'global' : ''].filter(Boolean).join(' · ') ||
        undefined,
      body: result.isError ? (
        <ErrorText text={result.text} />
      ) : str(input.text).length > 60 ? (
        <TextBlock text={str(input.text)} maxLines={6} />
      ) : null,
    }),
  },
  recall: {
    icon: '✦',
    category: 'memory',
    title: 'Recall',
    view: ({ input, result }) => {
      const memories = list(result.fields.memories).filter(isRecord)
      return {
        subtitle: `“${str(input.query)}”`,
        meta: result.pending
          ? undefined
          : memories.length
            ? plural(memories.length, 'memory', 'memories')
            : 'nothing found',
        preview: memories.map((m) => str(m.text)).join('  ·  '),
        body: memories.length ? (
          <ItemList
            items={memories.map((m) => ({ glyph: '✦', text: str(m.text), detail: str(m.kind) }))}
          />
        ) : (
          answer(result)
        ),
      }
    },
  },
  forget: {
    icon: '✦',
    category: 'memory',
    title: 'Forget',
    view: ({ input, result }) => ({
      subtitle: `memory #${String(input.id ?? '')}`,
      body: answer(result),
    }),
  },
  recall_archive: {
    icon: '✦',
    category: 'memory',
    title: 'Recall archive',
    view: ({ input, result }) => ({
      subtitle: [str(input.frame), str(input.query) ? `“${str(input.query)}”` : '']
        .filter(Boolean)
        .join(' · '),
      body: answer(result),
    }),
  },
}

function kernelView({ input, result }: ToolViewContext): Partial<ToolView> {
  const code = str(input.code)
  const duration = num(result.fields.durationMs)
  return {
    subtitle: firstLine(code),
    meta:
      duration !== undefined
        ? formatDuration(duration)
        : input.reset === true
          ? 'fresh kernel'
          : undefined,
    preview: firstLine(result.text),
    body: stack(
      <CodeBlock code={code} maxLines={10} />,
      result.isError ? (
        <ErrorText text={result.text} />
      ) : result.text.trim() ? (
        <CardSection label="Output">
          <TextBlock text={result.text} maxLines={12} />
        </CardSection>
      ) : null,
    ),
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** The interface's names back to Jean's, for blocks recorded before `sourceToolName`. */
const FROM_INTERFACE_NAME: Record<string, string> = {
  run_terminal_command: 'bash',
  read_files: 'read',
  write_file: 'write',
  str_replace: 'edit',
  code_search: 'grep',
  write_todos: 'todo',
  read_url: 'web_fetch',
}

export function jeanToolName(block: ToolBlock): string {
  if (block.sourceToolName) return block.sourceToolName
  const name = String(block.toolName)
  if (name === 'run_terminal_command' && isRecord(block.input) && block.input.job !== undefined)
    return 'bash_output'
  return FROM_INTERFACE_NAME[name] ?? name
}

/** Categories whose cards start open: the ones that change things or need attention. */
const OPEN_BY_DEFAULT = new Set<ToolCategory>(['run', 'write', 'plan', 'agent'])

/** `mcp__server__tool` → a spec named after the tool, attributed to its server. */
function mcpSpec(name: string): ToolSpec | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  if (!match) return undefined
  const [, server, tool] = match
  return {
    icon: '⊕',
    category: 'other',
    title: humanizeKey(tool!),
    view: (ctx) => {
      const summary = Object.values(ctx.input).find((v) => typeof v === 'string' && v.trim() !== '')
      return { subtitle: `${server}${summary ? ` · ${String(summary)}` : ''}` }
    },
  }
}

function specFor(name: string): ToolSpec {
  return (
    SPECS[name] ??
    mcpSpec(name) ?? {
      icon: '•',
      category: 'other',
      title: humanizeKey(name),
    }
  )
}

/** Everything the card needs to draw one tool call. */
export function describeToolCall(block: ToolBlock, isStreaming: boolean): ToolView {
  const name = jeanToolName(block)
  const spec = specFor(name)
  const input = isRecord(block.input) ? block.input : {}
  const result = parseToolResult(block)
  const status = toolStatus(result, isStreaming)
  const ctx: ToolViewContext = { name, input, result, status }
  const custom = spec.view?.(ctx) ?? {}

  const primary = spec.primary ?? []
  const subtitle =
    custom.subtitle ?? (primary.length ? stringArg(input, ...primary) : firstStringArg(input))
  // Arguments the header already shows are not repeated in the body.
  const omitArgs = [...primary, ...keysShownIn(input, subtitle ?? '')]

  const body =
    'body' in custom ? (
      custom.body
    ) : result.pending && !Object.keys(input).some((key) => !omitArgs.includes(key)) ? null : (
      <GenericBody args={input} omitArgs={omitArgs} result={result} />
    )

  const collapsed =
    status === 'error'
      ? false
      : (custom.collapsed ?? spec.collapsed ?? !OPEN_BY_DEFAULT.has(spec.category))

  return {
    icon: spec.icon,
    category: spec.category,
    title: custom.title ?? spec.title,
    subtitle,
    meta: custom.meta ?? countMeta(result, 'result'),
    preview: custom.preview ?? (result.pending ? '' : firstLine(result.text)),
    body,
    collapsed,
    status,
  }
}

/** Whether a tool block starts folded; the toggle reads this so one click always flips it. */
export function isToolCollapsedByDefault(block: ToolBlock): boolean {
  return describeToolCall(block, false).collapsed
}

/** Every tool that has its own entry — the test suite checks this covers the registry. */
export const TOOLS_WITH_SPECS: readonly string[] = Object.keys(SPECS)

function firstStringArg(input: Record<string, unknown>): string {
  for (const key of ['path', 'file', 'query', 'command', 'url', 'name', 'pattern', 'id']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

function keysShownIn(input: Record<string, unknown>, subtitle: string): string[] {
  if (!subtitle) return []
  return Object.keys(input).filter((key) => {
    const value = input[key]
    if (typeof value === 'string')
      return value.trim() !== '' && subtitle.includes(value.trim().split('\n')[0]!)
    if (typeof value === 'number') return subtitle.includes(String(value))
    return false
  })
}
