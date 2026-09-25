import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  LspClient,
  BUILTIN_SERVERS,
  Connection,
  extensionOf,
  findRoot,
  languageOf,
  pathToUri,
  serverFor,
  uriToPath,
} from '../packages/lsp/src/index.ts'

/**
 * The protocol layer is tested against a real subprocess speaking real LSP
 * framing, because the failure this catches — a body split across two chunks —
 * only happens with a real stream.
 */

const temps: string[] = []
const SERVER = join(import.meta.dir, 'fixtures', 'mock-language-server.mjs')

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'jean-lsp-'))
  temps.push(dir)
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true })
})

describe('URI conversion', () => {
  test('round-trips a path', () => {
    const path = process.platform === 'win32' ? 'C:\\project\\src\\main.ts' : '/project/src/main.ts'
    expect(uriToPath(pathToUri(path))).toBe(path)
  })

  test('produces the file:/// form servers expect', () => {
    const uri = pathToUri(process.platform === 'win32' ? 'C:\\a\\b.ts' : '/a/b.ts')
    expect(uri.startsWith('file:///')).toBe(true)
  })

  test('encodes characters that are not URI-safe', () => {
    const path = process.platform === 'win32' ? 'C:\\my project\\a b.ts' : '/my project/a b.ts'
    const uri = pathToUri(path)
    expect(uri).toContain('%20')
    // The separators must survive encoding, or the server sees one long segment.
    expect(uri).not.toContain('%2F')
    expect(uriToPath(uri)).toBe(path)
  })

  test('leaves a non-file URI alone', () => {
    expect(uriToPath('untitled:Untitled-1')).toBe('untitled:Untitled-1')
  })
})

describe('language detection', () => {
  test('maps extensions to LSP language ids', () => {
    expect(languageOf('src/main.ts')).toBe('typescript')
    expect(languageOf('src/App.tsx')).toBe('typescriptreact')
    expect(languageOf('main.rs')).toBe('rust')
    expect(languageOf('app.py')).toBe('python')
    expect(languageOf('main.go')).toBe('go')
  })

  test('recognizes files named rather than extended', () => {
    expect(languageOf('/project/Dockerfile')).toBe('dockerfile')
    expect(languageOf('/project/Makefile')).toBe('makefile')
    expect(languageOf('/project/Gemfile')).toBe('ruby')
  })

  test('returns undefined for an unknown type', () => {
    expect(languageOf('notes.xyz')).toBeUndefined()
    expect(languageOf('LICENSE')).toBeUndefined()
  })

  test('extracts extensions, lowercased', () => {
    expect(extensionOf('src/Main.TS')).toBe('.ts')
    expect(extensionOf('Makefile')).toBe('')
  })
})

describe('root detection', () => {
  test('finds the nearest marker walking upward', () => {
    const dir = workspace({
      'package.json': '{}',
      'packages/app/package.json': '{}',
      'packages/app/src/index.ts': 'export {}',
    })
    // The inner package wins: that is what makes a monorepo get one server per
    // package rather than one rooted at the repository.
    expect(findRoot(join(dir, 'packages/app/src'), ['package.json'])).toBe(
      join(dir, 'packages', 'app'),
    )
  })

  test('returns undefined when no marker exists below the ceiling', () => {
    const dir = workspace({ 'src/index.ts': 'export {}' })
    expect(findRoot(join(dir, 'src'), ['deno.json'], dir)).toBeUndefined()
  })
})

