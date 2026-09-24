import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator, loadAgent } from '../packages/agent/src/index.ts'
import {
  createSlashCommandTool,
  discoverCommands,
  expandCommand,
  parseSlash,
  splitArgs,
} from '../packages/commands/src/index.ts'
import { defaultConfig } from '../packages/config/src/index.ts'
import { loadPolicy } from '../packages/hooks/src/index.ts'
import type { CompletionRequest, StreamEvent } from '../packages/model/src/types.ts'
import { createSkillTools, discoverSkills } from '../packages/skills/src/index.ts'

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows may still hold a handle a child process used.
    }
  }
})

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'jean-ext-'))
  temps.push(root)
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

/** An isolated home, so nothing from the real user's setup leaks in. */
function isolatedEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), 'jean-home-'))
  temps.push(home)
  return { ...process.env, HOME: home, USERPROFILE: home, JEAN_HOME: join(home, '.jean') }
}

describe('slash command parsing', () => {
  test('splits the name from the arguments', () => {
    expect(parseSlash('/fix-issue 123 urgent')).toEqual({ name: 'fix-issue', args: '123 urgent' })
    expect(parseSlash('/frontend:component')).toEqual({ name: 'frontend:component', args: '' })
    expect(parseSlash('not a command')).toBeUndefined()
  })

  test('quotes group words like a shell', () => {
    expect(splitArgs(`one "two three" 'four five' six`)).toEqual([
      'one',
      'two three',
      'four five',
      'six',
    ])
  })
})

describe('custom commands', () => {
  test('are discovered with front matter, namespaced by folder', () => {
    const cwd = project({
      '.jean/commands/review.md':
        '---\ndescription: Review the diff\nargument-hint: [focus]\nallowed-tools: Bash(git diff:*), Read\n---\nReview. Focus on $ARGUMENTS.',
      '.jean/commands/frontend/component.md': 'Create a component named $1.',
    })
    const commands = discoverCommands(cwd, { env: isolatedEnv() })
    const review = commands.find((c) => c.name === 'review')!
    expect(review.description).toBe('Review the diff')
    expect(review.argumentHint).toBe('[focus]')
    expect(review.allowedTools).toEqual(['Bash(git diff:*)', 'Read'])
    expect(commands.map((c) => c.name)).toContain('frontend:component')
  })

  test("Jean's directory overrides Claude Code's for the same name", () => {
    const cwd = project({
      '.claude/commands/deploy.md': 'claude version',
      '.jean/commands/deploy.md': 'jean version',
    })
    const deploy = discoverCommands(cwd, { env: isolatedEnv() }).find((c) => c.name === 'deploy')!
    expect(deploy.body).toBe('jean version')
  })

  test('expand arguments, positionals, and @file references', async () => {
    const cwd = project({
      '.jean/commands/fix.md': 'Fix issue $1 with priority $2. All: $ARGUMENTS\nContext: @notes.md',
      'notes.md': 'The bug is in the parser.',
    })
    const [command] = discoverCommands(cwd, { env: isolatedEnv() }).filter((c) => c.name === 'fix')
    const { prompt } = await expandCommand(command!, '42 high', { cwd, allowShell: false })
    expect(prompt).toContain('Fix issue 42 with priority high. All: 42 high')
    expect(prompt).toContain('The bug is in the parser.')
  })

  test('never inlines a credentials file or one outside the project', async () => {
    const cwd = project({ '.jean/commands/x.md': 'A @.env B @../outside.txt', '.env': 'SECRET=1' })
    const [command] = discoverCommands(cwd, { env: isolatedEnv() }).filter((c) => c.name === 'x')
    const { prompt, notes } = await expandCommand(command!, '', { cwd, allowShell: false })
    expect(prompt).not.toContain('SECRET')
    expect(notes.length).toBe(2)
  })

  test('runs !`commands` only when allowed', async () => {
    const cwd = project({ '.jean/commands/status.md': 'Status:\n!`echo $((6 * 7))`' })
    const [command] = discoverCommands(cwd, { env: isolatedEnv() }).filter(
      (c) => c.name === 'status',
    )
    const ran = await expandCommand(command!, '', { cwd, allowShell: true })
    expect(ran.prompt).toBe('Status:\n42')
    const skipped = await expandCommand(command!, '', { cwd, allowShell: false })
    expect(skipped.prompt).not.toContain('42')
    expect(skipped.prompt).toContain('not trusted')
  })

  test('the model can run a command, but not one that opted out', async () => {
    const cwd = project({
      '.jean/commands/release.md': 'Bump the version, tag, and publish.',
      '.jean/commands/secret-op.md': '---\ndisable-model-invocation: true\n---\nDo the thing.',
    })
    const commands = discoverCommands(cwd, { env: isolatedEnv() })
    const tool = createSlashCommandTool(() => commands, cwd)
    expect(tool.description).toContain('/release')
    expect(tool.description).not.toContain('/secret-op')

    const result = await tool.execute({ command: '/release' }, {} as never)
    expect(result.output).toContain('Bump the version')
    const refused = await tool.execute({ command: 'secret-op' }, {} as never)
    expect(refused.isError).toBe(true)
  })
})

