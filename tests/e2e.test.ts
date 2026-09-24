import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { anchorOf } from '../packages/tools/src/hashline.ts'

/**
 * End-to-end: the real `jean` binary against a real HTTP model server.
 *
 * Everything below the test harness is the shipping code path — flag parsing,
 * config resolution, the OpenAI adapter, SSE reassembly, the agent loop, the
 * tool harness, permission gating, and session persistence. This is what
 * catches wiring mistakes that unit tests with mocked clients cannot see.
 *
 * The model server runs in its own process because the tests drive the CLI with
 * `spawnSync`, which blocks this process's event loop.
 */

const ROOT = join(import.meta.dir, '..')
const CLI = join(ROOT, 'packages', 'cli', 'src', 'index.ts')
const SERVER = join(import.meta.dir, 'fixtures', 'mock-model-server.mjs')

let server: ChildProcess
let baseUrl = ''
const temps: string[] = []

beforeAll(async () => {
  server = spawn('bun', [SERVER], { stdio: ['ignore', 'pipe', 'inherit'] })

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock server did not start')), 15_000)
    server.stdout!.on('data', (chunk: Buffer) => {
      const match = /READY (\d+)/.exec(chunk.toString())
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    })
  })

  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(() => {
  server?.kill()
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true })
})

/** An assistant turn that returns plain text. */
function textTurn(content: string) {
  return { role: 'assistant', content }
}

/** An assistant turn that calls one tool. */
function toolTurn(name: string, args: unknown, id = 'call_1') {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  }
}

async function setScript(turns: unknown[]): Promise<void> {
  const response = await fetch(`${baseUrl}/__script`, {
    method: 'POST',
    body: JSON.stringify(turns),
  })
  if (!response.ok) throw new Error(`could not set script: ${response.status}`)
}

async function capturedRequests(): Promise<any[]> {
  const response = await fetch(`${baseUrl}/__requests`, { method: 'POST' })
  return (await response.json()) as any[]
}

/** A project directory wired to talk to the mock server. */
function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'jean-e2e-'))
  temps.push(dir)
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dir, path), content, 'utf8')
  }
  writeFileSync(
    join(dir, '.jean.json'),
    JSON.stringify({
      model: { provider: 'openrouter', modelId: 'mock-model' },
      providers: { openrouter: { baseUrl: `${baseUrl}/v1`, apiKey: 'test-key' } },
      permissionMode: 'auto',
      memory: { backend: 'none' },
      maxTurns: 8,
    }),
  )
  return dir
}

