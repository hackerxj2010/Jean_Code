import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { defaultConfig } from '../packages/config/src/index.ts'
import { parseAdvice } from '../packages/advisor/src/index.ts'
import { DockerBackend, LocalBackend, createBackend } from '../packages/execution/src/index.ts'
import { groupForCommits, isRepository, status } from '../packages/git/src/index.ts'
import { discoverPlugins, readManifest } from '../packages/plugins/src/index.ts'
import { describeSchedule, nextRun, parseCron } from '../packages/scheduler/src/index.ts'
import {
  discoverSkills,
  matchSkills,
  parseFrontMatter,
  renderSkills,
} from '../packages/skills/src/index.ts'
import { extractJson, validateResult } from '../packages/subagents/src/index.ts'
import { FileLock, Mailbox, TaskList } from '../packages/teams/src/index.ts'

const temps: string[] = []

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jean-pkg-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true })
})

describe('@jean/skills', () => {
  test('parses front matter with scalars and both list forms', () => {
    const { data, body } = parseFrontMatter(
      [
        '---',
        'name: my-skill',
        'description: "Does a thing"',
        'triggers: [alpha, beta]',
        'tags:',
        '  - one',
        '  - two',
        '---',
        '',
        '# Instructions',
      ].join('\n'),
    )
    expect(data.name).toBe('my-skill')
    expect(data.description).toBe('Does a thing')
    expect(data.triggers).toEqual(['alpha', 'beta'])
    expect(data.tags).toEqual(['one', 'two'])
    expect(body.trim()).toBe('# Instructions')
  })

  test('returns the whole file when there is no front matter', () => {
    const { data, body } = parseFrontMatter('just markdown')
    expect(data).toEqual({})
    expect(body).toBe('just markdown')
  })

  test('discovers project skills', () => {
    const dir = workspace()
    mkdirSync(join(dir, '.jean', 'skills', 'deploy'), { recursive: true })
    writeFileSync(
      join(dir, '.jean', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: How to deploy this service to production\ntriggers: [deploy, release]\n---\n\nRun the deploy script.\n',
    )

    const skills = discoverSkills(dir)
    const deploy = skills.find((s) => s.name === 'deploy')
    expect(deploy).toBeDefined()
    expect(deploy!.source).toBe('project')
    expect(deploy!.body).toContain('Run the deploy script.')
  })

  test('skips a skill with no description, since it can never match', () => {
    const dir = workspace()
    mkdirSync(join(dir, '.jean', 'skills', 'broken'), { recursive: true })
    writeFileSync(join(dir, '.jean', 'skills', 'broken', 'SKILL.md'), '---\nname: broken\n---\nbody')
    expect(discoverSkills(dir).find((s) => s.name === 'broken')).toBeUndefined()
  })

  test('matches on triggers and ignores unrelated prompts', () => {
    const skills = [
      {
        name: 'deploy',
        description: 'How to deploy this service to production',
        triggers: ['deploy', 'release'],
        body: 'steps',
        path: 'x',
        source: 'project' as const,
      },
      {
        name: 'testing',
        description: 'How to write tests in this repository',
        triggers: ['test'],
        body: 'steps',
        path: 'y',
        source: 'project' as const,
      },
    ]
    expect(matchSkills(skills, 'deploy the new version').map((s) => s.name)).toEqual(['deploy'])
    // An unrelated prompt should pull in nothing: a wrong skill is worse than none.
    expect(matchSkills(skills, 'what colour is the sky')).toHaveLength(0)
  })

  test('renders matched skills as a prompt section', () => {
    const rendered = renderSkills([
      {
        name: 'deploy',
        description: 'd',
        triggers: [],
        body: 'Run it.',
        path: 'x',
        source: 'user',
      },
    ])
    expect(rendered).toContain('### deploy')
    expect(rendered).toContain('Run it.')
    expect(renderSkills([])).toBeUndefined()
  })
})

describe('@jean/advisor', () => {
  test('treats OK as silence', () => {
    expect(parseAdvice('OK')).toBeUndefined()
    expect(parseAdvice('ok, nothing to add')).toBeUndefined()
    expect(parseAdvice('')).toBeUndefined()
  })

  test('parses each level', () => {
    expect(parseAdvice('BLOCKER: it is about to delete the database')).toEqual({
      level: 'blocker',
      text: 'it is about to delete the database',
    })
    expect(parseAdvice('CONCERN: the test was never run')?.level).toBe('concern')
    expect(parseAdvice('NOTE: there is a helper for this already')?.level).toBe('note')
  })

  test('ignores unstructured or empty advice', () => {
    expect(parseAdvice('I think things are going well')).toBeUndefined()
    expect(parseAdvice('CONCERN: hmm')).toBeUndefined()
  })
})

describe('@jean/execution', () => {
  test('local runs a command and collects output', async () => {
    const backend = new LocalBackend()
    const result = await backend.exec('echo execution-layer-works', { cwd: process.cwd() })
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('execution-layer-works')
  })

  test('local reports a non-zero exit', async () => {
    const result = await new LocalBackend().exec('exit 7', { cwd: process.cwd() })
    expect(result.exitCode).toBe(7)
  })

  test('docker flags carry the hardening the config asks for', () => {
    const flags = new DockerBackend('node:20-slim', {
      readOnlyRoot: true,
      dropCapabilities: true,
      pidLimit: 100,
      network: false,
    }).flags('/project')

    expect(flags).toContain('--read-only')
    expect(flags).toContain('--cap-drop')
    // A read-only root without a writable temp breaks nearly every toolchain.
    expect(flags).toContain('--tmpfs')
    // Dropping capabilities is not enough on its own if setuid still works.
    expect(flags).toContain('--security-opt')
    expect(flags).toContain('no-new-privileges')
    expect(flags.join(' ')).toContain('--pids-limit 100')
    expect(flags.join(' ')).toContain('--network none')
    expect(flags.join(' ')).toContain('/project:/workspace')
  })

  test('an unimplemented backend reports itself instead of running locally', async () => {
    const backend = createBackend({ ...defaultConfig(), execution: { backend: 'ssh' } })
    const result = await backend.exec('echo should-not-run', { cwd: process.cwd() })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('not implemented')
    expect(result.output).not.toContain('should-not-run')
  })
})

describe('@jean/git', () => {
  function repository(): string {
    const dir = workspace()
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    return dir
  }

  test('detects a repository', async () => {
    expect(await isRepository(repository())).toBe(true)
    // Not `workspace()`: git walks upward, and a home directory that is itself
    // a repository would make every temp directory "inside a work tree".
    expect(await isRepository(join(workspace(), 'does-not-exist'))).toBe(false)
  })

  test('reports untracked and modified files', async () => {
    const dir = repository()
    writeFileSync(join(dir, 'a.txt'), 'hello\n')
    const untracked = await status(dir)
    expect(untracked).toHaveLength(1)
    expect(untracked[0]!.untracked).toBe(true)

    execFileSync('git', ['add', 'a.txt'], { cwd: dir })
    const staged = await status(dir)
    expect(staged[0]!.staged).toBe(true)
    expect(staged[0]!.untracked).toBe(false)
  })

  test('lists files inside a new directory, not just the directory', async () => {
    const dir = repository()
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
    mkdirSync(join(dir, 'src', 'nested'), { recursive: true })
    writeFileSync(join(dir, 'src', 'nested', 'a.ts'), 'export const a = 1')
    writeFileSync(join(dir, 'src', 'nested', 'b.ts'), 'export const b = 2')

    // Without `--untracked-files=all`, git collapses this into one `src/`
    // entry and every file inside it is invisible to the caller.
    const entries = await status(dir)
    const paths = entries.map((entry) => entry.path).sort()
    expect(paths).toContain('src/nested/a.ts')
    expect(paths).toContain('src/nested/b.ts')
  })

  test('groups changed files by package for atomic commits', () => {
    const groups = groupForCommits([
      'packages/cli/src/index.ts',
      'packages/cli/src/flags.ts',
      'packages/core/src/loop.ts',
      'crates/hashline/src/lib.rs',
      'README.md',
    ])
    expect(groups.map((g) => g.scope)).toEqual([
      'README.md',
      'crates/hashline',
      'packages/cli',
      'packages/core',
    ])
    expect(groups.find((g) => g.scope === 'packages/cli')!.paths).toHaveLength(2)
  })
})

describe('@jean/teams', () => {
  test('a lock is exclusive and releases', async () => {
    const dir = workspace()
    const lock = new FileLock(join(dir, 'test.lock'))

    const release = await lock.acquire()
    // A second acquire must not succeed while the first is held.
    await expect(lock.acquire(150)).rejects.toThrow(/could not acquire/)
    release()
    // Once released, it is available again.
    const second = await lock.acquire()
    second()
  })

  test('a task is claimed exactly once, even under contention', async () => {
    const list = new TaskList(workspace())
    await list.add({ title: 'the only task' })

    const claims = await Promise.all([
      list.claim('alice'),
      list.claim('bob'),
      list.claim('carol'),
    ])
    const winners = claims.filter((c) => c !== undefined)
    expect(winners).toHaveLength(1)
  })

  test('a task is not claimable until its dependencies complete', async () => {
    const list = new TaskList(workspace())
    const first = await list.add({ title: 'first' })
    await list.add({ title: 'second', dependsOn: [first.id] })

    expect((await list.claim('alice'))!.title).toBe('first')
    expect(await list.claim('bob')).toBeUndefined()

    await list.complete(first.id, 'done')
    expect((await list.claim('bob'))!.title).toBe('second')
  })

  test('two teammates never get tasks touching the same file', async () => {
    const list = new TaskList(workspace())
    await list.add({ title: 'edit auth', files: ['src/auth.ts'] })
    await list.add({ title: 'also edit auth', files: ['src/auth.ts'] })
    await list.add({ title: 'edit db', files: ['src/db.ts'] })

    expect((await list.claim('alice'))!.title).toBe('edit auth')
    // The second auth task is skipped; the unrelated one is handed out instead.
    expect((await list.claim('bob'))!.title).toBe('edit db')
  })

  test('reports completion', async () => {
    const list = new TaskList(workspace())
    const task = await list.add({ title: 'only' })
    expect(list.isFinished()).toBe(false)
    await list.complete(task.id)
    expect(list.isFinished()).toBe(true)
  })

  test('a mailbox delivers each message once', async () => {
    const box = new Mailbox(workspace())
    await box.send('alice', 'bob', 'the API contract changed')
    await box.send('alice', '*', 'heads up everyone')

    const bob = await box.inbox('bob')
    expect(bob).toHaveLength(2) // the direct message and the broadcast
    // Already-read messages are not delivered again.
    expect(await box.inbox('bob')).toHaveLength(0)
  })
})

describe('@jean/subagents', () => {
  test('extracts JSON from fenced and unfenced text', () => {
    expect(extractJson('Here is the result:\n```json\n{"a": 1}\n```')).toBe('{"a": 1}')
    expect(extractJson('prose {"a": {"b": 2}} more prose')).toBe('{"a": {"b": 2}}')
    expect(extractJson('no object here')).toBeUndefined()
  })

  test('is not confused by braces inside strings', () => {
    expect(extractJson('{"a": "} not the end {"}')).toBe('{"a": "} not the end {"}')
  })

  test('validates a result against a schema', () => {
    const schema = {
      type: 'object' as const,
      properties: { files: { type: 'array' }, summary: { type: 'string' } },
      required: ['files', 'summary'],
    }

    const good = validateResult('{"files": ["a.ts"], "summary": "did it"}', schema)
    expect(good.valid).toBe(true)
    expect(good.value!.summary).toBe('did it')

    const missing = validateResult('{"files": []}', schema)
    expect(missing.valid).toBe(false)
    expect(missing.errors[0]).toContain('summary')

    const wrongType = validateResult('{"files": "not an array", "summary": "x"}', schema)
    expect(wrongType.valid).toBe(false)
    expect(wrongType.errors[0]).toContain('array')
  })

  test('reports unparseable results clearly', () => {
    const result = validateResult('I could not do it, sorry', {
      type: 'object',
      properties: {},
    })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('no JSON object')
  })
})

describe('@jean/scheduler', () => {
  test('parses the common cron forms', () => {
    expect(parseCron('0 9 * * *').hour).toEqual([9])
    expect(parseCron('*/15 * * * *').minute).toEqual([0, 15, 30, 45])
    expect(parseCron('0 9-11 * * *').hour).toEqual([9, 10, 11])
    expect(parseCron('0 0 * * 1,3,5').dayOfWeek).toEqual([1, 3, 5])
  })

  test('rejects malformed expressions with a useful message', () => {
    expect(() => parseCron('0 9 * *')).toThrow(/needs 5 fields/)
    expect(() => parseCron('0 99 * * *')).toThrow(/between 0 and 23/)
    expect(() => parseCron('0 9 * * abc')).toThrow(/not a valid/)
  })

  test('computes the next fire time', () => {
    // Wednesday 2026-08-26, 10:30 local.
    const from = new Date(2026, 7, 26, 10, 30, 0)
    const daily = nextRun('0 9 * * *', from)
    expect(daily.getHours()).toBe(9)
    expect(daily.getDate()).toBe(27) // 09:00 today already passed

    const hourly = nextRun('0 * * * *', from)
    expect(hourly.getHours()).toBe(11)
    expect(hourly.getMinutes()).toBe(0)
  })

  test('describes a schedule, including an invalid one', () => {
    const base = {
      id: '1',
      prompt: 'check the build',
      cwd: '/x',
      enabled: true,
      createdAt: 0,
    }
    expect(describeSchedule({ ...base, kind: 'cron', when: '0 9 * * *' }).valid).toBe(true)
    expect(describeSchedule({ ...base, kind: 'cron', when: 'nonsense' }).valid).toBe(false)
    expect(describeSchedule({ ...base, kind: 'once', when: '2030-01-01T00:00:00Z' }).detail).toContain(
      'runs at',
    )
  })
})

describe('@jean/plugins', () => {
  test('reads a valid manifest and rejects an invalid one', () => {
    const dir = workspace()
    writeFileSync(join(dir, 'good.json'), JSON.stringify({ name: 'x', version: '1.0.0' }))
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ description: 'no name' }))
    writeFileSync(join(dir, 'broken.json'), 'not json')

    expect(readManifest(join(dir, 'good.json'))!.name).toBe('x')
    expect(readManifest(join(dir, 'bad.json'))).toBeUndefined()
    expect(readManifest(join(dir, 'broken.json'))).toBeUndefined()
  })

  test('discovers project plugins', () => {
    const dir = workspace()
    mkdirSync(join(dir, '.jean', 'plugins', 'mine'), { recursive: true })
    writeFileSync(
      join(dir, '.jean', 'plugins', 'mine', 'jean-plugin.json'),
      JSON.stringify({ name: 'mine', version: '0.1.0' }),
    )

    const found = discoverPlugins(dir)
    expect(found.find((p) => p.manifest.name === 'mine')?.source).toBe('project')
  })
})
