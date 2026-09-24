import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  CodeMap,
  extractImports,
  extractSymbols,
  languageForFile,
  supportedLanguages,
} from '../packages/codemap/src/index.ts'

const temps: string[] = []

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'jean-map-'))
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

describe('language detection', () => {
  test('maps extensions to pattern sets', () => {
    expect(languageForFile('src/main.ts')).toBe('typescript')
    expect(languageForFile('main.rs')).toBe('rust')
    expect(languageForFile('app.py')).toBe('python')
    expect(languageForFile('server.go')).toBe('go')
  })

  test('returns undefined for files it cannot scan', () => {
    expect(languageForFile('README.md')).toBeUndefined()
    expect(languageForFile('data.json')).toBeUndefined()
  })

  test('every advertised language has patterns', () => {
    expect(supportedLanguages().length).toBeGreaterThan(10)
  })
})

describe('TypeScript extraction', () => {
  const source = [
    'export function calculate(a: number): number {',
    '  return a * 2',
    '}',
    '',
    'export class RateLimiter {',
    '  private counter = 0',
    '',
    '  constructor(private limit: number) {',
    '    super()',
    '  }',
    '',
    '  hit(): boolean {',
    '    if (this.counter > 0) return false',
    '    return true',
    '  }',
    '}',
    '',
    'export interface Options { limit: number }',
    'export type Mode = "a" | "b"',
    'const PRIVATE_HELPER = 42',
    'export const handler = async (req: Request) => req',
  ].join('\n')

  const symbols = extractSymbols(source, 'typescript')
  const find = (name: string) => symbols.find((s) => s.name === name)

  test('finds every declaration kind', () => {
    expect(find('calculate')?.kind).toBe('function')
    expect(find('RateLimiter')?.kind).toBe('class')
    expect(find('Options')?.kind).toBe('interface')
    expect(find('Mode')?.kind).toBe('type')
    expect(find('PRIVATE_HELPER')?.kind).toBe('constant')
  })

  test('treats an arrow function as a function, not a constant', () => {
    // Most modern code declares functions this way; classifying them as
    // constants would make the index far less useful.
    expect(find('handler')?.kind).toBe('function')
  })

  test('tracks export status', () => {
    expect(find('calculate')?.exported).toBe(true)
    expect(find('PRIVATE_HELPER')?.exported).toBe(false)
  })

  test('attributes methods to their class', () => {
    expect(find('hit')?.container).toBe('RateLimiter')
  })

  test('excludes control flow and super calls', () => {
    // `super(` and `if (` both match a "name followed by paren" pattern; without
    // exclusion the index fills with noise for the commonest words.
    for (const name of ['super', 'if', 'return', 'constructor()']) {
      expect(symbols.some((s) => s.name === name && s.kind !== 'method')).toBe(false)
    }
    expect(symbols.some((s) => s.name === 'super')).toBe(false)
    expect(symbols.some((s) => s.name === 'if')).toBe(false)
  })

  test('records line numbers and a signature', () => {
    expect(find('calculate')?.line).toBe(1)
    expect(find('calculate')?.signature).toContain('calculate')
  })
})

describe('other languages', () => {
  test('Rust, including visibility', () => {
    const symbols = extractSymbols(
      ['pub fn public_fn() {}', 'fn private_fn() {}', 'pub struct Config {}', 'pub trait Store {}'].join('\n'),
      'rust',
    )
    expect(symbols.find((s) => s.name === 'public_fn')?.exported).toBe(true)
    expect(symbols.find((s) => s.name === 'private_fn')?.exported).toBe(false)
    expect(symbols.find((s) => s.name === 'Config')?.kind).toBe('struct')
    expect(symbols.find((s) => s.name === 'Store')?.kind).toBe('trait')
  })

  test('Go exports by capitalization, not a keyword', () => {
    const symbols = extractSymbols(['func Exported() {}', 'func unexported() {}'].join('\n'), 'go')
    expect(symbols.find((s) => s.name === 'Exported')?.exported).toBe(true)
    expect(symbols.find((s) => s.name === 'unexported')?.exported).toBe(false)
  })

  test('Python functions, classes, and constants', () => {
    const symbols = extractSymbols(
      ['MAX_SIZE = 100', 'class Handler:', '    def process(self):', '        pass'].join('\n'),
      'python',
    )
    expect(symbols.find((s) => s.name === 'MAX_SIZE')?.kind).toBe('constant')
    expect(symbols.find((s) => s.name === 'Handler')?.kind).toBe('class')
    expect(symbols.find((s) => s.name === 'process')?.container).toBe('Handler')
  })
})

describe('comment handling', () => {
  test('skips declarations inside comments', () => {
    const source = [
      '// export function commented() {}',
      '/*',
      'export function blockCommented() {}',
      '*/',
      'export function real() {}',
    ].join('\n')

    const names = extractSymbols(source, 'typescript').map((s) => s.name)
    // A commented-out function reads exactly like a real one to a pattern.
    expect(names).toContain('real')
    expect(names).not.toContain('commented')
    expect(names).not.toContain('blockCommented')
  })
})

