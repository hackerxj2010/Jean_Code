/**
 * Builds Jean for release: one self-contained executable per platform, and
 * from them the npm packages and the download archives.
 *
 *   bun scripts/release/build.ts                       this machine only
 *   bun scripts/release/build.ts --all                 every platform
 *   bun scripts/release/build.ts --target win32-x64 --target linux-x64
 *   bun scripts/release/build.ts --version 1.2.0 --native
 *   bun scripts/release/build.ts --target darwin-x64 --native --rust-target x86_64-apple-darwin
 *   bun scripts/release/build.ts --main-only --version 1.2.0
 *
 * Output, under `dist/`:
 *
 *   npm/jean-code/                  the package users install; `bin/jean.js`
 *                                   finds and runs the platform binary
 *   npm/jean-code-<os>-<cpu>/       one per platform: bin/jean, bin/skills/,
 *                                   and with --native the Rust core beside it
 *   release/jean-<os>-<cpu>.tar.gz  (.zip on Windows) for the installers
 *
 * Cross-building needs every platform's OpenTUI library installed:
 * `bun install --os='*' --cpu='*'` first. `--native` builds the Rust core for
 * this machine, or for `--rust-target <triple>` when the toolchain can cross to
 * it (an ARM Mac building for Intel); CI runs one job per platform.
 * `--main-only` writes just the `jean-code` launcher package, for publishing
 * after the per-platform jobs.
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

interface Target {
  /** Node's `${process.platform}-${process.arch}`, which names the npm package. */
  key: string
  os: 'linux' | 'darwin' | 'win32'
  cpu: 'x64' | 'arm64'
  /** Bun's compile target. x64 uses "baseline": the default needs AVX2 and dies with "Illegal instruction" on older CPUs. */
  bun: string
}

const TARGETS: Target[] = [
  { key: 'linux-x64', os: 'linux', cpu: 'x64', bun: 'bun-linux-x64-baseline' },
  { key: 'linux-arm64', os: 'linux', cpu: 'arm64', bun: 'bun-linux-arm64' },
  { key: 'darwin-x64', os: 'darwin', cpu: 'x64', bun: 'bun-darwin-x64-baseline' },
  { key: 'darwin-arm64', os: 'darwin', cpu: 'arm64', bun: 'bun-darwin-arm64' },
  { key: 'win32-x64', os: 'win32', cpu: 'x64', bun: 'bun-windows-x64-baseline' },
  { key: 'win32-arm64', os: 'win32', cpu: 'arm64', bun: 'bun-windows-arm64' },
]

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist')
const REPOSITORY = { type: 'git', url: 'git+https://github.com/hackerxj2010/Jean_Code.git' }
const HOMEPAGE = 'https://github.com/hackerxj2010/Jean_Code'

// ---- arguments ---------------------------------------------------------------

const argv = process.argv.slice(2)
const option = (name: string) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const rootManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  version: string
}
const version = (option('--version') ?? rootManifest.version).replace(/^v/, '')
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version))
  fail(`"${version}" is not a version (expected e.g. 1.2.0)`)

const host = `${process.platform}-${process.arch}`
const requested = argv.flatMap((arg, i) => (argv[i - 1] === '--target' ? [arg] : []))
const targets = argv.includes('--all')
  ? TARGETS
  : TARGETS.filter((t) => (requested.length ? requested.includes(t.key) : t.key === host))
for (const key of requested) {
  if (!TARGETS.some((t) => t.key === key))
    fail(`unknown target "${key}" (known: ${TARGETS.map((t) => t.key).join(', ')})`)
}
if (targets.length === 0)
  fail(`this machine (${host}) is not a release platform; pass --target or --all`)

const withNative = argv.includes('--native')
const rustTarget = option('--rust-target')
const mainOnly = argv.includes('--main-only')
if (rustTarget && targets.length !== 1) fail('--rust-target builds for one --target at a time')

// ---- build -------------------------------------------------------------------

rmSync(join(DIST, 'npm'), { recursive: true, force: true })
rmSync(join(DIST, 'release'), { recursive: true, force: true })
mkdirSync(join(DIST, 'release'), { recursive: true })

if (withNative && !mainOnly) buildNative()

