import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildNative,
  callSync,
  closeNative,
  Native,
  nativeStats,
  nativeStatus,
  type NativeStatus,
} from '@jean/native'
import { color, line, symbols } from '../ui.ts'

/**
 * `jean native` — the Rust core, visible.
 *
 * `status` says which binary is in use and whether it is current; `build`
 * builds it; `test` drives every crate through the bridge and reports each
 * one, so "the Rust side works" is something a user can check in five
 * seconds rather than take on faith.
 */

/** Which crate serves which part of Jean Code. Shown by `status`. */
export const CRATE_ROLES: { crate: string; methods: string; serves: string }[] = [
  { crate: 'pi-walker', methods: 'walk.*', serves: 'glob, grep, every walk(), codemap and security scans' },
  { crate: 'hashline', methods: 'hashline.*', serves: 'read anchors, edit patches' },
  { crate: 'pi-ast', methods: 'ast.*', serves: 'ast_grep, codemap_outline' },
  { crate: 'pi-builtins', methods: 'builtins.*', serves: 'the text tool, the embedded shell' },
  { crate: 'pi-shell + brush-core', methods: 'shell.*', serves: 'bash safety parsing, permission rules, the embedded shell' },
  { crate: 'pi-iso', methods: 'iso.*', serves: 'sub-agent isolation outside git' },
  { crate: 'snapcompact', methods: 'snap.*', serves: 'compaction archive, recall_archive' },
  { crate: 'pi-sys', methods: 'sys.*', serves: 'process-tree kill, keep-awake, /copy' },
  { crate: 'pi-tokens', methods: 'tokens.count', serves: 'the auto-compaction threshold' },
  { crate: 'pi-voice', methods: 'voice.*', serves: 'reading .wav files, transcribe' },
  { crate: 'pi-mnemopi', methods: 'memory.*', serves: 'the default memory backend' },
  { crate: 'pi-lsp', methods: 'lsp.*', serves: 'the lsp_* tools, diagnostics after every edit' },
  { crate: 'pi-dap', methods: 'dap.*', serves: 'the debug_* tools: debugpy, js-debug, delve, codelldb...' },
]

export async function runNativeCommand(positional: string[]): Promise<number> {
  const sub = positional[0] ?? 'status'
  if (sub === 'build') return build()
  if (sub === 'test') return selfTest()
  if (sub === 'status') {
    await printNativeReport()
    return (await nativeStatus()).available ? 0 : 1
  }
  line(color.red(`Unknown subcommand \`${sub}\`.`) + color.dim(' Use status, build, or test.'))
  return 2
}

async function build(): Promise<number> {
  line(color.dim('  cargo build --release -p pi-natives'))
  const result = await buildNative((text) => process.stderr.write(color.dim(text)))
  if (result.code === 0) {
    line(`${symbols.check} Built ${color.cyan(result.binary ?? 'pi-natives')}.`)
    return 0
  }
  line(color.red(`${symbols.cross} The build failed (exit ${result.code}).`))
  return 1
}

function describe(status: NativeStatus): string[] {
  const out: string[] = []
  if (status.disabled) {
    out.push(color.yellow(`${symbols.warn} Disabled by JEAN_NATIVE=0 — every feature runs its TypeScript fallback.`))
  } else if (!status.binary) {
    out.push(color.red(`${symbols.cross} Not built. Run \`jean native build\` (needs cargo).`))
  } else if (!status.available) {
    out.push(color.red(`${symbols.cross} ${status.binary} is there but did not answer.`))
  } else {
    out.push(`${symbols.check} pi-natives ${status.version ?? ''} — ${status.methods.length} methods`)
    out.push(color.dim(`    ${status.binary}`))
    out.push(
      status.library
        ? `${symbols.check} In-process library for synchronous calls ${color.dim(`(${status.library})`)}`
        : color.yellow(`${symbols.warn} No in-process library: memory calls start a process each (~80 ms). \`jean native build\` builds it.`),
    )
    if (status.missing.length > 0) {
      out.push(color.yellow(`${symbols.warn} Out of date: missing ${status.missing.join(', ')}. Run \`jean native build\`.`))
    } else if (status.stale) {
      out.push(color.yellow(`${symbols.warn} The Rust sources are newer than this build. Run \`jean native build\`.`))
    }
  }
  return out
}

/** Status, the crate map, and the calls this process has made. */
export async function printNativeReport(): Promise<void> {
  const status = await nativeStatus()
  line()
  line(color.bold('Rust core'))
  for (const text of describe(status)) line(`  ${text}`)
  line()
  for (const role of CRATE_ROLES) {
    line(`  ${color.cyan(role.crate.padEnd(22))} ${color.dim(role.methods.padEnd(14))} ${role.serves}`)
  }

  const stats = Object.entries(nativeStats()).filter(([method]) => method !== 'ping' && method !== 'version')
  line()
  if (stats.length === 0) {
    line(color.dim('  No calls to the Rust core yet in this process.'))
  } else {
    line(color.bold('  Calls this session'))
    for (const [method, entry] of stats) {
      const failures = entry.failures > 0 ? color.yellow(` · ${entry.failures} failed`) : ''
      const average = (entry.totalMs / entry.calls).toFixed(1)
      line(`  ${method.padEnd(20)} ${String(entry.calls).padStart(5)} ${color.dim(`${average} ms avg`)}${failures}`)
    }
  }
  line()
}

