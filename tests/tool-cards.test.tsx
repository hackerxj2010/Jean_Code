import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testRender } from '@opentui/react/test-utils'
import { act } from 'react'

import { Orchestrator } from '../packages/agent/src/index.ts'
import { defaultConfig } from '../packages/config/src/index.ts'
import { adaptInput, adaptOutput, renameTool } from '../packages/tui2/src/compat/tool-names'
import { ToolBranch } from '../packages/tui2/src/components/blocks/tool-branch'
import {
  TOOLS_WITH_SPECS,
  describeToolCall,
} from '../packages/tui2/src/components/tools/tool-specs'
import { initializeThemeStore, useThemeStore } from '../packages/tui2/src/hooks/use-theme'
import { diffStats, unifiedDiff } from '../packages/tui2/src/utils/line-diff'
import { updateToolBlockWithOutput } from '../packages/tui2/src/utils/message-block-helpers'
import { createMarkdownPalette } from '../packages/tui2/src/utils/theme-system'
import { parseToolResult } from '../packages/tui2/src/utils/tool-result'

import type { ContentBlock } from '../packages/tui2/src/types/chat'

type ToolBlock = Extract<ContentBlock, { type: 'tool' }>

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A tool call as the interface records it after Jean ran it. */
function call(
  name: string,
  input: Record<string, unknown>,
  result?: unknown,
  extra: Partial<ToolBlock> = {},
): ToolBlock {
  const block: ToolBlock = {
    type: 'tool',
    toolCallId: `call-${name}`,
    toolName: renameTool(name) as never,
    sourceToolName: name,
    input: adaptInput(name, input),
    ...extra,
  }
  if (result === undefined) return block
  const [updated] = updateToolBlockWithOutput([block], {
    toolCallId: block.toolCallId,
    toolOutput: adaptOutput(name, result) as never,
  })
  return updated as ToolBlock
}

async function frame(block: ToolBlock, width = 80): Promise<string> {
  initializeThemeStore()
  let setup!: Awaited<ReturnType<typeof testRender>>
  await act(async () => {
    setup = await testRender(
      <ToolBranch
        toolBlock={block}
        keyPrefix="t"
        availableWidth={width}
        onToggleCollapsed={() => {}}
        markdownPalette={createMarkdownPalette(useThemeStore.getState().theme)}
      />,
      { width, height: 40 },
    )
  })
  await act(async () => {
    await setup.renderOnce()
  })
  const text = setup.captureCharFrame()
  act(() => setup.renderer.destroy())
  return text
}

describe('tool card coverage', () => {
  test('every tool the agent can call has its own card', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'jean-cards-'))
    temps.push(cwd)
    const agent = new Orchestrator({
      config: { ...defaultConfig(), advisor: { enabled: false } },
      client: { resolve: () => ({ modelId: 'test' }) } as never,
      cwd,
      sessionId: `cards-${Date.now()}`,
    })
    const missing = agent.registry
      .names()
      .filter((name) => !name.startsWith('mcp__') && !TOOLS_WITH_SPECS.includes(name))
    agent.end('test')
    expect(missing).toEqual([])
  })

  test('tools registered only in some setups are covered too', () => {
    for (const name of ['retain', 'recall', 'forget', 'slash_command', 'spawn', 'recall_archive']) {
      expect(TOOLS_WITH_SPECS).toContain(name)
    }
  })
})

describe('reading a tool result', () => {
  test('a call without a result is still running', () => {
    expect(parseToolResult(call('read', { path: 'a.ts' })).pending).toBe(true)
  })

  test('the readable text and the display fields both survive', () => {
    const result = parseToolResult(
      call(
        'lsp_diagnostics',
        { path: 'a.ts' },
        { output: 'a.ts:1 error', display: { kind: 'diagnostics', count: 1 } },
      ),
    )
    expect(result.text).toBe('a.ts:1 error')
    expect(result.fields).toMatchObject({ kind: 'diagnostics', count: 1 })
  })

  test('a shell command that exits non-zero is a failure', () => {
    const block = call(
      'bash',
      { command: 'x' },
      { output: '', display: { kind: 'bash', command: 'x', exitCode: 3 } },
    )
    expect(parseToolResult(block).isError).toBe(true)
  })
})

describe('describing a tool call', () => {
  test('an edit shows the file and how many lines changed', () => {
    const view = describeToolCall(
      call(
        'edit',
        { path: 'a.ts' },
        {
          output: 'ok',
          display: { kind: 'edit', path: 'a.ts', before: 'a\nb\n', after: 'a\nc\nd\n' },
        },
      ),
      false,
    )
    expect(view.subtitle).toBe('a.ts')
    expect(view.meta).toBe('+2 −1')
    expect(view.status).toBe('done')
  })

  test('a failed call starts open, whatever its category', () => {
    const view = describeToolCall(
      call('read', { path: 'nope.ts' }, { output: 'No such file', isError: true }),
      false,
    )
    expect(view.status).toBe('error')
    expect(view.collapsed).toBe(false)
  })

  test('an MCP tool is named after the tool and its server', () => {
    const view = describeToolCall(
      call('mcp__linear__create_issue', { title: 'Bug' }, { output: 'Created' }),
      false,
    )
    expect(view.title).toBe('Create issue')
    expect(view.subtitle).toBe('linear · Bug')
  })
})

describe('rendered cards', () => {
  test('arguments and results read as fields and text, never JSON', async () => {
    const text = await frame(
      call(
        'some_new_tool',
        { target: 'staging', dryRun: true, retries: 3 },
        {
          output: 'Deployed.',
          display: { kind: 'deploy', services: ['api', 'web'], region: 'eu-west-1' },
        },
        { isCollapsed: false },
      ),
    )
    expect(text).toContain('Some new tool')
    expect(text).toContain('Dry run  yes')
    expect(text).toContain('Services  api, web')
    expect(text).not.toMatch(/[{}"]/)
  })

  test('a card is a rounded box with the outcome on the right', async () => {
    const text = await frame(
      call(
        'bash',
        { command: 'echo hi' },
        { output: 'hi\n', display: { kind: 'bash', command: 'echo hi', exitCode: 0 } },
      ),
      60,
    )
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    expect(lines[0]!.startsWith('╭')).toBe(true)
    expect(lines[1]).toMatch(/Run {2}echo hi.*✓ exit 0 │$/)
    expect(text).toContain('$ echo hi')
    expect(lines.at(-1)!.startsWith('╰')).toBe(true)
  })

  test('the plan is a checklist', async () => {
    const text = await frame(
      call(
        'todo',
        { action: 'list' },
        {
          output: '…',
          display: {
            kind: 'todo',
            items: [
              { id: '1', text: 'Write the card', status: 'completed' },
              { id: '2', text: 'Test it', status: 'in_progress' },
            ],
          },
        },
      ),
    )
    expect(text).toContain('✓ Write the card')
    expect(text).toContain('◐ Test it')
    expect(text).toContain('1/2 done')
  })
})

describe('line diff', () => {
  test('marks what was removed before what replaced it', () => {
    const diff = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n')
    expect(diff.split('\n').filter((l) => /^[+-]/.test(l))).toEqual(['-b', '+B'])
    expect(diffStats(diff)).toEqual({ added: 1, removed: 1 })
  })

  test('identical text has no diff', () => {
    expect(unifiedDiff('same\n', 'same\n')).toBe('')
  })
})