for (const target of mainOnly ? [] : targets) {
  say(`jean ${version} for ${target.key}`)
  const pkgDir = join(DIST, 'npm', `jean-code-${target.key}`)
  const binDir = join(pkgDir, 'bin')
  mkdirSync(binDir, { recursive: true })

  const exe = target.os === 'win32' ? 'jean.exe' : 'jean'
  run('bun', [
    'build',
    '--compile',
    `--target=${target.bun}`,
    `--define=JEAN_BUILD_VERSION=${JSON.stringify(version)}`,
    join(ROOT, 'packages', 'cli', 'src', 'index.ts'),
    '--outfile',
    join(binDir, exe),
  ])

  // Beside the executable is where a compiled Jean looks for these.
  cpSync(join(ROOT, 'skills'), join(binDir, 'skills'), { recursive: true })
  if (withNative && (rustTarget || target.key === host)) copyNative(binDir, target)

  copyLegal(pkgDir)
  writeJson(join(pkgDir, 'package.json'), {
    name: `jean-code-${target.key}`,
    version,
    description: `The Jean Code executable for ${target.key}. Install jean-code instead.`,
    license: 'MIT',
    repository: REPOSITORY,
    homepage: HOMEPAGE,
    os: [target.os],
    cpu: [target.cpu],
    files: ['bin', 'licenses', 'THIRD_PARTY_NOTICES.md'],
    // Some package managers would otherwise leave the binary inside a zip.
    preferUnplugged: true,
  })

  archive(
    binDir,
    join(DIST, 'release', `jean-${target.key}${target.os === 'win32' ? '.zip' : '.tar.gz'}`),
    target,
  )
}

// The package users install: a launcher and the platform packages as
// optional dependencies, of which npm fetches only the matching one.
const mainDir = join(DIST, 'npm', 'jean-code')
mkdirSync(join(mainDir, 'bin'), { recursive: true })
cpSync(join(ROOT, 'npm', 'jean-code', 'bin', 'jean.js'), join(mainDir, 'bin', 'jean.js'))
chmodSync(join(mainDir, 'bin', 'jean.js'), 0o755)
cpSync(join(ROOT, 'npm', 'jean-code', 'README.md'), join(mainDir, 'README.md'))
copyLegal(mainDir)
writeJson(join(mainDir, 'package.json'), {
  name: 'jean-code',
  version,
  description: 'A coding agent for your terminal. Install, then run `jean`.',
  license: 'MIT',
  repository: REPOSITORY,
  homepage: HOMEPAGE,
  keywords: ['ai', 'agent', 'coding-agent', 'cli', 'terminal', 'llm'],
  // The launcher is plain CommonJS, so it runs on any Node without flags.
  type: 'commonjs',
  bin: { jean: 'bin/jean.js' },
  files: ['bin', 'licenses', 'THIRD_PARTY_NOTICES.md'],
  engines: { node: '>=16' },
  // Every platform, always — even when this run built only some — so the
  // published package points at all of them.
  optionalDependencies: Object.fromEntries(TARGETS.map((t) => [`jean-code-${t.key}`, version])),
})

say(`done: ${mainOnly ? 'jean-code' : targets.map((t) => t.key).join(', ')} → ${DIST}`)

// ---- helpers -----------------------------------------------------------------

function buildNative(): void {
  say(`the Rust core${rustTarget ? ` for ${rustTarget}` : ''}`)
  const cross = rustTarget ? ['--target', rustTarget] : []
  run('cargo', ['build', '--release', '-p', 'pi-natives', ...cross])
  run('cargo', ['build', '--profile', 'ffi', '-p', 'pi-ffi', ...cross])
}

function copyNative(binDir: string, target: Target): void {
  const natives = target.os === 'win32' ? 'pi-natives.exe' : 'pi-natives'
  const library =
    target.os === 'win32'
      ? 'jean_native.dll'
      : target.os === 'darwin'
        ? 'libjean_native.dylib'
        : 'libjean_native.so'
  const out = rustTarget ? join(ROOT, 'target', rustTarget) : join(ROOT, 'target')
  for (const [from, name] of [
    [join(out, 'release', natives), natives],
    [join(out, 'ffi', library), library],
  ] as const) {
    if (!existsSync(from)) fail(`--native was given but ${from} was not built`)
    cpSync(from, join(binDir, name))
  }
}

function copyLegal(dir: string): void {
  cpSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), join(dir, 'THIRD_PARTY_NOTICES.md'))
  cpSync(join(ROOT, 'licenses'), join(dir, 'licenses'), { recursive: true })
}

/** The archive the installers download: the contents of `bin/`, at its top level. */
function archive(binDir: string, out: string, target: Target): void {
  if (target.os !== 'win32') {
    run('tar', ['-czf', out, '-C', binDir, '.'])
  } else if (process.platform === 'win32') {
    // Windows' own tar (bsdtar) writes zips; PowerShell's Compress-Archive is
    // far slower. Named in full: in Git Bash, `tar` is GNU tar, which cannot.
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    run(tar, ['-a', '-cf', out, '-C', binDir, '.'])
  } else {
    run('zip', ['-qr', out, '.'], binDir)
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function run(command: string, args: string[], cwd = ROOT): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) fail(`could not run ${command}: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${result.status}`)
}

function say(message: string): void {
  console.log(`\x1b[1m==>\x1b[0m ${message}`)
}

function fail(message: string): never {
  console.error(`\x1b[31m✗\x1b[0m ${message}`)
  process.exit(1)
}