/** Runs the CLI as a subprocess, exactly as a user would. */
function jean(
  cwd: string,
  args: string[],
  stdin?: string,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('bun', [CLI, ...args], {
    cwd,
    input: stdin,
    encoding: 'utf8',
    env: {
      ...process.env,
      JEAN_HOME: join(cwd, '.jean-home'),
      NO_COLOR: '1',
      // No real provider key may leak into a test run.
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      OPENROUTER_API_KEY: '',
      GOOGLE_API_KEY: '',
    },
    timeout: 45_000,
  })
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('the jean binary', () => {
  test('prints its version', () => {
    const result = jean(project(), ['--version'])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('jean 0.1.0')
  }, 30_000)

  test('prints help listing every command', () => {
    const { stdout } = jean(project(), ['--help'])
    for (const command of ['autonomous', 'swarm', 'doctor', 'sessions', 'completions']) {
      expect(stdout).toContain(command)
    }
  }, 30_000)

  // Three subprocess spawns, each over a second: the default 5s budget is not
  // enough on a loaded machine, and the failure looked like a broken feature
  // rather than a slow one.
  test('generates completion scripts for every supported shell', () => {
    const dir = project()
    expect(jean(dir, ['completions', 'bash']).stdout).toContain('complete -F _jean_complete jean')
    expect(jean(dir, ['completions', 'zsh']).stdout).toContain('#compdef jean')
    expect(jean(dir, ['completions', 'fish']).stdout).toContain('complete -c jean')
  }, 30_000)

  test('rejects an unknown shell', () => {
    expect(jean(project(), ['completions', 'nushell']).code).toBe(2)
  }, 30_000)

  test('reads and writes config', () => {
    const dir = project()
    expect(jean(dir, ['config', 'set', 'effort', 'high']).code).toBe(0)
    expect(jean(dir, ['config', 'get', 'effort']).stdout.trim()).toBe('high')
  }, 30_000)

  test('lists models and providers', () => {
    const { stdout, code } = jean(project(), ['models'])
    expect(code).toBe(0)
    expect(stdout).toContain('openrouter')
    expect(stdout).toContain('anthropic/claude-sonnet-4.5')
  }, 30_000)

  test('doctor reports a healthy configuration', () => {
    const { stdout } = jean(project(), ['doctor'])
    expect(stdout).toContain('Telemetry: off')
    expect(stdout).toContain('mock-model')
  }, 30_000)
})

describe('one-shot runs against a live model server', () => {
  test('answers a plain question', async () => {
    await setScript([textTurn('This project is a calculator.')])

    const dir = project({ 'README.md': '# Calculator\n' })
    const result = jean(dir, ['-p', 'what is this project?', '-f', 'json'])

    expect(result.code).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.ok).toBe(true)
    expect(output.text).toBe('This project is a calculator.')
    expect(output.turns).toBe(1)
    expect(output.usage.inputTokens).toBe(120)

    const requests = await capturedRequests()
    expect(requests[0].messages[0].role).toBe('system')
    const toolNames = requests[0].tools.map((t: any) => t.function.name)
    expect(toolNames).toContain('read')
    expect(toolNames).toContain('edit')
    expect(toolNames).toContain('bash')
  }, 30_000)

  test('reads a file through the tool harness and reports back', async () => {
    await setScript([toolTurn('read', { path: 'answer.txt' }), textTurn('The file contains: 42')])

    const dir = project({ 'answer.txt': '42\n' })
    const output = JSON.parse(jean(dir, ['-p', 'what is in answer.txt?', '-f', 'json']).stdout)

    expect(output.ok).toBe(true)
    expect(output.turns).toBe(2)
    expect(output.toolCalls).toBe(1)

    // The tool result must reach the model, paired to the call it answers.
    const requests = await capturedRequests()
    const toolMessage = requests[1].messages.find((m: any) => m.role === 'tool')
    expect(toolMessage.tool_call_id).toBe('call_1')
    expect(toolMessage.content).toContain('42')
  }, 30_000)

  test('writes a file the user asked for', async () => {
    await setScript([
      toolTurn('write', { path: 'created.ts', content: 'export const answer = 42\n' }),
      textTurn('Created created.ts.'),
    ])

    const dir = project()
    const output = JSON.parse(jean(dir, ['-p', 'create created.ts', '-f', 'json']).stdout)

    expect(output.ok).toBe(true)
    expect(output.files).toHaveLength(1)
    expect(readFileSync(join(dir, 'created.ts'), 'utf8')).toBe('export const answer = 42\n')
  }, 30_000)

  test('edits a file with a hashline patch anchored to a prior read', async () => {
    const dir = project({ 'target.ts': 'export const value = 1\nexport const other = 2\n' })
    const anchor = anchorOf('export const value = 1')

    // `edit` refuses a file that has not been read this session, so the script
    // reads first — the same sequence a real model follows.
    await setScript([
      toolTurn('read', { path: 'target.ts' }, 'call_r'),
      toolTurn(
        'edit',
        {
          path: 'target.ts',
          patch: `anchor: h:${anchor}\npatch: |-|\n- export const value = 1\n+ export const value = 99`,
        },
        'call_e',
      ),
      textTurn('Updated the value.'),
    ])

    const output = JSON.parse(jean(dir, ['-p', 'set value to 99', '-f', 'json']).stdout)

    expect(output.ok).toBe(true)
    expect(output.toolCalls).toBe(2)
    expect(readFileSync(join(dir, 'target.ts'), 'utf8')).toBe(
      'export const value = 99\nexport const other = 2\n',
    )
  }, 30_000)

  test('runs a shell command and sees its output', async () => {
    await setScript([
      toolTurn('bash', { command: 'echo e2e-shell-works' }),
      textTurn('The command printed e2e-shell-works.'),
    ])

    const output = JSON.parse(jean(project(), ['-p', 'run the echo', '-f', 'json']).stdout)
    expect(output.ok).toBe(true)

    const requests = await capturedRequests()
    const toolMessage = requests[1].messages.find((m: any) => m.role === 'tool')
    expect(toolMessage.content).toContain('e2e-shell-works')
  }, 30_000)

  test('recovers from a tool error instead of failing the run', async () => {
    await setScript([
      toolTurn('read', { path: 'missing.txt' }),
      textTurn('That file does not exist.'),
    ])

    const output = JSON.parse(jean(project(), ['-p', 'read missing.txt', '-f', 'json']).stdout)
    expect(output.ok).toBe(true)
    expect(output.text).toBe('That file does not exist.')
  }, 30_000)

  test('plan mode hides the mutating tools entirely', async () => {
    await setScript([textTurn('I would create a file, but this session is read-only.')])

    const dir = project()
    const output = JSON.parse(
      jean(dir, ['-p', 'create a file', '-f', 'json', '--permission-mode', 'plan']).stdout,
    )
    expect(output.ok).toBe(true)

    const requests = await capturedRequests()
    const toolNames = requests[0].tools.map((t: any) => t.function.name)
    expect(toolNames).toContain('read')
    expect(toolNames).not.toContain('write')
    expect(toolNames).not.toContain('bash')
  }, 30_000)

  test('a destructive command is refused in a non-interactive run', async () => {
    await setScript([
      toolTurn('bash', { command: 'rm -rf build' }),
      textTurn('I could not run that.'),
    ])

    const dir = project()
    const output = JSON.parse(jean(dir, ['-p', 'clean the build', '-f', 'json']).stdout)
    expect(output.ok).toBe(true)

    const requests = await capturedRequests()
    const toolMessage = requests[1].messages.find((m: any) => m.role === 'tool')
    expect(toolMessage.content).toContain('non-interactive')
  }, 30_000)

  test('the turn cap stops a runaway loop', async () => {
    await setScript(Array.from({ length: 20 }, () => toolTurn('glob', { pattern: '*' })))

    const result = jean(project(), ['-p', 'loop', '-f', 'json', '--max-turns', '3'])
    const output = JSON.parse(result.stdout)

    expect(output.stopReason).toBe('max_turns')
    expect(output.turns).toBe(3)
    expect(result.code).toBe(1)
  }, 30_000)

  test('text output prints only the answer', async () => {
    await setScript([textTurn('Just the answer.')])
    expect(jean(project(), ['-p', 'ask', '-q']).stdout.trim()).toBe('Just the answer.')
  }, 30_000)

  test('persists the session and lists it afterwards', async () => {
    await setScript([textTurn('Remembered.')])

    const dir = project()
    const sessionId = JSON.parse(jean(dir, ['-p', 'remember this', '-f', 'json']).stdout).sessionId
    expect(sessionId).toBeTruthy()

    const sessions = jean(dir, ['sessions'])
    expect(sessions.stdout).toContain(sessionId)
    expect(sessions.stdout).toContain('remember this')
  }, 30_000)

  test('resumes a session with its prior context intact', async () => {
    await setScript([textTurn('First answer.')])
    const dir = project()
    const sessionId = JSON.parse(jean(dir, ['-p', 'first question', '-f', 'json']).stdout).sessionId

    // Resuming replays the stored events, so the model sees the earlier turns.
    await setScript([textTurn('Second answer.')])
    jean(dir, ['-p', 'second question', '--resume', sessionId, '-f', 'json'])

    const requests = await capturedRequests()
    const texts = JSON.stringify(requests[0].messages)
    expect(texts).toContain('first question')
    expect(texts).toContain('First answer.')
    expect(texts).toContain('second question')
  }, 30_000)

  test('a piped session runs every command, not just the first', async () => {
    // `rl.question()` only captures the line that arrives after it is called,
    // so a question-based loop silently drops every buffered line but the
    // first. This asserts all four commands run.
    await setScript([textTurn('Four.')])

    const dir = project()
    const result = jean(dir, [], ['/tools', '/context', 'what is 2+2', '/exit', ''].join('\n'))

    expect(result.stdout).toContain('read')       // /tools listed the registry
    expect(result.stdout).toContain('Turns')      // /context rendered
    expect(result.stdout).toContain('Four.')      // the prompt reached the model
    expect(result.stdout).toContain('Session saved as')
  }, 30_000)

  test('an interactive session ends cleanly at end of input', async () => {
    await setScript([textTurn('done')])
    const result = jean(project(), [], 'hello\n')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('done')
  }, 30_000)

  test('config output never prints a raw API key', () => {
    const dir = project()
    const shown = jean(dir, ['config', 'get', 'model']).stdout
    expect(shown).toContain('openrouter')
    // The project fixture sets apiKey: "test-key"; it must not appear in full.
    expect(shown).not.toContain('test-key')
  }, 30_000)

  test('missing credentials fail with a message naming the variable to set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jean-e2e-nokey-'))
    temps.push(dir)
    writeFileSync(
      join(dir, '.jean.json'),
      JSON.stringify({ model: { provider: 'anthropic', modelId: 'claude-sonnet-4.5' } }),
    )

    const result = jean(dir, ['-p', 'hello', '-f', 'json'])
    expect(result.code).toBe(2)
    const output = JSON.parse(result.stdout)
    expect(output.ok).toBe(false)
    expect(output.error).toContain('ANTHROPIC_API_KEY')
  }, 30_000)
})
