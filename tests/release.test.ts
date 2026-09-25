import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const LAUNCHER = join(ROOT, 'npm', 'jean-code', 'bin', 'jean.js')
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Runs the npm launcher with Node, as `npm install -g` would. */
function launch(args: string[], env: Record<string, string>) {
  const result = spawnSync('node', [LAUNCHER, ...args], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

describe('the npm launcher', () => {
  test.skipIf(process.platform === 'win32')(
    'runs the binary with the same arguments and exit code',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'jean-launcher-'))
      temps.push(dir)
      const fake = join(dir, 'jean')
      writeFileSync(fake, '#!/bin/sh\necho "args: $*"\nexit 7\n')
      chmodSync(fake, 0o755)

      const run = launch(['--version', 'two words'], { JEAN_BINARY: fake })
      expect(run.out.trim()).toBe('args: --version two words')
      expect(run.code).toBe(7)
    },
  )

  test('says how to fix a missing platform package instead of crashing', () => {
    const run = launch(['--version'], { JEAN_BINARY: join(tmpdir(), 'jean-does-not-exist') })
    expect(run.code).toBe(1)
    expect(run.err).toContain('npm install -g jean-code')
  })
})

describe('the release build', () => {
  test('the jean-code package points at every platform and runs bin/jean.js', () => {
    const build = spawnSync(
      'bun',
      [join(ROOT, 'scripts', 'release', 'build.ts'), '--main-only', '--version', '9.9.9'],
      {
        cwd: ROOT,
        encoding: 'utf8',
      },
    )
    expect(build.status).toBe(0)

    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'dist', 'npm', 'jean-code', 'package.json'), 'utf8'),
    )
    expect(manifest.name).toBe('jean-code')
    expect(manifest.version).toBe('9.9.9')
    expect(manifest.bin).toEqual({ jean: 'bin/jean.js' })
    expect(Object.keys(manifest.optionalDependencies).sort()).toEqual([
      'jean-code-darwin-arm64',
      'jean-code-darwin-x64',
      'jean-code-linux-arm64',
      'jean-code-linux-x64',
      'jean-code-win32-arm64',
      'jean-code-win32-x64',
    ])
    expect(Object.values(manifest.optionalDependencies)).toEqual(Array(6).fill('9.9.9'))
  })

  test('refuses a version that is not one', () => {
    const build = spawnSync(
      'bun',
      [join(ROOT, 'scripts', 'release', 'build.ts'), '--main-only', '--version', 'latest'],
      {
        cwd: ROOT,
        encoding: 'utf8',
      },
    )
    expect(build.status).toBe(1)
    expect(build.stderr).toContain('is not a version')
  })
})
