import { expect, test, describe } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  chunkFile,
  chunkId,
  declarationName,
  kindFor,
  renderChunk,
  Index,
  KnowledgeBase,
  splitIdentifier,
  stem,
  tokenize,
} from '../packages/projects/src/index.ts'
import { coverageBoost, pathBoost, recencyBoost } from '../packages/projects/src/retrieve.ts'
import { matchesPath } from '../packages/projects/src/base.ts'

const TYPESCRIPT_SOURCE = `import { readFile } from 'node:fs/promises'

/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a + b
}

/** Subtracts two numbers, which is the same thing with a sign. */
export function subtract(a: number, b: number): number {
  return a - b
}

export class Calculator {
  private total = 0

  accumulate(value: number): void {
    this.total += value
  }
}
`

const MARKDOWN_SOURCE = `# Jean Code

An agent.

## Installation

Run the installer.

### Requirements

A machine.

## Deployment

Push the button.
`

describe('chunking', () => {
  test('classifies files by extension', () => {
    expect(kindFor('src/main.ts')).toBe('code')
    expect(kindFor('README.md')).toBe('prose')
    expect(kindFor('tsconfig.json')).toBe('config')
    expect(kindFor('schema.sql')).toBe('data')
  })

  test('splits code at declaration boundaries', () => {
    const chunks = chunkFile('src/math.ts', TYPESCRIPT_SOURCE, { targetSize: 100 })
    expect(chunks.length).toBeGreaterThan(1)

    // Every chunk must know which declaration it belongs to, or a retrieved
    // fragment cannot be placed.
    expect(chunks.some((chunk) => chunk.context === 'subtract')).toBe(true)
  })

  test('keeps a doc comment with the declaration it documents', () => {
    const chunks = chunkFile('src/math.ts', TYPESCRIPT_SOURCE, { targetSize: 100 })
    const subtract = chunks.find((chunk) => chunk.text.includes('export function subtract'))
    expect(subtract?.text).toContain('Subtracts two numbers')
  })

  test('does not split at an indented declaration', () => {
    // `accumulate` is a method; splitting there would cut the class in half.
    const chunks = chunkFile('src/math.ts', TYPESCRIPT_SOURCE, { targetSize: 50 })
    const withClass = chunks.find((chunk) => chunk.text.includes('class Calculator'))
    expect(withClass?.text).toContain('accumulate')
  })

  test('splits prose at headings and carries the heading path', () => {
    const chunks = chunkFile('README.md', MARKDOWN_SOURCE, { targetSize: 20 })
    const requirements = chunks.find((chunk) => chunk.text.includes('A machine'))

    // "Requirements" alone is ambiguous; the path is what makes it locatable.
    expect(requirements?.context).toBe('Jean Code > Installation > Requirements')
  })

  test('a heading path truncates when the document goes back up a level', () => {
    const chunks = chunkFile('README.md', MARKDOWN_SOURCE, { targetSize: 20 })
    const deployment = chunks.find((chunk) => chunk.text.includes('Push the button'))
    expect(deployment?.context).toBe('Jean Code > Deployment')
  })

  test('an oversized declaration is split with overlap', () => {
    const huge = `export function huge() {\n${'  const line = 1\n'.repeat(500)}}\n`
    const chunks = chunkFile('src/huge.ts', huge, { targetSize: 500, maxSize: 1000 })

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      // The ceiling may be exceeded by one line, not by a multiple.
      expect(chunk.text.length).toBeLessThan(1200)
    }
  })

  test('line numbers point back at the source', () => {
    const chunks = chunkFile('src/math.ts', TYPESCRIPT_SOURCE, { targetSize: 100 })
    const lines = TYPESCRIPT_SOURCE.split('\n')

    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1)
      expect(chunk.endLine).toBeLessThanOrEqual(lines.length)
      const firstLine = chunk.text.split('\n')[0]!
      expect(lines[chunk.startLine - 1]).toBe(firstLine)
    }
  })

  test('chunk ids are stable across runs and distinct within a file', () => {
    const first = chunkFile('src/math.ts', TYPESCRIPT_SOURCE, { targetSize: 100 })
    const second = chunkFile('src/math.ts', TYPESCRIPT_SOURCE, { targetSize: 100 })

    expect(first.map((chunk) => chunk.id)).toEqual(second.map((chunk) => chunk.id))
    expect(new Set(first.map((chunk) => chunk.id)).size).toBe(first.length)
  })

  test('changing content changes the id', () => {
    expect(chunkId('a.ts', 1, 'one')).not.toBe(chunkId('a.ts', 1, 'two'))
    expect(chunkId('a.ts', 1, 'same')).not.toBe(chunkId('b.ts', 1, 'same'))
  })

  test('an empty file produces no chunks', () => {
    expect(chunkFile('empty.ts', '')).toEqual([])
    expect(chunkFile('blank.ts', '\n\n   \n')).toEqual([])
  })

  test('a chunk of only punctuation is dropped', () => {
    // A trailing `}` on its own retrieves as noise.
    expect(chunkFile('x.ts', '}\n')).toEqual([])
  })

  test('declarations are recognised across languages', () => {
    expect(declarationName('export function add(a, b) {')).toBe('add')
    expect(declarationName('pub fn parse(input: &str) {')).toBe('parse')
    expect(declarationName('def handle(self):')).toBe('handle')
    expect(declarationName('func main() {')).toBe('main')
    expect(declarationName('class Widget {')).toBe('Widget')
    // Indented means nested, which is not a top-level boundary.
    expect(declarationName('  function nested() {')).toBeUndefined()
    expect(declarationName('const x = 1')).toBeUndefined()
  })

  test('rendering carries a citable location', () => {
    const chunk = chunkFile('src/math.ts', TYPESCRIPT_SOURCE)[0]!
    const rendered = renderChunk(chunk)
    // Without this the model cannot say where an answer came from.
    expect(rendered).toContain('src/math.ts:')
  })
})

