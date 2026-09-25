#!/usr/bin/env node

/**
 * `jean`, as installed by `npm install -g jean-code`.
 *
 * The real program is a single compiled executable in a per-platform package
 * (`jean-code-linux-x64`, `jean-code-win32-x64`, ...) that npm installs as an
 * optional dependency, picking only the one that matches this machine. This
 * file finds it and runs it, passing through arguments, the terminal, and the
 * exit code. It needs nothing but Node — no Bun, no build.
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const SUPPORTED = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64',
]

function binaryPath() {
  if (process.env.JEAN_BINARY) return process.env.JEAN_BINARY

  const key = `${process.platform}-${process.arch}`
  const exe = process.platform === 'win32' ? 'jean.exe' : 'jean'
  try {
    const manifest = require.resolve(`jean-code-${key}/package.json`)
    return path.join(path.dirname(manifest), 'bin', exe)
  } catch {
    return undefined
  }
}

function fail(message) {
  process.stderr.write(`jean: ${message}\n`)
  process.exit(1)
}

const binary = binaryPath()
if (!binary || !fs.existsSync(binary)) {
  const key = `${process.platform}-${process.arch}`
  if (!SUPPORTED.includes(key)) {
    fail(
      `there is no prebuilt Jean for ${key} (available: ${SUPPORTED.join(', ')}).\nInstall from source instead: https://github.com/hackerxj2010/Jean_Code#install`,
    )
  }
  fail(
    `the Jean binary for ${key} is missing. It comes in the optional package jean-code-${key};\nreinstall without --no-optional / --omit=optional:\n  npm install -g jean-code`,
  )
}

const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit', windowsHide: false })

// The child shares the terminal, so Ctrl+C reaches it directly. The launcher
// only relays signals sent to it by name (a `kill`, a service manager) and
// otherwise waits.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (child.exitCode === null) child.kill(signal)
  })
}

child.on('error', (error) => fail(`could not start ${binary}: ${error.message}`))
child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
    return
  }
  process.exit(code === null ? 1 : code)
})