describe('custom agents', () => {
  test('parse Claude Code agent files, mapping tools and model aliases', () => {
    const cwd = project({
      'reviewer.md':
        '---\nname: security-reviewer\ndescription: Reviews diffs for vulnerabilities.\ntools: Read, Grep, Bash, MultiEdit\nmodel: opus\n---\nYou review for security.',
    })
    const agent = loadAgent(join(cwd, 'reviewer.md'), 'project')!
    expect(agent.name).toBe('security-reviewer')
    expect(agent.tools).toEqual(['read', 'grep', 'bash', 'edit'])
    expect(agent.role).toBe('slow')
    expect(agent.model).toBeUndefined()
    expect(agent.instructions).toBe('You review for security.')
  })

  test('a full model id is kept as an explicit model', () => {
    const cwd = project({
      'a.md':
        '---\nname: fast\ndescription: Quick lookups.\nmodel: openai/gpt-5.6-luna\n---\nBe quick.',
    })
    const agent = loadAgent(join(cwd, 'a.md'), 'user')!
    expect(agent.model).toBe('openai/gpt-5.6-luna')
    expect(agent.tools).toBe('*')
  })

  test('a file without a description is not an agent', () => {
    const cwd = project({ 'b.md': '---\nname: nameless\n---\nbody' })
    expect(loadAgent(join(cwd, 'b.md'), 'user')).toBeUndefined()
  })
})

describe('skills as tools', () => {
  test('a saved skill can be loaded back, in the same session', async () => {
    const cwd = project()
    let skills = discoverSkills(cwd)
    const [load, save] = createSkillTools({
      cwd,
      skills: () => skills,
      onSaved: () => {
        skills = discoverSkills(cwd)
      },
    })

    const saved = await save!.execute({
      name: 'run-flaky-tests',
      description: 'How to run the integration tests without the flaky timeouts',
      instructions: '1. Export TZ=UTC\n2. Run `bun test --timeout 20000`',
      scope: 'project',
      triggers: ['flaky', 'integration'],
    })
    expect(saved.isError).toBeFalsy()
    expect(existsSync(join(cwd, '.jean', 'skills', 'run-flaky-tests', 'SKILL.md'))).toBe(true)
    expect(load!.description).toContain('run-flaky-tests')

    const loaded = await load!.execute({ name: 'run-flaky-tests' })
    expect(loaded.output).toContain('Export TZ=UTC')
  })

  test('refuses a bad name and will not overwrite without asking', async () => {
    const cwd = project()
    const [, save] = createSkillTools({ cwd, skills: () => [] })
    const bad = await save!.execute({
      name: 'Bad Name!',
      description: 'a description here',
      instructions: 'x',
      scope: 'project',
    })
    expect(bad.isError).toBe(true)

    const args = {
      name: 'once',
      description: 'a description here',
      instructions: 'v1',
      scope: 'project' as const,
    }
    await save!.execute(args)
    const again = await save!.execute({ ...args, instructions: 'v2' })
    expect(again.isError).toBe(true)
    const replaced = await save!.execute({ ...args, instructions: 'v2', replace: true })
    expect(replaced.isError).toBeFalsy()
    expect(readFileSync(join(cwd, '.jean', 'skills', 'once', 'SKILL.md'), 'utf8')).toContain('v2')
  })
})

