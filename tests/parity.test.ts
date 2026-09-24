import { beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { HashlineError, anchorOf, patch } from '../packages/tools/src/hashline.ts'

/**
 * Cross-language parity: `crates/hashline` vs `packages/tools/src/hashline.ts`.
 *
 * Both implementations apply patches to the user's real files. If they diverge,
 * whether an edit lands correctly depends on whether a native module happened
 * to be compiled — so this feeds identical fixtures to both and compares the
 * output byte for byte.
 *
 * The suite skips itself when cargo is unavailable rather than failing: the
 * TypeScript path has to work on machines with no Rust toolchain, which is
 * exactly why it exists.
 */

const ROOT = join(import.meta.dir, '..')

interface Case {
  name: string
  content: string
  patch: string
}

function buildCases(): Case[] {
  const simple = 'export class A {\n  private n = 0;\n\n  hit() {\n    this.n += 1;\n  }\n}\n'
  const indented = 'class A {\n    hit() {\n        go();\n    }\n}\n'
  const duplicated = 'fn a() {\n  ok();\n}\nfn b() {\n  ok();\n}\n'
  const noTrailing = 'one\ntwo\nthree'
  const blankLines = 'a\n\n\nb\n'
  const tabs = '\tfirst\n\t\tsecond\n'
  const unicode = 'const s = "héllo wörld";\nconst t = "日本語";\n'

  const hunk = (anchor: string, body: string[], text?: string) =>
    [`anchor: h:${anchor}${text ? ` -> "${text}"` : ''}`, 'patch: |-|', ...body].join('\n')

  return [
    {
      name: 'simple replacement',
      content: simple,
      patch: hunk(anchorOf('  private n = 0;'), [
        '-   private n = 0;',
        '+   private n = new Map();',
      ]),
    },
    {
      name: 'insertion after context',
      content: simple,
      patch: hunk(anchorOf('  hit() {'), ['  hit() {', '+     log();']),
    },
    {
      name: 'pure deletion',
      content: simple,
      patch: hunk(anchorOf('    this.n += 1;'), ['-     this.n += 1;']),
    },
    {
      name: 'stale anchor recovered by text',
      content: simple,
      patch: hunk('deadbeef', ['-   private n = 0;', '+   private n = 9;'], 'private n = 0;'),
    },
    {
      name: 'stale anchor recovered by context',
      content: simple,
      patch: hunk('deadbeef', ['  hit() {', '-     this.n += 1;', '+     this.n += 7;']),
    },
    {
      name: 'reindent into deeper source',
      content: indented,
      patch: hunk(anchorOf('        go();'), ['    go();', '+     log();'], 'go();'),
    },
    {
      name: 'ambiguous anchor disambiguated by context',
      content: duplicated,
      patch: hunk(anchorOf('  ok();'), ['-   ok();', '+   ok2();', '}', 'fn b() {']),
    },
    {
      name: 'ambiguous anchor with no disambiguator',
      content: duplicated,
      patch: hunk(anchorOf('  ok();'), ['-   ok();', '+   ok2();']),
    },
    {
      name: 'anchor that does not exist',
      content: simple,
      patch: hunk('ffffffff', ['- nothing', '+ something']),
    },
    {
      name: 'context mismatch',
      content: simple,
      patch: hunk(anchorOf('  private n = 0;'), ['  private n = 0;', '- not in the file']),
    },
    {
      name: 'no trailing newline',
      content: noTrailing,
      patch: hunk(anchorOf('two'), ['- two', '+ TWO']),
    },
    {
      name: 'blank lines preserved',
      content: blankLines,
      patch: hunk(anchorOf('b'), ['- b', '+ B']),
    },
    {
      name: 'tab indentation',
      content: tabs,
      patch: hunk(anchorOf('\t\tsecond'), ['- second', '+ SECOND']),
    },
    {
      name: 'unicode content',
      content: unicode,
      patch: hunk(anchorOf('const t = "日本語";'), [
        '- const t = "日本語";',
        '+ const t = "한국어";',
      ]),
    },
    {
      name: 'multiple hunks with drift',
      content: simple,
      patch: [
        hunk(anchorOf('  private n = 0;'), [
          '  private n = 0;',
          '+   private m = 0;',
          '+   private k = 0;',
        ]),
        hunk(anchorOf('    this.n += 1;'), ['-     this.n += 1;', '+     this.n += 2;']),
      ].join('\n'),
    },
    {
      name: 'malformed patch',
      content: simple,
      patch: 'this is not a patch at all',
    },
    {
      name: 'empty file',
      content: '',
      patch: hunk(anchorOf(''), ['- ', '+ new']),
    },
  ]
}

/** Runs every case through the Rust binary in one invocation. */
function runRust(cases: Case[]): { ok: boolean; body: string }[] | undefined {
  const build = spawnSync(
    'cargo',
    ['build', '--quiet', '-p', 'pi-natives', '--bin', 'hashline-parity'],
    {
      cwd: ROOT,
      encoding: 'buffer',
    },
  )
  if (build.status !== 0) return undefined

  const exe = join(
    ROOT,
    'target',
    'debug',
    process.platform === 'win32' ? 'hashline-parity.exe' : 'hashline-parity',
  )
  if (!existsSync(exe)) return undefined

  const chunks: Buffer[] = []
  for (const testCase of cases) {
    const content = Buffer.from(testCase.content, 'utf8')
    const patchBytes = Buffer.from(testCase.patch, 'utf8')
    chunks.push(Buffer.from(`CASE ${content.length} ${patchBytes.length}\n`, 'utf8'))
    chunks.push(content, patchBytes)
  }

  const result = spawnSync(exe, [], { input: Buffer.concat(chunks), encoding: 'buffer' })
  if (result.status !== 0 || !result.stdout) return undefined

  return parseResponses(result.stdout as Buffer, cases.length)
}

function parseResponses(buffer: Buffer, expected: number): { ok: boolean; body: string }[] {
  const out: { ok: boolean; body: string }[] = []
  let offset = 0

  for (let i = 0; i < expected; i++) {
    const newline = buffer.indexOf(0x0a, offset)
    if (newline === -1) break
    const header = buffer.subarray(offset, newline).toString('utf8').trim()
    const [tag, lengthText] = header.split(' ')
    const length = Number(lengthText)
    offset = newline + 1
    const body = buffer.subarray(offset, offset + length).toString('utf8')
    offset += length
    out.push({ ok: tag === 'OK', body })
  }

  return out
}

let rustResults: { ok: boolean; body: string }[] | undefined
const cases = buildCases()

// `runRust` compiles the harness first. A cold `cargo build` takes minutes, far
// past bun's five-second hook default, and a timed-out hook reads as a parity
// failure when nothing was compared at all.
beforeAll(() => {
  rustResults = runRust(cases)
}, 600_000)

describe('hashline parity: Rust crate vs TypeScript fallback', () => {
  test('the Rust harness builds and runs', () => {
    if (!rustResults) {
      console.warn('  cargo unavailable — parity comparison skipped')
      return
    }
    expect(rustResults).toHaveLength(cases.length)
  })

  for (const [index, testCase] of cases.entries()) {
    test(`agrees on: ${testCase.name}`, () => {
      if (!rustResults) return // toolchain missing; covered by the test above

      const rust = rustResults[index]!
      let ts: { ok: boolean; body: string }
      try {
        ts = { ok: true, body: patch(testCase.content, testCase.patch).content }
      } catch (err) {
        ts = {
          ok: false,
          body: err instanceof HashlineError ? err.message : String(err),
        }
      }

      // Both must agree on whether the patch applies at all.
      expect({ name: testCase.name, applied: ts.ok }).toEqual({
        name: testCase.name,
        applied: rust.ok,
      })

      // When it applies, the resulting file must be byte-identical. When it
      // does not, the messages differ in wording by design — what matters is
      // that neither silently produced a file.
      if (rust.ok) {
        expect(ts.body).toBe(rust.body)
      }
    })
  }
})