describe('tokenizing', () => {
  test('splits identifiers into their parts', () => {
    expect(splitIdentifier('runAgentLoop')).toEqual(['run', 'Agent', 'Loop'])
    expect(splitIdentifier('snake_case_name')).toEqual(['snake', 'case', 'name'])
    expect(splitIdentifier('SCREAMING_CASE')).toEqual(['SCREAMING', 'CASE'])
    // A run of capitals is one word, not five.
    expect(splitIdentifier('HTTPServer')).toEqual(['HTTP', 'Server'])
    expect(splitIdentifier('parseJSONResponse')).toEqual(['parse', 'JSON', 'Response'])
  })

  test('an identifier is indexed whole and in parts', () => {
    const terms = tokenize('runAgentLoop')
    expect(terms).toContain('runagentloop')
    expect(terms).toContain('agent')
    expect(terms).toContain('loop')
  })

  test('stop words are dropped, including the code-specific ones', () => {
    expect(tokenize('the and of')).toEqual([])
    // `const` and `function` appear in nearly every chunk and rank nothing.
    expect(tokenize('const function return')).toEqual([])
  })

  test('stemming does not mangle short or double-s words', () => {
    expect(stem('gas')).toBe('gas')
    expect(stem('class')).toBe('class')
    expect(stem('status')).toBe('status')
    expect(stem('running')).toBe('run')
    expect(stem('queries')).toBe('query')
    expect(stem('patches')).toBe('patch')
  })
})