/** A mono PCM16 WAV: silence, a tone, silence. Enough for `pi-voice` to find one burst. */
export function testClip(): Buffer {
  const rate = 16_000
  const samples: number[] = []
  for (let i = 0; i < rate / 2; i++) samples.push(0)
  for (let i = 0; i < rate / 2; i++) samples.push(Math.round(Math.sin(i * 0.1) * 12_000))
  for (let i = 0; i < rate / 2; i++) samples.push(0)
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2))
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

type Check = [crate: string, run: (native: Native, dir: string) => Promise<string>]

/**
 * One real operation per crate, on scratch data. Each check returns what it
 * saw, so a pass shows evidence rather than just a tick.
 */
export const SELF_TESTS: Check[] = [
  [
    'hashline',
    async (native) => {
      const content = 'fn main() {\n    old();\n}\n'
      const [, anchor] = await native.anchors(['fn main() {', '    old();'])
      const patched = await native.patch(content, `anchor: h:${anchor}\npatch: |-|\n-     old();\n+     new();\n`)
      if (!patched.includes('new();')) throw new Error('the patch did not apply')
      return `anchor ${anchor}, patch applied`
    },
  ],
  [
    'pi-walker',
    async (native, dir) => {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'a.ts'), 'export const rateLimiter = 1\n')
      const walked = await native.walk(dir, { filesOnly: true })
      const hits = await native.search(dir, 'ratelimiter')
      if (hits.length !== 1) throw new Error(`expected one hit, got ${hits.length}`)
      return `${walked.count} file(s) walked, hit at ${hits[0]!.path}:${hits[0]!.line}`
    },
  ],
  [
    'pi-ast',
    async (native, dir) => {
      const found = await native.searchSource('log(a);\n// log(b);\nlog(c);', 'log($X)', 'x.ts')
      if (found.length !== 2) throw new Error(`expected 2 structural matches, got ${found.length}`)
      writeFileSync(join(dir, 'outline.ts'), 'export class A {\n  run() {}\n}\nfunction b() {}\n')
      const outline = await native.outline(join(dir, 'outline.ts'))
      if (!outline.includes('A')) throw new Error('the outline missed class A')
      return `2 calls matched (the commented one skipped), ${outline.trim().split('\n').length} declarations outlined`
    },
  ],
  [
    'pi-builtins',
    async (native) => {
      const result = await native.builtinPipeline(
        [
          { name: 'sort', args: [] },
          { name: 'uniq', args: ['-c'] },
          { name: 'tr', args: ['a-z', 'A-Z'] },
        ],
        'b\na\nb\n',
      )
      if (!result.stdout.includes('2 B')) throw new Error(`unexpected output ${JSON.stringify(result.stdout)}`)
      return `sort | uniq -c | tr → ${JSON.stringify(result.stdout.trim().replace(/\s+/g, ' '))}`
    },
  ],
  [
    'pi-shell + brush-core',
    async (native, dir) => {
      const inspected = await native.shellInspect("echo ok && 'r''m' -rf /tmp/x")
      if (!inspected.commands.some((c) => c.line === 'rm -rf /tmp/x')) throw new Error('the parser missed the quoted rm')
      const session = await native.shellOpen(dir)
      await native.shellRun(session, 'export GREETING=hi')
      const echoed = await native.shellRun(session, 'echo $GREETING | tr a-z A-Z')
      await native.shellClose(session)
      if (echoed.stdout.trim() !== 'HI') throw new Error(`session state lost: ${JSON.stringify(echoed.stdout)}`)
      return `'r''m' parsed as rm; the session kept $GREETING across calls`
    },
  ],
  [
    'pi-iso',
    async (native, dir) => {
      const source = join(dir, 'iso-src')
      mkdirSync(source, { recursive: true })
      writeFileSync(join(source, 'f.txt'), 'before')
      const view = await native.isoCreate(source, join(dir, 'iso-view'), ['node_modules'])
      writeFileSync(join(view.root, 'f.txt'), 'after')
      const merged = await native.isoMerge(view.id)
      await native.isoDiscard(view.id)
      if (merged.applied !== 1) throw new Error(`expected one file merged, got ${merged.applied}`)
      return `copied ${view.files} file(s) (${view.backend}), merged ${merged.applied} back`
    },
  ],
  [
    'snapcompact',
    async (native, dir) => {
      const store = join(dir, 'archive')
      const frame = await native.snapFrame(store, [
        { role: 'user', text: 'fix src/auth/login.ts' },
        { role: 'tool', text: 'TypeError at src/auth/login.ts:42' },
      ])
      const full = await native.snapGet(store, frame.hash.slice(0, 12))
      if (!full.includes('TypeError')) throw new Error('the archive lost the text')
      return `frame ${frame.hash.slice(0, 12)}, ${frame.entities.length} entities, recovered by hash`
    },
  ],
  [
    'pi-sys',
    async (native) => {
      const processes = await native.processes()
      if (!processes.some((p) => p.pid === process.pid)) throw new Error('this process is missing from the list')
      const held = await native.awake('jean native test')
      await native.release(held.id)
      return `${processes.length} processes listed; keep-awake ${held.active ? 'held and released' : 'not supported here'}`
    },
  ],
  [
    'pi-tokens',
    async (native) => {
      const [prose, code] = await native.countTokensMany([
        'The quick brown fox jumps over the lazy dog.',
        'if (a[i] !== b[j]) { return f(x, y); }',
      ])
      if (!prose || !code) throw new Error('no count')
      return `prose ${prose} tokens, code ${code} tokens`
    },
  ],
  [
    'pi-voice',
    async (native, dir) => {
      const path = join(dir, 'clip.wav')
      writeFileSync(path, testClip())
      const probed = await native.voiceProbe(path)
      if (probed.speech.length !== 1) throw new Error(`expected one speech segment, got ${probed.speech.length}`)
      const prepared = await native.voicePrepare(path, join(dir, 'prepared.wav'))
      const [speech] = probed.speech
      return `${probed.durationMs} ms, speech ${speech!.startMs}–${speech!.endMs} ms, trimmed to ${prepared.durationMs} ms`
    },
  ],
  [
    'pi-mnemopi',
    async (_native, dir) => {
      // The synchronous path the memory backend uses.
      const path = join(dir, 'memory.log')
      const stored = callSync('memory.remember', {
        path,
        name: 'check',
        kind: 'project',
        text: 'zebra deploys blue green',
        project: 'P',
      }) as { id: number }
      const recalled = callSync('memory.recall', { path, query: 'zebra', project: 'P' }) as unknown[]
      callSync('memory.forget', { path, id: stored.id })
      if (recalled.length !== 1) throw new Error(`expected one recall, got ${recalled.length}`)
      return `stored #${stored.id}, recalled by BM25, forgotten`
    },
  ],
  [
    'pi-lsp',
    async (native, dir) => {
      writeFileSync(join(dir, 'package.json'), '{}')
      writeFileSync(join(dir, 'app.ts'), 'export const x: number = 1\n')
      await native.lsp('configure', { projectRoot: dir, autoInstall: false })
      const all = await native.lsp<{ id: string; status: string }[]>('servers', {})
      const typescript = await native.lsp<{ id: string; status: string }[]>('servers', { path: join(dir, 'app.ts') })
      if (typescript.length === 0) throw new Error('no server claims a .ts file')
      const ready = all.filter((s) => s.status === 'installed' || s.status === 'running').length
      return `${all.length} servers known, ${ready} ready here; .ts → ${typescript.map((s) => s.id).join(', ')}`
    },
  ],
  [
    'pi-dap',
    async (native, dir) => {
      writeFileSync(join(dir, 'main.py'), 'print(1)\n')
      await native.dap('configure', { projectRoot: dir, autoInstall: false })
      const all = await native.dap<{ id: string; status: string }[]>('adapters', {})
      const python = await native.dap<{ id: string }[]>('adapters', { path: join(dir, 'main.py') })
      if (!python.some((a) => a.id === 'debugpy')) throw new Error('no adapter claims a .py file')
      const sessions = await native.dap<unknown[]>('sessions', {})
      return `${all.length} adapters known, ${all.filter((a) => a.status === 'installed').length} ready; .py → debugpy; ${sessions.length} sessions`
    },
  ],
]