describe('import extraction', () => {
  test('finds ES and CommonJS imports', () => {
    const imports = extractImports(
      ["import { a } from './local'", "import b from 'package'", "const c = require('cjs')"].join('\n'),
      'typescript',
    )
    expect(imports).toContain('./local')
    expect(imports).toContain('package')
    expect(imports).toContain('cjs')
  })

  test('finds Python imports', () => {
    const imports = extractImports(['import os', 'from pathlib import Path'].join('\n'), 'python')
    expect(imports).toContain('os')
    expect(imports).toContain('pathlib')
  })
})

describe('the code map', () => {
  const project = {
    'src/rate-limit.ts': 'export class RateLimiter {\n  hit() { return true }\n}\n',
    'src/index.ts': "import { RateLimiter } from './rate-limit'\nexport function handle() {}\n",
    'src/util/format.ts': 'export function formatDate(d: Date) { return d }\n',
    'README.md': '# not indexed\n',
  }

  test('indexes files and symbols', async () => {
    const map = new CodeMap(workspace(project))
    const stats = await map.build()

    // README.md is not a scannable language.
    expect(stats.files).toBe(3)
    expect(stats.symbols).toBeGreaterThan(3)
    expect(map.isBuilt).toBe(true)
  })

  test('finds a symbol by name, ranking exact matches first', async () => {
    const map = new CodeMap(workspace(project))
    await map.build()

    const hits = map.findSymbol('RateLimiter')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.name).toBe('RateLimiter')
    expect(hits[0]!.path).toBe('src/rate-limit.ts')
  })

  test('ranks files by relevance to a described task', async () => {
    const map = new CodeMap(workspace(project))
    await map.build()

    const results = map.relevantFiles('rate limiter')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.path).toBe('src/rate-limit.ts')
    // The reason is shown so the agent can judge the suggestion.
    expect(results[0]!.why).toBeTruthy()
  })

  test('a symbol match outranks a mere path match', async () => {
    const map = new CodeMap(
      workspace({
        'src/format.ts': 'export const unrelated = 1\n',
        'src/other.ts': 'export function formatDate() {}\n',
      }),
    )
    await map.build()

    // A developer describing a task names the things it touches, so a symbol
    // hit is a much stronger signal than a filename hit.
    expect(map.relevantFiles('formatDate')[0]!.path).toBe('src/other.ts')
  })

  test('outlines one file', async () => {
    const map = new CodeMap(workspace(project))
    await map.build()
    expect(map.symbolsIn('src/rate-limit.ts').map((s) => s.name)).toContain('RateLimiter')
  })

  test('finds importers of a module', async () => {
    const map = new CodeMap(workspace(project))
    await map.build()
    expect(map.importersOf('./rate-limit')).toContain('src/index.ts')
  })

  test('summarizes the repository', async () => {
    const map = new CodeMap(workspace(project))
    await map.build()

    const overview = map.overview()
    expect(overview.totalFiles).toBe(3)
    expect(overview.languages[0]!.language).toBe('typescript')
    expect(overview.totalSymbols).toBeGreaterThan(0)
  })

  test('a rebuild drops files that no longer exist', async () => {
    const dir = workspace(project)
    const map = new CodeMap(dir)
    await map.build()
    expect(map.fileCount()).toBe(3)

    rmSync(join(dir, 'src', 'util', 'format.ts'))
    await map.build()

    // A deleted file must stop being suggested.
    expect(map.fileCount()).toBe(2)
    expect(map.findSymbol('formatDate')).toHaveLength(0)
  })

  test('refresh re-scans one file after an edit', async () => {
    const dir = workspace(project)
    const map = new CodeMap(dir)
    await map.build()
    expect(map.findSymbol('brandNew')).toHaveLength(0)

    writeFileSync(join(dir, 'src', 'index.ts'), 'export function brandNew() {}\n')
    await map.refresh(join(dir, 'src', 'index.ts'))

    expect(map.findSymbol('brandNew')).toHaveLength(1)
    // The old symbol is gone, not merely shadowed.
    expect(map.findSymbol('handle')).toHaveLength(0)
  })

  test('indexes a large file by name only', async () => {
    const dir = workspace({ 'src/huge.ts': `export const x = 1\n${'// filler\n'.repeat(200)}` })
    const map = new CodeMap(dir)
    await map.build({ maxFileBytes: 100 })

    // A generated bundle has thousands of "symbols", none worth attention.
    expect(map.fileCount()).toBe(1)
    expect(map.symbolsIn('src/huge.ts')).toHaveLength(0)
  })

  test('an empty query returns nothing rather than everything', async () => {
    const map = new CodeMap(workspace(project))
    await map.build()
    expect(map.relevantFiles('a')).toHaveLength(0)
  })
})
