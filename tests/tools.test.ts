import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type JeanConfig,
  type PermissionMode,
  defaultConfig,
} from '../packages/config/src/index.ts'
import {
  type ConfirmRequest,
  IgnoreSet,
  OutputBuffer,
  Registry,
  type Tool,
  type ToolContext,
  builtinTools,
  classifyCommand,
  clipOutput,
  createSessionState,
  globToRegExp,
  isSecretFile,
  isSpilledOutput,
  outputSpillDir,
  todoTool,
  validateArgs,
  walk,
} from '../packages/tools/src/index.ts'

const temps: string[] = []

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'jean-tools-'))
  temps.push(dir)
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}

function context(
  cwd: string,
  overrides: Partial<JeanConfig> = {},
  confirm?: (r: ConfirmRequest) => Promise<boolean>,
): ToolContext {
  return {
    cwd,
    config: { ...defaultConfig(), ...overrides },
    session: createSessionState(cwd),
    confirm,
  }
}

function registry(): Registry {
  const r = new Registry()
  r.registerAll(builtinTools())
  return r
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows holds a directory open while a process has it as its cwd. A
      // leftover temp directory is not worth failing a passing test over.
    }
  }
})

describe('glob patterns', () => {
  test('* stops at a path separator, ** crosses it', () => {
    expect(globToRegExp('*.ts').test('index.ts')).toBe(true)
    expect(globToRegExp('*.ts').test('src/index.ts')).toBe(false)
    expect(globToRegExp('**/*.ts').test('a/b/c.ts')).toBe(true)
    expect(globToRegExp('**/*.ts').test('c.ts')).toBe(true)
  })

  test('character classes and single-character wildcards', () => {
    expect(globToRegExp('[abc].ts').test('b.ts')).toBe(true)
    expect(globToRegExp('[abc].ts').test('d.ts')).toBe(false)
    expect(globToRegExp('[!a-z].ts').test('Q.ts')).toBe(true)
    expect(globToRegExp('?.ts').test('a.ts')).toBe(true)
    expect(globToRegExp('?.ts').test('ab.ts')).toBe(false)
  })
})

describe('gitignore semantics', () => {
  test('an unanchored pattern matches at any depth', () => {
    const set = new IgnoreSet()
    set.addFile('node_modules\n*.log\n')
    expect(set.isIgnored('node_modules', true)).toBe(true)
    expect(set.isIgnored('packages/cli/node_modules', true)).toBe(true)
    expect(set.isIgnored('debug.log', false)).toBe(true)
    expect(set.isIgnored('src/index.ts', false)).toBe(false)
  })

  test('a leading slash anchors and a trailing slash means directories only', () => {
    const set = new IgnoreSet()
    set.addFile('/dist\nbuild/\n')
    expect(set.isIgnored('dist', true)).toBe(true)
    expect(set.isIgnored('dist/app.js', false)).toBe(true)
    expect(set.isIgnored('packages/dist', true)).toBe(false)
    expect(set.isIgnored('build', false)).toBe(false)
  })

  test('a later negation re-includes', () => {
    const set = new IgnoreSet()
    set.addFile('*.log\n!keep.log\n')
    expect(set.isIgnored('debug.log', false)).toBe(true)
    expect(set.isIgnored('keep.log', false)).toBe(false)
  })
})

describe('the walker', () => {
  test('skips ignored directories', async () => {
    const dir = workspace({
      'src/index.ts': 'export const a = 1\n',
      'src/deep/nested.ts': 'export const b = 2\n',
      'node_modules/pkg/index.js': 'module.exports = {}\n',
      'build/out.js': '//built\n',
      '.gitignore': 'build/\n',
    })

    const found: string[] = []
    for await (const entry of walk(dir)) if (!entry.isDir) found.push(entry.relPath)

    expect(found).toContain('src/index.ts')
    expect(found).toContain('src/deep/nested.ts')
    expect(found.some((f) => f.startsWith('node_modules'))).toBe(false)
    expect(found.some((f) => f.startsWith('build'))).toBe(false)
  })
})