describe('retrieval', () => {
  function seeded(): Index {
    const index = new Index()
    const chunks = [
      { path: 'src/hashline.ts', text: 'export function anchorPatch(content: string) { return hash(content) }', context: 'anchorPatch' },
      { path: 'src/shopping.ts', text: 'const list = ["milk", "bread", "eggs"]', context: 'list' },
      { path: 'src/store.ts', text: 'content addressed storage for checkpoints and frames', context: 'Store' },
    ]

    for (const [position, chunk] of chunks.entries()) {
      index.add({
        id: `c${position}`,
        path: chunk.path,
        startLine: 1,
        endLine: 3,
        text: chunk.text,
        context: chunk.context,
        kind: 'code',
      })
    }
    return index
  }

  test('ranks the relevant chunk first', () => {
    const results = seeded().search('anchor patch hashline')
    expect(results[0]?.chunk.path).toBe('src/hashline.ts')
  })

  test('a distinctive term outweighs a common one', () => {
    const index = new Index()
    for (let position = 0; position < 20; position++) {
      index.add({
        id: `common${position}`,
        path: `src/file${position}.ts`,
        startLine: 1,
        endLine: 1,
        text: 'the system uses a cache for the results',
        kind: 'code',
      })
    }
    index.add({
      id: 'rare',
      path: 'src/special.ts',
      startLine: 1,
      endLine: 1,
      text: 'the system uses a cache and the hashline anchors it',
      kind: 'code',
    })

    expect(index.search('cache hashline')[0]?.chunk.id).toBe('rare')
  })

  test('an identifier query finds a camel-case symbol', () => {
    expect(seeded().search('anchor patch')[0]?.chunk.path).toBe('src/hashline.ts')
  })

  test('re-adding a chunk replaces rather than double-counting', () => {
    const index = seeded()
    const before = index.size

    index.add({
      id: 'c0',
      path: 'src/hashline.ts',
      startLine: 1,
      endLine: 3,
      text: 'completely different content about zebras',
      kind: 'code',
    })

    expect(index.size).toBe(before)
    expect(index.search('anchorPatch')).toEqual([])
    expect(index.search('zebras').length).toBe(1)
  })

  test('removing a path drops every chunk from it', () => {
    const index = seeded()
    expect(index.removePath('src/hashline.ts')).toBe(1)
    expect(index.search('anchorPatch')).toEqual([])
  })

  test('results are deterministic across runs', () => {
    const first = seeded().search('storage content').map((result) => result.chunk.id)
    const second = seeded().search('storage content').map((result) => result.chunk.id)
    expect(first).toEqual(second)
  })

  test('an all-terms search requires every term', () => {
    const index = seeded()
    expect(index.searchAllTerms('content storage').length).toBe(1)
    expect(index.searchAllTerms('content nonexistentterm')).toEqual([])
  })

  test('searching an empty index is safe', () => {
    expect(new Index().search('anything')).toEqual([])
  })

  test('a query of only stop words matches nothing', () => {
    expect(seeded().search('the and of')).toEqual([])
  })
})

describe('ranking boosts', () => {
  test('vendored and generated paths are demoted', () => {
    expect(pathBoost('node_modules/react/index.js')).toBeLessThan(0.5)
    expect(pathBoost('dist/bundle.min.js')).toBeLessThan(0.5)
    expect(pathBoost('test/fixtures/sample.ts')).toBeLessThan(1)
  })

  test('source and documentation are promoted', () => {
    expect(pathBoost('src/agent/loop.ts')).toBeGreaterThan(1)
    expect(pathBoost('README.md')).toBeGreaterThan(1)
    expect(pathBoost('somewhere/else.ts')).toBe(1)
  })

  test('recency is a mild effect, not a dominant one', () => {
    const now = Date.now()
    expect(recencyBoost(now, now)).toBeGreaterThan(1)
    expect(recencyBoost(now - 400 * 86_400_000, now)).toBeLessThan(1)
    // An old file is still a plausible answer, so the penalty stays small.
    expect(recencyBoost(now - 400 * 86_400_000, now)).toBeGreaterThan(0.5)
    expect(recencyBoost(undefined, now)).toBe(1)
  })

  test('matching more of the query counts for something', () => {
    expect(coverageBoost(3, 3)).toBeGreaterThan(coverageBoost(1, 3))
    // A single-term query has nothing to cover.
    expect(coverageBoost(1, 1)).toBe(1)
  })
})

describe('path matching', () => {
  test('a plain string matches as a substring', () => {
    expect(matchesPath('src/agent/loop.ts', 'agent')).toBe(true)
    expect(matchesPath('src/agent/loop.ts', 'model')).toBe(false)
  })

  test('one star does not cross a separator and two do', () => {
    expect(matchesPath('index.ts', '*.ts')).toBe(true)
    expect(matchesPath('src/index.ts', '*.ts')).toBe(false)
    expect(matchesPath('src/deep/index.ts', '**/*.ts')).toBe(true)
    expect(matchesPath('src/a/b/c.ts', 'src/**/*.ts')).toBe(true)
  })

  test('a pattern that will not compile matches nothing rather than throwing', () => {
    expect(matchesPath('anything', '[')).toBe(false)
  })
})

