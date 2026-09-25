import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator, spawnSubagent } from '../packages/agent/src/index.ts'
import { sessionStats } from '../packages/cli/src/commands/sessions.ts'
import { type JeanConfig, defaultConfig } from '../packages/config/src/index.ts'
import {
  EventStore,
  FileHistory,
  deleteSession,
  exportSession,
  forkSession,
  importSession,
  listSessions,
  loadSession,
  renameSession,
  saveSession,
  sessionMarkdown,
} from '../packages/core/src/index.ts'
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  StreamEvent,
} from '../packages/model/src/types.ts'
import { skillsSignature } from '../packages/skills/src/index.ts'
import { Registry, builtinTools } from '../packages/tools/src/index.ts'

/**
 * What OpenCode 2.0 and its 1.18 line have that Jean did not: resumable
 * sub-agents, sessions that are exported, imported, forked, renamed, and
 * counted, `/redo`, skills that load while the session runs, and the
 * `agents`, `mcp`, `export`, `import`, `stats` commands.
 */

const temps: string[] = []
let previousHome: string | undefined

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jean-parity-')))
  temps.push(dir)
  return dir
}

beforeAll(() => {
  previousHome = process.env.JEAN_HOME
  process.env.JEAN_HOME = workspace()
})

afterAll(() => {
  if (previousHome === undefined) delete process.env.JEAN_HOME
  else process.env.JEAN_HOME = previousHome
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

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
      stopReason: 'stop',
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
      for (const block of response.content)
        if (block.type === 'text') yield { type: 'text', delta: block.text }
      yield { type: 'done', response }
    },
  }
  return { client: client as never, requests }
}

const lastUserText = (request: CompletionRequest) =>
  request.messages
    .filter((message) => message.role === 'user')
    .at(-1)
    ?.content.map((block) => (block.type === 'text' ? block.text : ''))
    .join('') ?? ''

describe('resumable sub-agents', () => {
  test('a report carries a task_id; passing it back continues the same agent with what it knew', async () => {
    const cwd = workspace()
    const { client, requests } = scripted((request) =>
      lastUserText(request).includes('follow up')
        ? [{ type: 'text', text: 'the second answer' }]
        : [{ type: 'text', text: 'the first report' }],
    )
    const registry = new Registry()
    registry.registerAll(builtinTools())
    const options = { client, registry, config: config(), cwd }

    const first = await spawnSubagent('explorer', 'Where is login defined?', options)
    expect(first.report).toContain('the first report')
    expect(first.taskId).toMatch(/^task_/)

    const second = await spawnSubagent('explorer', 'follow up: and logout?', {
      ...options,
      resume: first.taskId,
    })
    expect(second.ok).toBe(true)
    expect(second.taskId).toBe(first.taskId)
    expect(second.report).toContain('the second answer')
    // The resumed run saw its first task and its first answer.
    const seen = JSON.stringify(requests.at(-1)!.messages)
    expect(seen).toContain('Where is login defined?')
    expect(seen).toContain('the first report')

    expect((await spawnSubagent('verifier', 'x', { ...options, resume: first.taskId })).error).toBe(
      'wrong-agent',
    )
    expect((await spawnSubagent('explorer', 'x', { ...options, resume: 'task_nope' })).error).toBe(
      'unknown-task',
    )
  })
})

describe('sessions to keep and share', () => {
  function sample(): string {
    const store = new EventStore()
    const at = Date.now()
    store.append({
      type: 'session_start',
      at,
      cwd: '/work/proj',
      mode: 'autonomous',
      model: 'claude-sonnet-5',
    })
    store.append({
      type: 'user_message',
      at,
      text: 'deploy with key sk-ant-api03-abcdefghijklmnop and fix login',
    })
    store.append({
      type: 'assistant_message',
      at,
      model: 'anthropic/claude-sonnet-5',
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500 },
      content: [
        { type: 'text', text: 'Writing the fix.' },
        {
          type: 'tool_call',
          id: 'c1',
          name: 'write',
          input: { path: 'auth.ts', content: 'x'.repeat(2000) },
        },
      ],
    })
    store.append({
      type: 'tool_call',
      at,
      id: 'c1',
      name: 'write',
      input: { path: 'auth.ts', content: 'x'.repeat(2000) },
    })
    store.append({
      type: 'tool_result',
      at,
      id: 'c1',
      name: 'write',
      output: 'wrote 2000 bytes',
      isError: false,
    } as never)
    const id = `test-${Math.random().toString(36).slice(2, 8)}`
    saveSession(id, store)
    return id
  }

  test('rename, fork, delete', () => {
    const id = sample()
    expect(renameSession(id, 'Login fix')).toBe(true)
    expect(listSessions(undefined, 1000).find((meta) => meta.id === id)?.title).toBe('Login fix')
    const fork = forkSession(id)!
    expect(loadSession(fork)!.length).toBe(loadSession(id)!.length)
    expect(listSessions(undefined, 1000).find((meta) => meta.id === fork)?.title).toBe(
      'Login fix (fork)',
    )
    expect(deleteSession(fork)).toBe(true)
    expect(loadSession(fork)).toBeUndefined()
  })

  test('an export sanitized for sharing keeps the shape and drops secrets and contents', () => {
    const id = sample()
    const doc = exportSession(id, { sanitize: true })!
    const text = JSON.stringify(doc)
    expect(doc.format).toBe('jean-session')
    expect(text).not.toContain('sk-ant-api03')
    expect(text).toContain('[secret removed]')
    expect(text).not.toContain('x'.repeat(500))
    expect(text).toContain('characters removed]')
    expect(text).toContain('fix login')

    // Imported under a new id when the original is still here.
    const imported = importSession(doc)
    expect(imported).not.toBe(id)
    expect(loadSession(imported)!.length).toBe(doc.events.length)
    expect(() => importSession({ format: 'other' })).toThrow(/Jean session/)

    expect(sessionMarkdown(exportSession(id)!)).toContain('## You')
  })

  test('stats add up tokens, cost, models, and tools', () => {
    const id = sample()
    const { total, models, tools } = sessionStats([loadSession(id)!.toJSON()])
    expect(total).toMatchObject({
      sessions: 1,
      prompts: 1,
      turns: 1,
      toolCalls: 1,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 500,
    })
    expect(total.cost).toBeGreaterThan(0)
    expect(models.get('anthropic/claude-sonnet-5')?.turns).toBe(1)
    expect(tools.get('write')).toBe(1)
  })
})

