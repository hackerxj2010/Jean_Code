import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { renderReview, review } from '../packages/review/src/index.ts'

/* jean-scan-ignore — the fixtures below contain synthetic keys by design. */
const temps: string[] = []

/** A git repository with one commit, so there is something to diff against. */
function repository(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'jean-review-'))
  temps.push(dir)

  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })

  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }

  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir })
  return dir
}

function write(dir: string, path: string, content: string): void {
  const full = join(dir, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

afterEach(() => {
  while (temps.length > 0) {
    try {
      rmSync(temps.pop()!, { recursive: true, force: true })
    } catch {
      // Windows can hold a directory open briefly after git touches it.
    }
  }
})

describe('reviewing the working tree', () => {
  test('reports nothing when nothing changed', async () => {
    const report = await review({ cwd: repository() })
    expect(report.files).toHaveLength(0)
    expect(renderReview(report)).toContain('Nothing has changed')
  }, 30_000)

  test('counts modified lines', async () => {
    const dir = repository({ 'src/app.ts': 'export const a = 1\n' })
    write(dir, 'src/app.ts', 'export const a = 1\nexport const b = 2\n')

    const report = await review({ cwd: dir })
    expect(report.files.map((f) => f.path)).toContain('src/app.ts')
    expect(report.totalAdded).toBeGreaterThan(0)
  }, 30_000)

  test('includes untracked files, which git diff omits', async () => {
    const dir = repository()
    write(dir, 'src/brand-new.ts', 'export const fresh = 1\n')

    // A new file is part of the change, and a reviewer should see it.
    const report = await review({ cwd: dir })
    const added = report.files.find((f) => f.path === 'src/brand-new.ts')
    expect(added).toBeDefined()
    expect(added!.status).toBe('new')
  }, 30_000)

  test('flags source files with no companion test', async () => {
    const dir = repository()
    write(dir, 'src/rate-limit.ts', 'export class RateLimiter {}\n')

    const report = await review({ cwd: dir })
    expect(report.files.find((f) => f.path === 'src/rate-limit.ts')!.untested).toBe(true)
    expect(report.observations.some((note) => note.includes('no obvious test'))).toBe(true)
  }, 30_000)

  test('does not flag a file that has a test alongside it', async () => {
    const dir = repository()
    write(dir, 'src/parser.ts', 'export function parse() {}\n')
    write(dir, 'tests/parser.test.ts', 'test("parses", () => {})\n')

    const report = await review({ cwd: dir })
    expect(report.files.find((f) => f.path === 'src/parser.ts')!.untested).toBe(false)
  }, 30_000)

  test('does not ask for tests for documentation or config', async () => {
    const dir = repository()
    write(dir, 'docs/guide.md', '# guide\n')
    write(dir, 'tsconfig.json', '{}\n')

    const report = await review({ cwd: dir })
    for (const file of report.files) expect(file.untested).toBeUndefined()
  }, 30_000)

  test('reports a secret introduced by the change', async () => {
    const dir = repository()
    write(dir, 'src/config.ts', `const key = "ghp_${'a'.repeat(36)}"\n`)

    const report = await review({ cwd: dir })
    expect(report.scan.secrets.length).toBeGreaterThan(0)
    // Deleting the line does not remove it from history.
    expect(report.observations[0]).toContain('rotate')
  }, 30_000)

  test('reports a high-severity pattern in changed code', async () => {
    const dir = repository()
    write(dir, 'src/db.ts', 'db.query(`SELECT * FROM t WHERE id = ${id}`)\n')

    const report = await review({ cwd: dir })
    expect(report.scan.code.some((finding) => finding.severity === 'high')).toBe(true)
  }, 30_000)

  test('notices generated files in the diff', async () => {
    const dir = repository()
    write(dir, 'dist/bundle.js', 'console.log(1)\n')

    const report = await review({ cwd: dir })
    expect(report.observations.some((note) => note.includes('generated'))).toBe(true)
  }, 30_000)

  test('notices a change too wide to review as one unit', async () => {
    const dir = repository()
    for (let i = 0; i < 30; i++) write(dir, `src/file${i}.ts`, `export const v${i} = ${i}\n`)

    const report = await review({ cwd: dir })
    expect(report.observations.some((note) => note.includes('hard to review'))).toBe(true)
  }, 30_000)

  test('skips the scan on request', async () => {
    const dir = repository()
    write(dir, 'src/config.ts', `const key = "ghp_${'a'.repeat(36)}"\n`)

    const report = await review({ cwd: dir, skipScan: true })
    expect(report.scan.secrets).toHaveLength(0)
    expect(report.files.length).toBeGreaterThan(0)
  }, 30_000)
})

describe('the rendered report', () => {
  test('puts observations before the diff', async () => {
    const dir = repository()
    write(dir, 'src/thing.ts', 'export const a = 1\n')

    const rendered = renderReview(await review({ cwd: dir }))
    // Observations are the reason to read the rest, so they lead.
    expect(rendered.indexOf('Worth checking')).toBeLessThan(rendered.indexOf('## Diff'))
  }, 30_000)

  test('lists every changed file with its counts', async () => {
    const dir = repository({ 'src/a.ts': 'export const a = 1\n' })
    write(dir, 'src/a.ts', 'export const a = 2\n')

    const rendered = renderReview(await review({ cwd: dir }))
    expect(rendered).toContain('src/a.ts')
    expect(rendered).toContain('files changed')
  }, 30_000)

  test('truncates an enormous diff rather than flooding the context', async () => {
    const dir = repository({ 'big.ts': 'x\n' })
    write(dir, 'big.ts', Array.from({ length: 5000 }, (_, i) => `const v${i} = ${i}`).join('\n'))

    const rendered = renderReview(await review({ cwd: dir }), 2000)
    expect(rendered).toContain('diff truncated')
  }, 30_000)
})