// ---------------------------------------------------------------------------
// Through the orchestrator.

function scriptedClient(texts: string[]) {
  const requests: CompletionRequest[] = []
  let i = 0
  return {
    requests,
    client: {
      resolve: () => ({
        role: 'default',
        provider: 'x',
        modelId: 'scripted',
        maxTokens: 4096,
        fallbacks: [],
      }),
      isConfigured: () => true,
      async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent, void, void> {
        requests.push(request)
        yield {
          type: 'done',
          response: {
            content: [{ type: 'text', text: texts[i++] ?? 'ok' }],
            stopReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1 },
            model: 'scripted',
            provider: 'x',
            latencyMs: 1,
          },
        }
      },
    } as never,
  }
}

function orchestrator(cwd: string, env: NodeJS.ProcessEnv, texts: string[] = ['ok']) {
  const { client, requests } = scriptedClient(texts)
  const agent = new Orchestrator({
    config: { ...defaultConfig(), advisor: { enabled: false } },
    client,
    cwd,
    sessionId: `test-${Date.now()}`,
    policy: loadPolicy({ cwd, env }),
  })
  return { agent, requests }
}

describe('the orchestrator', () => {
  test('@path attaches the file and counts it as read', async () => {
    const cwd = project({ 'src/auth.ts': 'export const token = 1\n' })
    const { agent, requests } = orchestrator(cwd, isolatedEnv())
    await agent.send('Look at @src/auth.ts please, and email me at a@b.com')
    const sent = JSON.stringify(requests[0]!.messages)
    expect(sent).toContain('export const token = 1')
    expect(sent).not.toContain('b.com">')
    agent.end('test')
  })

  test('custom agents join the spawn roster', () => {
    const cwd = project({
      '.jean/agents/db-expert.md':
        '---\nname: db-expert\ndescription: Knows the schema.\ntools: Read, Grep\n---\nYou know the database.',
    })
    const { agent } = orchestrator(cwd, isolatedEnv())
    expect(agent.agents().map((a) => a.name)).toContain('db-expert')
    expect(agent.registry.get('spawn')!.description).toContain('db-expert')
    agent.end('test')
  })

  test('expandSlash turns a custom command into its prompt', async () => {
    const cwd = project({ '.jean/commands/greet.md': 'Say hello to $1.' })
    const { agent } = orchestrator(cwd, isolatedEnv())
    const expanded = await agent.expandSlash('/greet Ada')
    expect(expanded?.prompt).toBe('Say hello to Ada.')
    expect(await agent.expandSlash('/not-a-command')).toBeUndefined()
    agent.end('test')
  })

  test('a UserPromptSubmit hook can block a prompt before the model sees it', async () => {
    const env = isolatedEnv()
    mkdirSync(join(env.HOME!, '.claude'), { recursive: true })
    writeFileSync(
      join(env.HOME!, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'echo "no secrets in prompts" >&2; exit 2' }] },
          ],
        },
      }),
    )
    const cwd = project()
    const { agent, requests } = orchestrator(cwd, env)
    const result = await agent.send('my password is hunter2')
    expect(result.stopReason).toBe('blocked')
    expect(result.error).toBe('no secrets in prompts')
    expect(requests).toHaveLength(0)
    agent.end('test')
  })

  test('the system prompt stays the same across prompts, so it caches', async () => {
    const cwd = project()
    const { agent, requests } = orchestrator(cwd, isolatedEnv(), ['one', 'two'])
    await agent.send('first question about apples')
    await agent.send('second question about oranges')
    expect(requests[0]!.system).toBe(requests[1]!.system)
    agent.end('test')
  })
})