describe('argument validation', () => {
  const tool: Tool = {
    name: 'sample',
    description: 'x',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        count: { type: 'integer' },
        mode: { type: 'string', enum: ['a', 'b'] },
      },
      required: ['path'],
    },
    execute: async () => ({ output: 'ok' }),
  }

  test('accepts valid arguments', () => {
    expect(validateArgs(tool, { path: 'x', count: 1, mode: 'a' })).toBeUndefined()
  })

  test('names a missing required argument', () => {
    expect(validateArgs(tool, {})).toContain('path')
  })

  test('names a wrong type', () => {
    expect(validateArgs(tool, { path: 1 })).toContain('must be a string')
  })

  test('names an invalid enum value', () => {
    expect(validateArgs(tool, { path: 'x', mode: 'z' })).toContain('must be one of')
  })

  test('reports arguments that failed to parse as JSON', () => {
    expect(validateArgs(tool, { _raw: '{', _parseError: 'bad' })).toContain('valid JSON')
  })
})

describe('the registry', () => {
  test('rejects a tool name providers would refuse', () => {
    const r = new Registry()
    expect(() => r.register({ ...builtinTools()[0]!, name: 'Bad-Name' })).toThrow(
      /lower_snake_case/,
    )
  })

  test('an unknown tool returns an error result rather than throwing', async () => {
    const dir = workspace()
    const result = await registry().call('nope', {}, context(dir))
    expect(result.isError).toBe(true)
    expect(result.output).toContain('No tool named')
  })

  test('a throwing tool becomes an error result the agent can read', async () => {
    const r = new Registry()
    r.register({
      name: 'boom',
      description: 'x',
      risk: 'read',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        throw new Error('it exploded')
      },
    })
    const result = await r.call('boom', {}, context(workspace()))
    expect(result.isError).toBe(true)
    expect(result.output).toContain('it exploded')
  })

  test('records every call', async () => {
    const calls: string[] = []
    const r = new Registry({ onCall: (record) => calls.push(record.tool) })
    r.registerAll(builtinTools())
    await r.call('glob', { pattern: '*' }, context(workspace()))
    expect(calls).toEqual(['glob'])
  })
})