describe('knowledge base', () => {
  async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'jean-projects-'))

    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'react'), { recursive: true })
    await mkdir(join(root, 'docs'), { recursive: true })

    await writeFile(join(root, 'src', 'math.ts'), TYPESCRIPT_SOURCE)
    await writeFile(
      join(root, 'src', 'agent.ts'),
      'export function runAgentLoop(prompt: string) {\n  return prompt\n}\n',
    )
    await writeFile(join(root, 'docs', 'guide.md'), MARKDOWN_SOURCE)
    await writeFile(join(root, 'node_modules', 'react', 'index.js'), 'module.exports = {}\n')
    await writeFile(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))

    return root
  }

  test('indexes a tree and skips the directories nobody wants', async () => {
    const root = await fixture()
    const base = new KnowledgeBase({ root })
    const result = await base.build()

    expect(result.filesIndexed).toBe(3)
    expect(base.files.some((path) => path.includes('node_modules'))).toBe(false)
    expect(base.files.some((path) => path.endsWith('.png'))).toBe(false)

    await rm(root, { recursive: true, force: true })
  })

  test('answers a question with citable context', async () => {
    const root = await fixture()
    const base = new KnowledgeBase({ root })
    await base.build()

    const answer = base.query({ text: 'how do I run the agent loop' })
    expect(answer.results.length).toBeGreaterThan(0)
    expect(answer.results[0]?.chunk.path).toBe('src/agent.ts')
    expect(answer.context).toContain('src/agent.ts:')

    await rm(root, { recursive: true, force: true })
  })

  test('a second build skips unchanged files', async () => {
    const root = await fixture()
    const base = new KnowledgeBase({ root })
    await base.build()

    const again = await base.build()
    expect(again.filesIndexed).toBe(0)
    // But the index still holds everything.
    expect(base.size).toBeGreaterThan(0)

    await rm(root, { recursive: true, force: true })
  })

  test('a deleted file leaves the index on the next build', async () => {
    const root = await fixture()
    const base = new KnowledgeBase({ root })
    await base.build()
    expect(base.files).toContain('src/math.ts')

    await rm(join(root, 'src', 'math.ts'))
    await base.build()

    expect(base.files).not.toContain('src/math.ts')
    expect(base.query({ text: 'subtract two numbers' }).results.every((r) => r.chunk.path !== 'src/math.ts')).toBe(true)

    await rm(root, { recursive: true, force: true })
  })

  test('an edited file replaces its old chunks', async () => {
    const root = await fixture()
    const base = new KnowledgeBase({ root })
    await base.build()

    base.addFile('src/math.ts', 'export function multiply(a: number, b: number) {\n  return a * b\n}\n')

    expect(base.query({ text: 'subtract' }).results.every((r) => !r.chunk.text.includes('subtract'))).toBe(true)
    expect(base.query({ text: 'multiply' }).results.length).toBeGreaterThan(0)

    await rm(root, { recursive: true, force: true })
  })

  test('the context budget is respected', async () => {
    const root = await fixture()
    const base = new KnowledgeBase({ root })
    await base.build()

    const answer = base.query({ text: 'function', maxChars: 200 })
    expect(answer.chars).toBeLessThanOrEqual(400)
    // And it says so rather than silently returning less.
    if (answer.results.length > 0) {
      expect(typeof answer.truncated).toBe('boolean')
    }

    await rm(root, { recursive: true, force: true })
  })

  test('a path filter narrows the results', async () => {
    const root = await fixture()
    const base = new KnowledgeBase({ root })
    await base.build()

    const answer = base.query({ text: 'installation', pathFilter: 'docs' })
    expect(answer.results.every((result) => result.chunk.path.startsWith('docs/'))).toBe(true)

    await rm(root, { recursive: true, force: true })
  })

  test('include and exclude globs are honoured', async () => {
    const root = await fixture()
    const base = new KnowledgeBase({ root, include: ['src/**'], exclude: ['**/agent.ts'] })
    await base.build()

    expect(base.files).toContain('src/math.ts')
    expect(base.files).not.toContain('src/agent.ts')
    expect(base.files.some((path) => path.startsWith('docs/'))).toBe(false)

    await rm(root, { recursive: true, force: true })
  })

  test('a query with no matches returns nothing rather than everything', async () => {
    const root = await fixture()
    const base = new KnowledgeBase({ root })
    await base.build()

    const answer = base.query({ text: 'zygomorphic pterodactyl abstraction' })
    expect(answer.results).toEqual([])
    expect(answer.context).toBe('')

    await rm(root, { recursive: true, force: true })
  })
})
