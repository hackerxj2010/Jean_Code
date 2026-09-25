/**
 * Draws a sample of every kind of tool card, the way the chat will show them.
 *
 * `bun packages/tui2/preview-tools.tsx [width] [--plain] [--expand] [tool...]`
 *
 * Tool cards are only seen mid-conversation, which needs a model, a task, and
 * luck in which tools get called. This renders fixed calls through the real
 * path — Jean's result → `adaptOutput` → the block update → the card — into
 * opentui's test renderer and prints the frame, so a layout change can be
 * checked in seconds. `--expand` opens every card; `--plain` drops colour.
 */

import { testRender } from '@opentui/react/test-utils'

import { adaptInput, adaptOutput, renameTool } from './src/compat/tool-names'
import { ToolBranch } from './src/components/blocks/tool-branch'
import { initializeThemeStore } from './src/hooks/use-theme'
import { updateToolBlockWithOutput } from './src/utils/message-block-helpers'
import { createMarkdownPalette } from './src/utils/theme-system'

import type { ToolName } from '@codebuff/sdk'
import type { ContentBlock } from './src/types/chat'

type ToolBlock = Extract<ContentBlock, { type: 'tool' }>

const args = process.argv.slice(2)
const width = Number(args.find((a) => /^\d+$/.test(a)) ?? 100)
const plain = args.includes('--plain')
const expand = args.includes('--expand')
const only = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a))

const before = `export function greet(name: string) {\n  return 'Hello ' + name\n}\n\nexport const version = 1\n`
const after = `export function greet(name: string, excited = false) {\n  const greeting = \`Hello \${name}\`\n  return excited ? greeting + '!' : greeting\n}\n\nexport const version = 2\n`

/** name, arguments, Jean's result (undefined = still running). */
const SAMPLES: [string, Record<string, unknown>, unknown][] = [
  [
    'bash',
    { command: 'bun test tests/tui.test.ts' },
    {
      output:
        'bun test v1.3.11\n\n tests/tui.test.ts:\n ✓ tool names\n ✓ tool inputs\n ✓ tool results\n\n 18 pass\n 0 fail\nRan 18 tests across 1 file. [42ms]\n',
      display: { kind: 'bash', command: 'bun test', exitCode: 0, cwd: '/home/user/Jean_Code' },
    },
  ],
  [
    'bash',
    { command: 'npm run build' },
    {
      output: 'src/index.ts(12,3): error TS2322: Type string is not assignable to type number.\n',
      isError: true,
      display: { kind: 'bash', command: 'npm run build', exitCode: 2 },
    },
  ],
  ['bash', { command: 'sleep 30 && echo done' }, undefined],
  [
    'read',
    { path: 'src/greet.ts' },
    {
      output:
        "   1 | export function greet(name: string) {\n   2 |   return 'Hello ' + name\n   3 | }\n",
      display: { kind: 'file', path: 'src/greet.ts', lines: 5, offset: 1, shown: 5 },
    },
  ],
  [
    'edit',
    { path: 'src/greet.ts', old_string: "return 'Hello ' + name", new_string: '...' },
    {
      output: 'Edited src/greet.ts.',
      display: { kind: 'edit', path: 'src/greet.ts', mode: 'replace', before, after },
    },
  ],
  [
    'write',
    {
      path: 'src/config.json',
      content: '{\n  "name": "demo",\n  "port": 8080,\n  "debug": true\n}\n',
    },
    {
      output: 'Created src/config.json (5 lines).',
      display: { kind: 'write', path: 'src/config.json', created: true, lines: 5 },
    },
  ],
  [
    'glob',
    { pattern: '**/*.test.ts' },
    {
      output: '4 files',
      display: {
        kind: 'glob',
        pattern: '**/*.test.ts',
        matches: [
          'tests/acp.test.ts',
          'tests/archives.test.ts',
          'tests/theme.test.ts',
          'tests/tui.test.ts',
        ],
      },
    },
  ],
  [
    'grep',
    { pattern: 'describeToolCall', path: 'packages/tui2' },
    {
      output: '3 matches',
      display: {
        kind: 'grep',
        pattern: 'describeToolCall',
        matches: [
          {
            path: 'src/components/tools/tool-specs.tsx',
            line: 812,
            text: 'export function describeToolCall(block: ToolBlock, isStreaming: boolean): ToolView {',
          },
          {
            path: 'src/components/tools/tool-specs.tsx',
            line: 855,
            text: '  return describeToolCall(block, false).collapsed',
          },
          {
            path: 'src/components/blocks/tool-branch.tsx',
            line: 52,
            text: '    const view = describeToolCall(toolBlock, isStreaming)',
          },
        ],
      },
    },
  ],
  [
    'todo',
    { action: 'start', id: '2' },
    {
      output: '...',
      display: {
        kind: 'todo',
        items: [
          { id: '1', text: 'Read the tool registry', status: 'completed' },
          { id: '2', text: 'Design the tool card', status: 'in_progress' },
          { id: '3', text: 'Give every tool a component', status: 'pending' },
          { id: '4', text: 'Test in a real terminal', status: 'pending' },
        ],
      },
    },
  ],
  [
    'git_status',
    {},
    {
      output: 'On branch main, 3 changed files',
      display: {
        kind: 'git-status',
        branch: 'main',
        files: [
          { code: 'M', path: 'packages/tui2/src/components/blocks/tool-branch.tsx' },
          { code: 'A', path: 'packages/tui2/src/components/tools/tool-card.tsx' },
          { code: '??', path: 'packages/tui2/preview-tools.tsx' },
        ],
      },
    },
  ],
  [
    'git_commit',
    { message: 'Draw every tool call as a card', paths: ['a.ts'] },
    {
      output: '[main 1a2b3c4] Draw every tool call as a card\n\nCommitted 2 files.',
      display: {
        kind: 'git-commit',
        message: 'Draw every tool call as a card',
        files: [
          'packages/tui2/src/components/tools/tool-card.tsx',
          'packages/tui2/src/components/tools/tool-specs.tsx',
        ],
      },
    },
  ],
  [
    'lsp_diagnostics',
    { path: 'src/greet.ts' },
    {
      output:
        'src/greet.ts:3:10 error  Cannot find name "greting".\nsrc/greet.ts:7:1  warning  Unused variable "x".',
      display: { kind: 'diagnostics', count: 2 },
    },
  ],
  [
    'lsp_references',
    { path: 'src/greet.ts', line: 1, symbol: 'greet' },
    {
      output: 'src/app.ts:4:10\nsrc/cli.ts:18:3\ntests/greet.test.ts:6:12',
      display: { kind: 'locations', count: 3 },
    },
  ],
  [
    'web_search',
    { query: 'opentui rounded border box' },
    {
      output:
        '1. OpenTUI — Box renderable\n   https://github.com/sst/opentui\n   Boxes support single, double, rounded and heavy borders.\n2. Terminal UI layout with Yoga\n   https://example.com/yoga',
      display: { kind: 'search', provider: 'brave', count: 2 },
    },
  ],
  [
    'python',
    {
      code: 'import statistics\nvalues = [3, 1, 4, 1, 5, 9, 2, 6]\nprint(statistics.mean(values), statistics.median(values))',
    },
    { output: '3.875 3.5', display: { kind: 'kernel', language: 'python', durationMs: 84 } },
  ],
  [
    'recall',
    { query: 'preferred test runner' },
    {
      output: '1 memory',
      display: {
        kind: 'memory-recall',
        memories: [
          { id: 3, kind: 'preference', text: 'Use bun test, not jest, in this repository.' },
        ],
      },
    },
  ],
  [
    'security_scan',
    { path: 'packages' },
    { output: 'No findings in 412 files.', display: { kind: 'security', findings: 0, files: 412 } },
  ],
  [
    'ask',
    { question: 'Which theme should be the default?', options: ['dark', 'monokai', 'dark-blue'] },
    { output: 'The user answered: monokai', display: { kind: 'ask', answer: 'monokai' } },
  ],
  [
    'mcp__linear__create_issue',
    { title: 'Tool cards overflow at 60 columns', team: 'TUI', priority: 2 },
    { output: 'Created issue TUI-42: Tool cards overflow at 60 columns' },
  ],
  [
    'some_new_tool',
    { target: 'staging', dryRun: true, retries: 3 },
    {
      output: 'Deployed 3 services.\nAll health checks passed.',
      display: { kind: 'deploy', services: ['api', 'web', 'worker'], region: 'eu-west-1' },
    },
  ],
]