describe('permission gating', () => {
  const modes: [PermissionMode, boolean][] = [
    ['auto', true],
    ['full', true],
    ['plan', false],
  ]

  for (const [mode, allowed] of modes) {
    test(`${mode} mode ${allowed ? 'allows' : 'blocks'} writes`, async () => {
      const dir = workspace()
      const result = await registry().call(
        'write',
        { path: 'new.txt', content: 'hello' },
        context(dir, { permissionMode: mode }),
      )
      expect(result.isError ?? false).toBe(!allowed)
    })
  }

  test('plan mode hides every mutating tool from the model', () => {
    const names = registry()
      .schemas('plan')
      .map((s) => s.name)
    expect(names).toContain('read')
    expect(names).toContain('grep')
    expect(names).not.toContain('write')
    expect(names).not.toContain('bash')
  })

  test('ask mode confirms and honours a decline', async () => {
    const dir = workspace()
    const asked: ConfirmRequest[] = []
    const result = await registry().call(
      'write',
      { path: 'new.txt', content: 'x' },
      context(dir, { permissionMode: 'ask' }, async (request) => {
        asked.push(request)
        return false
      }),
    )
    expect(asked).toHaveLength(1)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('declined')
  })

  test('ask mode refuses rather than assuming yes when nobody can answer', async () => {
    const dir = workspace()
    const result = await registry().call(
      'write',
      { path: 'new.txt', content: 'x' },
      context(dir, { permissionMode: 'ask' }),
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('non-interactive')
  })
})

describe('destructive command classification', () => {
  test('refuses the deny list outright', () => {
    const ctx = context(workspace())
    expect(classifyCommand('rm -rf /', ctx).verdict).toBe('deny')
    expect(classifyCommand('sudo rm -rf / --no-preserve-root', ctx).verdict).toBe('deny')
  })

  test('gates the confirm list', () => {
    const ctx = context(workspace())
    expect(classifyCommand('rm -rf build', ctx).verdict).toBe('confirm')
    expect(classifyCommand('git reset --hard HEAD~1', ctx).verdict).toBe('confirm')
    expect(classifyCommand('git push --force origin main', ctx).verdict).toBe('confirm')
  })

  test('allows ordinary commands', () => {
    const ctx = context(workspace())
    expect(classifyCommand('bun test', ctx).verdict).toBe('allow')
    expect(classifyCommand('git status', ctx).verdict).toBe('allow')
    expect(classifyCommand('ls -la', ctx).verdict).toBe('allow')
  })

  test('normalizes whitespace before matching', () => {
    const ctx = context(workspace())
    expect(classifyCommand('rm    -rf     /', ctx).verdict).toBe('deny')
  })
})

describe('file tools', () => {
  test('read returns an anchor gutter', async () => {
    const dir = workspace({ 'a.ts': 'const a = 1\nconst b = 2\n' })
    const result = await registry().call('read', { path: 'a.ts' }, context(dir))
    expect(result.output).toContain('h:')
    expect(result.output).toContain('const a = 1')
  })

  test('read returns raw text when asked', async () => {
    const dir = workspace({ 'a.ts': 'const a = 1\n' })
    const result = await registry().call('read', { path: 'a.ts', raw: true }, context(dir))
    expect(result.output).not.toContain('h:')
  })

  test('read lists a directory', async () => {
    const dir = workspace({ 'src/a.ts': '', 'src/b.ts': '' })
    const result = await registry().call('read', { path: 'src' }, context(dir))
    expect(result.output).toContain('a.ts')
    expect(result.output).toContain('b.ts')
  })

  test('read refuses to escape the workspace', async () => {
    const dir = workspace()
    const result = await registry().call('read', { path: '../../../etc/passwd' }, context(dir))
    expect(result.isError).toBe(true)
    expect(result.output).toContain('outside the project root')
  })

  test('write creates a file and its parent directories', async () => {
    const dir = workspace()
    const result = await registry().call(
      'write',
      { path: 'deep/nested/new.ts', content: 'export const x = 1\n' },
      context(dir),
    )
    expect(result.isError).toBeFalsy()
    expect(readFileSync(join(dir, 'deep/nested/new.ts'), 'utf8')).toBe('export const x = 1\n')
  })

  test('write refuses to clobber a file that was never read', async () => {
    const dir = workspace({ 'a.ts': 'important content\n' })
    const result = await registry().call('write', { path: 'a.ts', content: 'x' }, context(dir))
    expect(result.isError).toBe(true)
    expect(result.output).toContain('has not been read')
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('important content\n')
  })

  test('edit requires the file to have been read first', async () => {
    const dir = workspace({ 'a.ts': 'const a = 1\n' })
    const result = await registry().call(
      'edit',
      { path: 'a.ts', patch: 'anchor: h:abcdef12\npatch: |-|\n- const a = 1\n+ const a = 2' },
      context(dir),
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('has not been read')
  })

  test('read then edit applies the patch', async () => {
    const dir = workspace({ 'a.ts': 'const a = 1\nconst b = 2\n' })
    const ctx = context(dir)
    const r = registry()

    const read = await r.call('read', { path: 'a.ts' }, ctx)
    const anchor = /h:([0-9a-f]{8})/.exec(
      read.output.split('\n').find((l) => l.includes('const a = 1'))!,
    )![1]

    const edit = await r.call(
      'edit',
      { path: 'a.ts', patch: `anchor: h:${anchor}\npatch: |-|\n- const a = 1\n+ const a = 42` },
      ctx,
    )
    expect(edit.isError).toBeFalsy()
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('const a = 42\nconst b = 2\n')
    expect(edit.touched).toHaveLength(1)
  })

  test('a failed edit explains how to recover', async () => {
    const dir = workspace({ 'a.ts': 'const a = 1\n' })
    const ctx = context(dir)
    const r = registry()
    await r.call('read', { path: 'a.ts' }, ctx)

    const result = await r.call(
      'edit',
      { path: 'a.ts', patch: 'anchor: h:ffffffff\npatch: |-|\n- nothing\n+ something' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Re-read the file')
  })
})

describe('search tools', () => {
  test('grep finds matches with paths and line numbers', async () => {
    const dir = workspace({
      'src/a.ts': 'export const rateLimiter = 1\nconst other = 2\n',
      'src/b.md': 'RateLimiter docs\n',
    })
    const result = await registry().call('grep', { pattern: 'rateLimiter' }, context(dir))
    expect(result.output).toContain('src/a.ts:1')
    expect(result.output).toContain('src/b.md:1')
  })

  test('grep honours an include glob', async () => {
    const dir = workspace({
      'src/a.ts': 'match here\n',
      'src/b.md': 'match here\n',
    })
    const result = await registry().call(
      'grep',
      { pattern: 'match', include: '**/*.ts' },
      context(dir),
    )
    expect(result.output).toContain('src/a.ts')
    expect(result.output).not.toContain('src/b.md')
  })

  test('grep reports an invalid regex usefully', async () => {
    const result = await registry().call('grep', { pattern: '([' }, context(workspace()))
    expect(result.isError).toBe(true)
    expect(result.output).toContain('not a valid regular expression')
  })

  test('glob returns matching paths, sorted', async () => {
    const dir = workspace({ 'src/b.ts': '', 'src/a.ts': '', 'src/c.md': '' })
    const result = await registry().call('glob', { pattern: '**/*.ts' }, context(dir))
    const lines = result.output.split('\n').filter((l) => l.endsWith('.ts'))
    expect(lines).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('the shell tool', () => {
  test('runs a command and returns its output', async () => {
    const dir = workspace()
    const result = await registry().call('bash', { command: 'echo hello-from-jean' }, context(dir))
    expect(result.output).toContain('hello-from-jean')
    expect(result.isError).toBeFalsy()
  })

  test('reports a non-zero exit code', async () => {
    const dir = workspace()
    const result = await registry().call('bash', { command: 'exit 3' }, context(dir))
    expect(result.isError).toBe(true)
    expect(result.output).toContain('exit code 3')
  })

  test('the working directory persists across calls', async () => {
    const dir = workspace({ 'sub/marker.txt': 'here\n' })
    const ctx = context(dir)
    const r = registry()

    await r.call('bash', { command: 'cd sub' }, ctx)
    const result = await r.call('bash', { command: 'ls' }, ctx)
    expect(result.output).toContain('marker.txt')
  })

  test('a deny-listed command never runs', async () => {
    const dir = workspace()
    const result = await registry().call('bash', { command: 'rm -rf /' }, context(dir))
    expect(result.isError).toBe(true)
    expect(result.output).toContain('deny list')
  })
})

describe('credential files', () => {
  test('read refuses a .env, naming why', async () => {
    const dir = workspace({ '.env': 'OPENROUTER_API_KEY=sk-or-v1-realsecretvalue' })
    const result = await registry().call('read', { path: '.env' }, context(dir))

    expect(result.isError).toBe(true)
    expect(result.output).toContain('credentials')
    // The whole point: the value must not reach the transcript.
    expect(result.output).not.toContain('realsecretvalue')
  })

  test('grep never surfaces a line from a credential file', async () => {
    const dir = workspace({
      '.env': 'API_KEY=sk-or-v1-realsecretvalue',
      'src/app.ts': 'const name = "API_KEY placeholder"',
    })
    const result = await registry().call('grep', { pattern: 'API_KEY' }, context(dir))
    expect(result.output).not.toContain('realsecretvalue')
    // The non-secret hit is still reported.
    expect(result.output).toContain('src/app.ts')
  })

  test('an .env.example is readable, since it holds names not values', async () => {
    const dir = workspace({ '.env.example': 'OPENROUTER_API_KEY=sk-or-v1-...' })
    const result = await registry().call('read', { path: '.env.example' }, context(dir))
    expect(result.isError ?? false).toBe(false)
    expect(result.output).toContain('OPENROUTER_API_KEY')
  })

  test('the shell asks before printing a credentials file', () => {
    const ctx = context(workspace())
    // Confirm, not deny: the shell can always be told to do this deliberately,
    // and the goal is to catch the accident, not to pretend this is a boundary.
    expect(classifyCommand('cat .env', ctx).verdict).toBe('confirm')
    expect(classifyCommand('grep KEY .env.local', ctx).verdict).toBe('confirm')
    expect(classifyCommand('cat deploy.pem', ctx).verdict).toBe('confirm')

    expect(classifyCommand('cat .env.example', ctx).verdict).toBe('allow')
    expect(classifyCommand('npm run build', ctx).verdict).toBe('allow')
    expect(classifyCommand('cat README.md', ctx).verdict).toBe('allow')
  })

  test('classifies by filename', () => {
    for (const secret of ['.env', '.env.local', 'id_rsa', 'server.pem', '.netrc']) {
      expect(isSecretFile(`/project/${secret}`)).toBe(true)
    }
    for (const safe of ['.env.example', 'index.ts', 'README.md', 'keyboard.ts']) {
      expect(isSecretFile(`/project/${safe}`)).toBe(false)
    }
  })
})

describe('interactive jobs', () => {
  test('answers a prompt a running job is waiting on', async () => {
    const ctx = context(workspace())
    const r = registry()

    await r.call(
      'bash',
      { command: 'read -p "Continue? " answer; echo "you said: $answer"', background: true },
      ctx,
    )
    await new Promise((resolve) => setTimeout(resolve, 500))

    // Without this the agent can see the prompt and has no way to answer it,
    // so the only remaining move is killing the job.
    const result = await r.call('bash_input', { job: 'job_1', input: 'yes' }, ctx)
    expect(result.isError ?? false).toBe(false)
    expect(result.output).toContain('you said: yes')
  })

  test('reports an unknown job', async () => {
    const result = await registry().call(
      'bash_input',
      { job: 'job_99', input: 'x' },
      context(workspace()),
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('No job')
  })

  test('reports a job that already exited', async () => {
    const ctx = context(workspace())
    const r = registry()

    await r.call('bash', { command: 'echo done', background: true }, ctx)
    // Waits for the exit itself: a fixed delay loses to a slow shell start
    // when the whole suite is running.
    const deadline = Date.now() + 10_000
    while (!ctx.session.jobs.get('job_1')?.done && Date.now() < deadline) await Bun.sleep(25)

    const result = await r.call('bash_input', { job: 'job_1', input: 'x' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('already exited')
  })

  test('refuses to send something that looks like a credential', async () => {
    const ctx = context(workspace())
    const r = registry()

    await r.call('bash', { command: 'read -p "Token: " t; echo got', background: true }, ctx)
    await new Promise((resolve) => setTimeout(resolve, 400))

    // Anything sent here lands in the transcript, and from there in every later
    // request to the model.
    const result = await r.call(
      'bash_input',
      { job: 'job_1', input: `sk-ant-api03-${'a'.repeat(40)}` },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('credential')

    // The job is still blocked on stdin; leaving it running holds the temp
    // directory open.
    await r.call('bash_output', { job: 'job_1', kill: true }, ctx)
  })

  test('allows an ordinary short answer', async () => {
    const ctx = context(workspace())
    const r = registry()

    await r.call('bash', { command: 'read -p "Name? " n; echo "hi $n"', background: true }, ctx)
    await new Promise((resolve) => setTimeout(resolve, 400))

    // A prompt usually wants `y`, a name, or a number; the credential check
    // must not get in the way of those.
    const result = await r.call('bash_input', { job: 'job_1', input: 'alice' }, ctx)
    expect(result.output).toContain('hi alice')
  })
})

describe('the todo tool', () => {
  test('accepts the object-shaped item lists models actually send', async () => {
    // Models trained on other agents' task tools reach for the object form.
    // Reading the text field beats writing "[object Object]" into the plan.
    const ctx = context(workspace())
    const result = await registry().call(
      'todo',
      {
        action: 'set',
        items: [
          { content: 'read the config', status: 'pending' },
          { task: 'add the flag' },
          { title: 'run the tests' },
        ],
      },
      ctx,
    )

    expect(result.output).not.toContain('[object Object]')
    expect(result.output).toContain('read the config')
    expect(result.output).toContain('add the flag')
    expect(result.output).toContain('run the tests')
  })

  test('reads the `item` key and text nested in an array', async () => {
    // Both shapes captured from a live MiniMax run: `{id, item}` objects, and a
    // malformed call where the text ended up inside a nested array.
    const result = await registry().call(
      'todo',
      {
        action: 'set',
        items: [
          { id: '1', item: 'inspect the directory' },
          { id: '2', item: ['decide the sections'] },
        ],
      },
      context(workspace()),
    )
    expect(result.isError ?? false).toBe(false)
    expect(result.output).toContain('inspect the directory')
    expect(result.output).toContain('decide the sections')
  })

  test('reports unreadable items rather than storing placeholder text', async () => {
    const result = await registry().call(
      'todo',
      { action: 'set', items: [{ nope: 1 }, 42] },
      context(workspace()),
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('no readable step text')
  })

  test('declares its item type, so models do not guess the shape', () => {
    const items = todoTool.parameters.properties.items as { items?: { type?: string } }
    expect(items.items?.type).toBe('string')
  })

  test('tracks a plan through its lifecycle', async () => {
    const dir = workspace()
    const ctx = context(dir)
    const r = registry()

    await r.call('todo', { action: 'set', items: ['first', 'second'] }, ctx)
    await r.call('todo', { action: 'start', id: '1' }, ctx)
    const result = await r.call('todo', { action: 'complete', id: '1' }, ctx)

    expect(result.output).toContain('[x] 1. first')
    expect(result.output).toContain('[ ] 2. second')
    expect(result.output).toContain('1 of 2 remaining')
  })

  test('names the valid ids when given a bad one', async () => {
    const ctx = context(workspace())
    const r = registry()
    await r.call('todo', { action: 'set', items: ['only'] }, ctx)
    const result = await r.call('todo', { action: 'complete', id: '99' }, ctx)
    expect(result.output).toContain('Current ids: 1')
  })
})

describe('command output clipping', () => {
  const lines = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}`).join('\n')

  test('short output passes through untouched', () => {
    expect(clipOutput('ok\n', false)).toBe('ok\n')
  })

  test('long output keeps both the start and the verdict at the end', () => {
    const output = `${lines(4000, 'build')}\nFAILED: 3 tests failed`
    const clipped = clipOutput(output, false)
    expect(clipped.length).toBeLessThan(output.length)
    expect(clipped).toContain('build line 1\n')
    expect(clipped).toContain('FAILED: 3 tests failed')
    expect(clipped).toContain('characters omitted')
  })

  test('the full output is saved where read can open it', async () => {
    const output = `${lines(4000, 'log')}\nthe needle`
    const clipped = clipOutput(output)
    const path = /saved to (\S+)/.exec(clipped)?.[1]
    expect(path).toBeDefined()
    expect(isSpilledOutput(path!)).toBe(true)

    const dir = workspace()
    const read = await registry().call('read', { path: path!, offset: 4000 }, context(dir))
    expect(read.isError).toBeFalsy()
    expect(read.output).toContain('the needle')
    rmSync(path!, { force: true })
  })

  test('read still refuses other paths outside the project', () => {
    expect(isSpilledOutput(join(outputSpillDir(), '..', 'secrets.txt'))).toBe(false)
    expect(isSpilledOutput(outputSpillDir())).toBe(false)
  })

  test('the collector keeps head and tail of a runaway process', () => {
    const buffer = new OutputBuffer(100, 20)
    buffer.push('HEAD-')
    for (let i = 0; i < 50; i++) buffer.push('middle-')
    buffer.push('-TAIL')
    const text = buffer.text()
    expect(text.startsWith('HEAD-')).toBe(true)
    expect(text.endsWith('-TAIL')).toBe(true)
    expect(text).toContain('characters dropped')
  })
})
