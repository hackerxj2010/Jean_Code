import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDefinition } from '../packages/agent/src/agents/definitions.ts'
import { Orchestrator, spawnSubagent } from '../packages/agent/src/index.ts'
import { type JeanConfig, defaultConfig } from '../packages/config/src/index.ts'
import type { LoopEvent } from '../packages/core/src/index.ts'
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  StreamEvent,
} from '../packages/model/src/types.ts'
import { Registry, builtinTools } from '../packages/tools/src/index.ts'
import { JeanClient } from '../packages/tui2/src/compat/client.ts'
import type { PrintModeEvent } from '../packages/tui2/src/compat/types.ts'

/**
 * Sub-agents — the explorer above all — end to end with a scripted model:
 * a run that spends its turns still reports what it found, and what a
 * sub-agent does reaches the interface under the `spawn` call that started
 * it, with its report at the end.
 */

const temps: string[] = []
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jean-subagents-')))
  temps.push(dir)
  writeFileSync(join(dir, 'auth.ts'), 'export function login() {}\n')
  return dir
}

const config = (): JeanConfig => ({
  ...defaultConfig(),
  permissionMode: 'full',
  advisor: { enabled: false },
  autoCompact: false,
})

/** A model client that answers each request with `answer(request)`. */
function scripted(answer: (request: CompletionRequest) => ContentBlock[]) {
  const requests: CompletionRequest[] = []
  const complete = async (request: CompletionRequest): Promise<CompletionResponse> => {
    requests.push(request)
    const content = answer(request)
    return {
      content,
      stopReason: content.some((b) => b.type === 'tool_call') ? 'tool_use' : 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'scripted',
      provider: 'x',
      latencyMs: 1,
    }
  }
  const client = {
    resolve: () => ({
      role: 'default',
      provider: 'x',
      modelId: 'scripted',
      maxTokens: 4096,
      fallbacks: [],
    }),
    isConfigured: () => true,
    complete,
    async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent, void, void> {
      const response = await complete(request)
      for (const block of response.content) {
        if (block.type === 'text') yield { type: 'text', delta: block.text }
        if (block.type === 'tool_call')
          yield { type: 'tool_call', id: block.id, name: block.name, input: block.input }
      }
      yield { type: 'done', response }
    },
  }
  return { client: client as never, requests }
}

const isSubagent = (request: CompletionRequest) => (request.system ?? '').includes('### The task')
let calls = 0
const glob = (): ContentBlock => ({
  type: 'tool_call',
  id: `glob-${++calls}`,
  name: 'glob',
  input: { pattern: '**/*.ts' },
})

describe('an explorer that runs out of turns', () => {
  test('writes its report in a closing turn without tools, and it counts as a report', async () => {
    const cwd = project()
    const { client, requests } = scripted((request) =>
      // Searches forever — until it is asked for words only.
      request.toolChoice === 'none'
        ? [{ type: 'text', text: 'Login lives in auth.ts:1.' }]
        : [glob()],
    )
    const registry = new Registry()
    registry.registerAll(builtinTools())
    const explorer: AgentDefinition = {
      name: 'explorer',
      purpose: 'search',
      role: 'smol',
      tools: ['glob', 'read'],
      maxTurns: 5,
      instructions: 'Search.',
    }

    const result = await spawnSubagent('explorer', 'Where is login?', {
      client,
      registry,
      config: config(),
      cwd,
      agents: [explorer],
    })

    expect(result.ok).toBe(true)
    expect(result.report).toContain('Login lives in auth.ts:1.')
    expect(result.report).toContain('turn limit')
    expect(result.turns).toBe(5)
    // Five turns with tools, then the closing one — which still defines the tools.
    expect(requests).toHaveLength(6)
    expect(requests[5]?.toolChoice).toBe('none')
    expect(requests[5]?.tools?.length).toBeGreaterThan(0)
    // Warned on its last turn with tools.
    expect(JSON.stringify(requests[4]?.messages)).toContain('last turn with tools')
  })
})

describe('what a sub-agent does reaches the interface', () => {
  const parentAndExplorer = () =>
    scripted((request) => {
      const seen = JSON.stringify(request.messages)
      if (isSubagent(request)) {
        return seen.includes('auth.ts')
          ? [{ type: 'text', text: 'Found it: auth.ts:1 defines login.' }]
          : [glob()]
      }
      return seen.includes('Found it')
        ? [{ type: 'text', text: 'The explorer says auth.ts.' }]
        : [
            {
              type: 'tool_call',
              id: 'spawn-1',
              name: 'spawn',
              input: { agent: 'explorer', task: 'Find login' },
            },
          ]
    })

  test('the orchestrator emits its events under the spawn call', async () => {
    const cwd = project()
    const events: LoopEvent[] = []
    const agent = new Orchestrator({
      config: config(),
      client: parentAndExplorer().client,
      cwd,
      sessionId: `subagents-${Date.now()}`,
      onEvent: (event) => events.push(event),
    })
    await agent.send('Where is login?')
    agent.end('test')

    const inner = events.filter(
      (e): e is Extract<LoopEvent, { type: 'subagent' }> => e.type === 'subagent',
    )
    expect(inner.length).toBeGreaterThan(0)
    expect(inner.every((e) => e.spawnId === 'spawn-1' && e.agent === 'explorer')).toBe(true)
    expect(inner.some((e) => e.event.type === 'tool_start' && e.event.name === 'glob')).toBe(true)
    const spawned = events.find((e) => e.type === 'tool_end' && e.id === 'spawn-1')
    expect(spawned?.type === 'tool_end' && spawned.result.output).toContain('Found it: auth.ts:1')
  })

  test('the full-screen client nests its calls in the agent block and ends with its report', async () => {
    const cwd = project()
    const jean = new JeanClient({ cwd } as never)
    const agent = new Orchestrator({
      config: config(),
      client: parentAndExplorer().client,
      cwd,
      sessionId: `subagents-tui-${Date.now()}`,
    })
    // The client builds its own orchestrator on first use; this one is scripted.
    Object.assign(jean as object, {
      orchestrator: agent,
      baseline: { effort: 'normal', permissionMode: 'full' },
    })

    const seen: PrintModeEvent[] = []
    await jean.run({
      prompt: 'Where is login?',
      content: undefined,
      handleEvent: (event: PrintModeEvent) => seen.push(event),
      handleStreamChunk: () => undefined,
      signal: new AbortController().signal,
    } as never)
    agent.end('test')

    const start = seen.find((e) => e.type === 'subagent_start')
    expect(start).toMatchObject({ agentId: 'spawn-1', agentType: 'explorer', prompt: 'Find login' })
    const nested = seen.find((e) => e.type === 'tool_call' && e.toolName === 'glob')
    expect(nested).toMatchObject({ agentId: 'spawn-1', parentAgentId: 'spawn-1' })
    const nestedResult = seen.find(
      (e) =>
        e.type === 'tool_result' && e.toolCallId === (nested as { toolCallId: string }).toolCallId,
    )
    expect(nestedResult).toMatchObject({ agentId: 'spawn-1' })
    const finish = seen.find((e) => e.type === 'subagent_finish')
    expect(JSON.stringify(finish)).toContain('Found it: auth.ts:1')
    // Its tool calls are inside its block, not at the top level.
    expect(
      seen.filter((e) => e.type === 'tool_call' && !('agentId' in e && e.agentId)),
    ).toHaveLength(0)
  })
})
