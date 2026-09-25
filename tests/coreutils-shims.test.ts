import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { defaultConfig } from '../packages/config/src/index.ts'
import {
  COREUTILS,
  coreutilsShimDir,
  findBinary,
  nativeReady,
} from '../packages/native/src/index.ts'
import { Registry, builtinTools, createSessionState } from '../packages/tools/src/index.ts'

/**
 * Jean's coreutils inside the system shell: every Rust builtin reachable as
 * a command at the end of the bash tool's PATH, so what the shell lacks runs
 * Jean's implementation and what it has keeps running its own.
 */

const built = findBinary() !== undefined
const hasBash = Bun.which(process.env.SHELL ?? 'bash') !== null

describe.skipIf(!built)('coreutils in the system shell', () => {
  test('the shim list is the binary’s own list', async () => {
    const native = await nativeReady()
    expect([...COREUTILS].sort() as string[]).toEqual((await native!.builtins()).sort())
  })

  test('a shim per builtin, for sh and — on Windows — cmd', () => {
    const dir = coreutilsShimDir()!
    expect(existsSync(join(dir, '.complete'))).toBe(true)
    const files = new Set(readdirSync(dir))
    for (const name of COREUTILS) {
      expect(files.has(name)).toBe(true)
      if (process.platform === 'win32') expect(files.has(`${name}.cmd`)).toBe(true)
    }
  })

  test.skipIf(!hasBash)('the bash tool reaches them, last on PATH', async () => {
    const registry = new Registry()
    registry.registerAll(builtinTools())
    const cwd = process.cwd()
    const context = {
      cwd,
      config: { ...defaultConfig(), permissionMode: 'full' as const },
      session: createSessionState(cwd),
    }
    const run = async (command: string) =>
      (await registry.call('bash', { command }, context, { approve: true })).output.trim()

    const dir = coreutilsShimDir()!
    // Straight through a shim to the Rust builtin, whatever the shell has.
    const shim = `"${join(dir, 'jq').replace(/\\/g, '/')}"`
    expect(await run(`echo '{"a":[1,2]}' | ${shim} '.a[1]'`)).toBe('2')
    // By name: the shell's own `bc` when it has one, Jean's otherwise.
    expect(await run(`echo '6*7' | bc`)).toBe('42')
    // Appended, not prepended: the shim directory is the last entry.
    const entries = (await run('echo "$PATH"')).split(/[:;]/)
    expect(entries.at(-1)).toContain(basename(dir))
  })
})