function blockFor([name, input, result]: (typeof SAMPLES)[number], index: number): ToolBlock {
  const block: ToolBlock = {
    type: 'tool',
    toolCallId: `call-${index}`,
    toolName: renameTool(name) as ToolName,
    sourceToolName: name,
    input: adaptInput(name, input),
    ...(expand ? { isCollapsed: false } : {}),
  }
  if (result === undefined) return block
  const [updated] = updateToolBlockWithOutput([block], {
    toolCallId: block.toolCallId,
    toolOutput: adaptOutput(name, result) as never,
  })
  return updated as ToolBlock
}

const ESC = String.fromCharCode(27)

// The test renderer turns on React's act() checks, which only make sense
// inside a test runner; here they would print a warning per card.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
const consoleError = console.error
console.error = (...parts: unknown[]) => {
  if (String(parts[0]).includes('not wrapped in act')) return
  consoleError(...parts)
}

async function main() {
  initializeThemeStore()
  const { useThemeStore } = await import('./src/hooks/use-theme')
  const palette = createMarkdownPalette(useThemeStore.getState().theme)
  const samples = SAMPLES.filter(([name]) => only.length === 0 || only.includes(name))

  for (const [index, sample] of samples.entries()) {
    const block = blockFor(sample, index)
    const setup = await testRender(
      <ToolBranch
        toolBlock={block}
        keyPrefix={`preview-${index}`}
        availableWidth={width}
        onToggleCollapsed={() => {}}
        markdownPalette={palette}
      />,
      { width, height: 60 },
    )
    await setup.renderOnce()
    const frame = setup.captureSpans()
    // Trim on the plain text: in colour mode the escapes hide trailing blanks.
    const lines = frame.lines.filter((line) => line.spans.some((span) => span.text.trim() !== ''))
    const rows = lines.map((line) =>
      line.spans
        .map((span) => {
          if (plain) return span.text
          const [r, g, b] = span.fg.toInts()
          const bold = span.attributes & 1 ? `${ESC}[1m` : ''
          return `${ESC}[38;2;${r};${g};${b}m${bold}${span.text}${ESC}[0m`
        })
        .join('')
        .replace(/\s+$/, ''),
    )
    console.log(rows.join('\n'))
    setup.renderer.destroy()
  }
  process.exit(0)
}

main()