/** Runs every crate's check. Exported for the test suite. */
export async function runSelfTests(): Promise<{ crate: string; ok: boolean; detail: string }[]> {
  const native = Native.open()
  const dir = mkdtempSync(join(tmpdir(), 'jean-native-test-'))
  const results: { crate: string; ok: boolean; detail: string }[] = []
  try {
    for (const [crate, check] of SELF_TESTS) {
      try {
        results.push({ crate, ok: true, detail: await check(native, mkdtempSync(join(dir, 'c-'))) })
      } catch (err) {
        results.push({ crate, ok: false, detail: err instanceof Error ? err.message : String(err) })
      }
    }
  } finally {
    native.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return results
}

async function selfTest(): Promise<number> {
  const status = await nativeStatus()
  line()
  for (const text of describe(status)) line(`  ${text}`)
  if (!status.available) {
    line()
    return 1
  }
  line()

  const results = await runSelfTests()
  closeNative()
  for (const result of results) {
    const mark = result.ok ? color.green(symbols.check) : color.red(symbols.cross)
    line(`  ${mark} ${result.crate.padEnd(22)} ${result.ok ? color.dim(result.detail) : result.detail}`)
  }
  const failed = results.filter((result) => !result.ok).length
  line()
  line(
    failed === 0
      ? color.green(`${symbols.check} All ${results.length} crates answered through the bridge.`)
      : color.red(`${symbols.cross} ${failed} of ${results.length} crates failed.`),
  )
  line()
  return failed === 0 ? 0 : 1
}
