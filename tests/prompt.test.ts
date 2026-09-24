import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '../packages/config/src/index.ts'
import {
  buildSubagentPrompt,
  buildSystemPrompt,
  loadInstructionFiles,
  repositorySnapshot,
} from '../packages/core/src/index.ts'

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'jean-prompt-'))
  temps.push(root)
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

describe('instruction files', () => {
  test('a package inherits the repository root’s instructions, closer ones last', () => {
    const root = tree({
      'AGENTS.md': 'Root rule: use pnpm.',
      'packages/api/AGENTS.md': 'API rule: every handler validates input.',
    })
    const files = loadInstructionFiles(join(root, 'packages', 'api'), defaultConfig())
    const contents = files.map((f) => f.content.trim())
    expect(contents).toContain('Root rule: use pnpm.')
    expect(contents).toContain('API rule: every handler validates input.')
    expect(contents.indexOf('Root rule: use pnpm.')).toBeLessThan(
      contents.indexOf('API rule: every handler validates input.'),
    )
  })

  test('@path imports pull in another file, relative to the importer', () => {
    const root = tree({
      'CLAUDE.md': 'Read the style guide.\n@docs/style.md\nThat is all.',
      'docs/style.md': 'Tabs, not spaces.',
    })
    const [file] = loadInstructionFiles(root, defaultConfig())
    expect(file!.content).toContain('Tabs, not spaces.')
    expect(file!.content).toContain('That is all.')
  })

  test('imports inside a code fence are left alone', () => {
    const root = tree({
      'AGENTS.md': 'Example:\n```\n@docs/secret.md\n```\n',
      'docs/secret.md': 'SHOULD NOT APPEAR',
    })
    const [file] = loadInstructionFiles(root, defaultConfig())
    expect(file!.content).not.toContain('SHOULD NOT APPEAR')
  })

  test('an import cycle terminates', () => {
    const root = tree({ 'AGENTS.md': '@a.md', 'a.md': 'A\n@b.md', 'b.md': 'B\n@a.md' })
    const [file] = loadInstructionFiles(root, defaultConfig())
    expect(file!.content).toContain('A')
    expect(file!.content).toContain('B')
  })

  test('local files are picked up alongside shared ones', () => {
    const root = tree({ 'CLAUDE.md': 'shared', 'CLAUDE.local.md': 'mine only' })
    const contents = loadInstructionFiles(root, defaultConfig()).map((f) => f.content)
    expect(contents).toEqual(expect.arrayContaining(['shared', 'mine only']))
  })

  test('the same file is never loaded twice', () => {
    const root = tree({ 'AGENTS.md': 'once' })
    const config = { ...defaultConfig(), instructionFiles: ['AGENTS.md', join(root, 'AGENTS.md')] }
    expect(loadInstructionFiles(root, config).filter((f) => f.content === 'once')).toHaveLength(1)
  })
})

describe('the system prompt', () => {
  const base = { mode: 'autonomous' as const, config: defaultConfig() }

  test('tells an unattended run to finish without asking', () => {
    const cwd = tree({})
    expect(buildSystemPrompt({ ...base, cwd, interactive: false })).toContain('Running unattended')
    expect(buildSystemPrompt({ ...base, cwd, interactive: true })).not.toContain(
      'Running unattended',
    )
  })

  test('carries the rules that protect benchmark and user integrity', () => {
    const prompt = buildSystemPrompt({ ...base, cwd: tree({}) })
    expect(prompt).toContain('Batch independent calls')
    expect(prompt).toContain('Do not weaken, skip, or delete tests')
    expect(prompt).toContain('Never say a test passes')
  })

  test('is identical across turns for the same inputs, so it caches', () => {
    const cwd = tree({ 'AGENTS.md': 'rules' })
    const snapshot = repositorySnapshot(cwd)
    const a = buildSystemPrompt({ ...base, cwd, snapshot })
    const b = buildSystemPrompt({ ...base, cwd, snapshot })
    expect(a).toBe(b)
  })

  test('a sub-agent is told it runs unattended and must stay in scope', () => {
    const prompt = buildSubagentPrompt('Find the auth middleware.', { ...base, cwd: tree({}) })
    expect(prompt).toContain('Find the auth middleware.')
    expect(prompt).toContain('running unattended')
  })
})

describe('the repository snapshot', () => {
  test('lists the top level and skips dependency directories', () => {
    const cwd = tree({ 'src/a.ts': '', 'node_modules/x/index.js': '', 'README.md': '' })
    const snapshot = repositorySnapshot(cwd)
    expect(snapshot).toContain('src/')
    expect(snapshot).toContain('README.md')
    expect(snapshot).not.toContain('node_modules')
  })
})