describe('/undo and /redo', () => {
  test('a rewound turn comes back exactly, until a new prompt', () => {
    const dir = workspace()
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'before')
    const history = new FileHistory()
    history.beginTurn(0, 'change it')
    history.capture(file)
    writeFileSync(file, 'after')
    const created = join(dir, 'new.txt')
    history.capture(created)
    writeFileSync(created, 'new')

    const rewound = history.rewind(1)!
    expect(rewound.turns).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe('before')
    expect(existsSync(created)).toBe(false)
    history.rememberRewound([{ type: 'user_message', at: 1, text: 'change it' }])

    const redone = history.redo()!
    expect(redone.prompt).toBe('change it')
    expect(redone.events).toHaveLength(1)
    expect(readFileSync(file, 'utf8')).toBe('after')
    expect(readFileSync(created, 'utf8')).toBe('new')

    history.rewind(1)
    history.beginTurn(0, 'something else')
    expect(history.redo()).toBeUndefined()
  })
})

describe('skills load while the session runs', () => {
  test('a SKILL.md written by hand is there on the next look', () => {
    const cwd = workspace()
    const { client } = scripted(() => [{ type: 'text', text: 'ok' }])
    const agent = new Orchestrator({
      config: config(),
      client,
      cwd,
      sessionId: 'skills-test',
      store: new EventStore(),
    })
    const before = skillsSignature(cwd)
    expect(agent.availableSkills().some((skill) => skill.name === 'release-notes')).toBe(false)

    mkdirSync(join(cwd, '.jean', 'skills', 'release-notes'), { recursive: true })
    writeFileSync(
      join(cwd, '.jean', 'skills', 'release-notes', 'SKILL.md'),
      '---\nname: release-notes\ndescription: Write release notes from the git log\n---\nRead the log, group by kind, write it.\n',
    )
    expect(skillsSignature(cwd)).not.toBe(before)
    expect(agent.availableSkills().some((skill) => skill.name === 'release-notes')).toBe(true)
    agent.end()
  })
})

describe('the commands', () => {
  const cli = join(import.meta.dir, '..', 'packages', 'cli', 'src', 'index.ts')
  const run = (args: string[], cwd: string) => {
    const result = Bun.spawnSync(['bun', cli, '--no-import', ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', JEAN_CATALOG: 'off' },
      stdin: 'ignore',
    })
    return {
      code: result.exitCode,
      out: result.stdout.toString() + result.stderr.toString(),
      stdout: result.stdout.toString(),
    }
  }

  test('agents create, mcp add and remove, export, import, stats', () => {
    const cwd = workspace()

    expect(run(['agents', 'create', 'reviewer', 'Reviews', 'a', 'diff'], cwd).code).toBe(0)
    expect(readFileSync(join(cwd, '.jean', 'agents', 'reviewer.md'), 'utf8')).toContain(
      'name: reviewer',
    )
    expect(run(['agents'], cwd).out).toContain('reviewer')

    expect(run(['mcp', 'add', 'files', '--', 'npx', '-y', 'some-server'], cwd).code).toBe(0)
    expect(JSON.parse(readFileSync(join(cwd, '.jean.json'), 'utf8')).mcpServers.files).toEqual({
      command: 'npx',
      args: ['-y', 'some-server'],
    })
    expect(run(['mcp', 'remove', 'files'], cwd).code).toBe(0)
    expect(
      JSON.parse(readFileSync(join(cwd, '.jean.json'), 'utf8')).mcpServers.files,
    ).toBeUndefined()

    const store = new EventStore()
    store.append({ type: 'session_start', at: Date.now(), cwd, mode: 'autonomous', model: 'm' })
    store.append({ type: 'user_message', at: Date.now(), text: 'hello there' })
    saveSession('cli-export-1', store)

    const exported = run(['export', 'cli-export-1', '--sanitize'], cwd)
    expect(exported.code).toBe(0)
    const doc = JSON.parse(exported.stdout) as { format: string; sanitized: boolean }
    expect(doc).toMatchObject({ format: 'jean-session', sanitized: true })

    const file = join(cwd, 'session.json')
    writeFileSync(file, exported.stdout)
    const imported = run(['import', file], cwd)
    expect(imported.code).toBe(0)
    expect(imported.out).toContain('Imported as')

    const markdown = run(['export', 'cli-export-1', '-f', 'text'], cwd)
    expect(markdown.stdout).toContain('hello there')

    expect(run(['stats'], cwd).out).toMatch(/Sessions\s+\d+/)
    expect(run(['sessions'], cwd).out).toContain('cli-export-1')
  }, 90_000)
})