// ---------------------------------------------------------------------------
// Goals and rewind.

type Scripted = { text?: string; calls?: { id: string; name: string; input: unknown }[] }

function toolClient(turns: Scripted[]) {
  let i = 0
  return {
    resolve: () => ({
      role: 'default',
      provider: 'x',
      modelId: 'scripted',
      maxTokens: 4096,
      fallbacks: [],
    }),
    isConfigured: () => true,
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      const turn = turns[i++] ?? { text: 'done' }
      const content = [
        ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
        ...(turn.calls ?? []).map((c) => ({ type: 'tool_call' as const, ...c })),
      ]
      yield {
        type: 'done',
        response: {
          content,
          stopReason: turn.calls?.length ? 'tool_use' : 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'scripted',
          provider: 'x',
          latencyMs: 1,
        },
      }
    },
  } as never
}

describe('goals', () => {
  test('the agent is not allowed to stop until the verify command passes', async () => {
    const cwd = project({ 'flag.txt': 'broken\n' })
    const check = `bun -e "process.exit(require('fs').readFileSync('flag.txt','utf8').trim()==='fixed'?0:1)"`
    const agent = new Orchestrator({
      config: { ...defaultConfig(), advisor: { enabled: false } },
      client: toolClient([
        { text: 'I think it is done.' },
        { calls: [{ id: 'r', name: 'read', input: { path: 'flag.txt' } }] },
        { calls: [{ id: 'w', name: 'write', input: { path: 'flag.txt', content: 'fixed\n' } }] },
        { text: 'Now it really is done.' },
      ]),
      cwd,
      sessionId: `goal-${Date.now()}`,
      policy: loadPolicy({ cwd, env: isolatedEnv() }),
      verify: check,
    })
    const result = await agent.send('fix the flag')
    expect(result.stopReason).toBe('complete')
    expect(result.text).toBe('Now it really is done.')
    expect(readFileSync(join(cwd, 'flag.txt'), 'utf8')).toBe('fixed\n')
    const pushes = agent.store.ofType('reminder').filter((r) => r.source === 'stop-hook')
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.text).toContain('does not pass yet')
    agent.end('test')
  }, 60_000)
})

describe('rewind', () => {
  test('undoes a turn’s edits and the conversation since', async () => {
    const cwd = project({ 'keep.txt': 'original\n' })
    const agent = new Orchestrator({
      config: { ...defaultConfig(), advisor: { enabled: false } },
      client: toolClient([
        // First prompt: create a file.
        { calls: [{ id: 'w1', name: 'write', input: { path: 'new.txt', content: 'created\n' } }] },
        { text: 'created it' },
        // Second prompt: change an existing file.
        { calls: [{ id: 'r2', name: 'read', input: { path: 'keep.txt' } }] },
        {
          calls: [
            {
              id: 'e2',
              name: 'edit',
              input: { path: 'keep.txt', old_string: 'original', new_string: 'changed' },
            },
          ],
        },
        { text: 'changed it' },
      ]),
      cwd,
      sessionId: `rewind-${Date.now()}`,
      policy: loadPolicy({ cwd, env: isolatedEnv() }),
    })

    await agent.send('create new.txt')
    const afterFirst = agent.store.length
    await agent.send('change keep.txt')
    expect(readFileSync(join(cwd, 'keep.txt'), 'utf8')).toBe('changed\n')

    const undone = agent.rewind(1)!
    expect(undone.prompt).toBe('change keep.txt')
    expect(readFileSync(join(cwd, 'keep.txt'), 'utf8')).toBe('original\n')
    expect(existsSync(join(cwd, 'new.txt'))).toBe(true)
    expect(agent.store.length).toBe(afterFirst)

    agent.rewind(1)
    expect(existsSync(join(cwd, 'new.txt'))).toBe(false)
    expect(agent.rewind(1)).toBeUndefined()
    agent.end('test')
  })
})