describe('server selection', () => {
  test('every bundled server is well formed', () => {
    for (const spec of BUILTIN_SERVERS) {
      expect(spec.id).toMatch(/^[a-z0-9-]+$/)
      expect(spec.command.length).toBeGreaterThan(0)
      expect(spec.extensions.length).toBeGreaterThan(0)
      expect(spec.rootMarkers.length).toBeGreaterThan(0)
      // A missing dot would silently never match.
      for (const extension of spec.extensions) expect(extension.startsWith('.')).toBe(true)
    }
  })

  test('bundled server ids are unique', () => {
    const ids = BUILTIN_SERVERS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('deno outranks typescript, so a Deno project is not served by tsserver', () => {
    const deno = BUILTIN_SERVERS.find((s) => s.id === 'deno')!
    const ts = BUILTIN_SERVERS.find((s) => s.id === 'typescript')!
    expect(deno.priority ?? 0).toBeGreaterThan(ts.priority ?? 0)
    // And it only claims a project that is actually Deno.
    expect(deno.rootMarkers).toContain('deno.json')
  })

  test('no server is chosen when the root marker is absent', async () => {
    const dir = workspace({ 'stray.rs': 'fn main() {}' })
    // No Cargo.toml anywhere below the ceiling, so rust-analyzer must not claim it.
    expect(await serverFor(join(dir, 'stray.rs'), dir)).toBeUndefined()
  })

  test('a file with no known extension matches nothing', async () => {
    const dir = workspace({ notes: 'hello' })
    expect(await serverFor(join(dir, 'notes'), dir)).toBeUndefined()
  })
})

describe('the LSP transport', () => {
  function connect(): { connection: Connection; stop: () => void } {
    const child = spawn('bun', [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })
    return { connection: new Connection(child), stop: () => child.kill() }
  }

  test('completes a request/response round trip', async () => {
    const { connection, stop } = connect()
    try {
      const result = (await connection.request('echo', { value: 42 })) as { value: number }
      expect(result.value).toBe(42)
    } finally {
      stop()
    }
  })

  test('reassembles a body larger than one chunk', async () => {
    const { connection, stop } = connect()
    try {
      // Far past a pipe's buffer, so the reader must stitch chunks together.
      const big = 'x'.repeat(500_000)
      const result = (await connection.request('echo', { value: big })) as { value: string }
      expect(result.value.length).toBe(big.length)
    } finally {
      stop()
    }
  })

  test('handles several messages arriving in one chunk', async () => {
    const { connection, stop } = connect()
    try {
      const results = await Promise.all([
        connection.request('echo', { value: 1 }),
        connection.request('echo', { value: 2 }),
        connection.request('echo', { value: 3 }),
      ])
      // Correlation by id is what keeps these from being mixed up.
      expect(results.map((r) => (r as { value: number }).value)).toEqual([1, 2, 3])
    } finally {
      stop()
    }
  })

  test('counts Content-Length in bytes, not characters', async () => {
    const { connection, stop } = connect()
    try {
      // Every one of these is multi-byte in UTF-8; a character count truncates.
      const text = '日本語テキスト — émoji 🎉 ünïcödé'
      const result = (await connection.request('echo', { value: text })) as { value: string }
      expect(result.value).toBe(text)
    } finally {
      stop()
    }
  })

  test('surfaces a server-side error as a rejection', async () => {
    const { connection, stop } = connect()
    try {
      await expect(connection.request('fail')).rejects.toThrow(/deliberate failure/)
    } finally {
      stop()
    }
  })

  test('times out rather than hanging on a silent server', async () => {
    const { connection, stop } = connect()
    try {
      await expect(connection.request('never', {}, 300)).rejects.toThrow(/timed out/)
    } finally {
      stop()
    }
  })

  test('delivers notifications to listeners', async () => {
    const { connection, stop } = connect()
    try {
      const seen: unknown[] = []
      connection.onNotification((method, params) => {
        if (method === 'test/notify') seen.push(params)
      })
      await connection.request('emitNotification', { text: 'hello' })
      await new Promise((r) => setTimeout(r, 200))
      expect(seen).toEqual([{ text: 'hello' }])
    } finally {
      stop()
    }
  })

  test('writing to a dead server fails cleanly rather than crashing', async () => {
    const { connection, stop } = connect()
    stop()
    await new Promise((r) => setTimeout(r, 200))

    // Unguarded, this write throws EPIPE and takes the process down — a dead
    // language server must not be able to kill the agent.
    connection.notify('textDocument/didOpen', { textDocument: { uri: 'file:///x' } })
    await expect(connection.request('echo', { value: 1 }, 500)).rejects.toThrow()
  })

  test('rejects everything outstanding when the server exits', async () => {
    const { connection, stop } = connect()
    const pending = connection.request('never', {}, 10_000)
    await new Promise((r) => setTimeout(r, 150))
    stop()
    // Without this the agent would wait the full timeout on a dead server.
    await expect(pending).rejects.toThrow()
  })
})

describe('client lifecycle', () => {
  test('a server that is not installed is reported by name, without crashing', async () => {
    const errors: string[] = []
    const client = new LspClient({
      spec: { id: 'missing', command: ['jean-no-such-language-server'], extensions: ['.ts'] } as never,
      root: tmpdir(),
      onError: (message) => errors.push(message),
    })
    expect(await client.start()).toBe(false)
    expect(errors.join('\n')).toMatch(/could not start missing: .*(not found|ENOENT)/i)
  })

  test('stopping forgets open documents, so a restarted server gets didOpen again', () => {
    const client = new LspClient({ spec: { id: 'x', command: ['x'], extensions: ['.ts'] } as never, root: tmpdir() })
    const open = (client as unknown as { open: Map<string, unknown> }).open
    open.set('/p/a.ts', { version: 3, text: 'x' })
    client.stop()
    expect(open.size).toBe(0)
  })
})
