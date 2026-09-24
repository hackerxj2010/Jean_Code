import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  describeDatabase,
  parseCsv,
  parseNotebook,
  queryDatabase,
  renderNotebook,
  renderRows,
} from '../packages/readers/src/index.ts'

const temps: string[] = []

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jean-read-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true })
})

describe('notebooks', () => {
  const notebook = JSON.stringify({
    metadata: { language_info: { name: 'python' } },
    cells: [
      { cell_type: 'markdown', source: ['# Title\n', 'Some text\n'] },
      {
        cell_type: 'code',
        execution_count: 1,
        source: ['import pandas as pd\n', 'df = pd.read_csv("x.csv")\n'],
        outputs: [{ output_type: 'stream', text: ['loaded 100 rows\n'] }],
      },
      {
        cell_type: 'code',
        execution_count: 2,
        source: ['1/0'],
        outputs: [
          {
            output_type: 'error',
            ename: 'ZeroDivisionError',
            evalue: 'division by zero',
            traceback: ['Traceback...', 'ZeroDivisionError'],
          },
        ],
      },
    ],
  })

  test('reads cells and the kernel language', () => {
    const { cells, language } = parseNotebook(notebook)
    expect(language).toBe('python')
    expect(cells).toHaveLength(3)
    expect(cells[0]!.type).toBe('markdown')
    expect(cells[1]!.executionCount).toBe(1)
  })

  test('joins source lines without doubling newlines', () => {
    // `.ipynb` source arrays carry their own newlines; joining with '\n' would
    // double every break — invisible until the agent edits the notebook.
    const { cells } = parseNotebook(notebook)
    expect(cells[1]!.source).toBe('import pandas as pd\ndf = pd.read_csv("x.csv")\n')
  })

  test('flattens stream and error outputs', () => {
    const { cells } = parseNotebook(notebook)
    expect(cells[1]!.outputs.join('')).toContain('loaded 100 rows')
    // The traceback is the useful part of an error.
    expect(cells[2]!.outputs.join('')).toContain('ZeroDivisionError')
    expect(cells[2]!.outputs.join('')).toContain('Traceback')
  })

  test('notes images rather than embedding them', () => {
    const withImage = JSON.stringify({
      cells: [
        {
          cell_type: 'code',
          source: ['plot()'],
          outputs: [{ output_type: 'display_data', data: { 'image/png': 'iVBORw0KG...' } }],
        },
      ],
    })
    const { cells } = parseNotebook(withImage)
    // Base64 of a plot is thousands of tokens the model cannot use.
    expect(cells[0]!.outputs.join('')).toContain('not shown')
    expect(cells[0]!.outputs.join('')).not.toContain('iVBORw0KG')
  })

  test('renders with cell numbers so it can be edited', () => {
    const { cells } = parseNotebook(notebook)
    const rendered = renderNotebook(cells)
    expect(rendered).toContain('cell 0')
    expect(rendered).toContain('cell 2')
  })

  test('reports a malformed notebook clearly', () => {
    expect(() => parseNotebook('{not json')).toThrow(/not a valid notebook/)
  })
})

describe('CSV', () => {
  test('parses simple rows', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  test('respects quoted fields containing the delimiter', () => {
    // `split(',')` misaligns here, silently.
    expect(parseCsv('name,note\n"Smith, John",ok\n')).toEqual([
      ['name', 'note'],
      ['Smith, John', 'ok'],
    ])
  })

  test('handles escaped quotes and embedded newlines', () => {
    expect(parseCsv('a\n"say ""hi"""\n')[1]).toEqual(['say "hi"'])
    expect(parseCsv('a\n"line1\nline2"\n')[1]).toEqual(['line1\nline2'])
  })

  test('tolerates CRLF', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('SQLite', () => {
  /** Builds a database using whichever binding the runtime provides. */
  async function makeDatabase(path: string): Promise<boolean> {
    const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
    try {
      if (isBun) {
        const { Database } = await import('bun:sqlite')
        const db = new Database(path)
        db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)')
        db.run("INSERT INTO users (name, age) VALUES ('alice', 30), ('bob', 25)")
        db.close()
        return true
      }
      return false
    } catch {
      return false
    }
  }

  test('describes tables and columns', async () => {
    const path = join(workspace(), 'test.db')
    if (!(await makeDatabase(path))) return

    const tables = await describeDatabase(path)
    expect(tables).toHaveLength(1)
    expect(tables[0]!.name).toBe('users')
    expect(tables[0]!.rowCount).toBe(2)

    const id = tables[0]!.columns.find((c) => c.name === 'id')!
    expect(id.primaryKey).toBe(true)
    expect(tables[0]!.columns.find((c) => c.name === 'name')!.notNull).toBe(true)
  })

  test('runs a read-only query', async () => {
    const path = join(workspace(), 'test.db')
    if (!(await makeDatabase(path))) return

    const rows = await queryDatabase(path, 'SELECT name FROM users ORDER BY name')
    expect(rows.map((r) => r.name)).toEqual(['alice', 'bob'])
  })

  test('refuses statements that would modify data', async () => {
    const path = join(workspace(), 'test.db')
    if (!(await makeDatabase(path))) return

    await expect(queryDatabase(path, 'DELETE FROM users')).rejects.toThrow(/read-only/)
    await expect(queryDatabase(path, 'DROP TABLE users')).rejects.toThrow(/read-only/)
    await expect(queryDatabase(path, "UPDATE users SET name='x'")).rejects.toThrow(/read-only/)
  })

  test('refuses several statements in one string', async () => {
    const path = join(workspace(), 'test.db')
    if (!(await makeDatabase(path))) return

    // Stacking statements is how a read-only check gets bypassed.
    await expect(
      queryDatabase(path, 'SELECT 1; DROP TABLE users'),
    ).rejects.toThrow(/one statement/)
  })

  test('caps rows when the query has no LIMIT', async () => {
    const path = join(workspace(), 'test.db')
    if (!(await makeDatabase(path))) return

    expect(await queryDatabase(path, 'SELECT * FROM users', 1)).toHaveLength(1)
  })
})

describe('row rendering', () => {
  test('aligns columns', () => {
    const rendered = renderRows([
      { id: 1, name: 'alice' },
      { id: 22, name: 'b' },
    ])
    expect(rendered).toContain('id')
    expect(rendered).toContain('alice')
    // A rule separates the header from the body.
    expect(rendered.split('\n')[1]).toMatch(/^-+\s+-+$/)
  })

  test('shows NULL rather than an empty cell', () => {
    expect(renderRows([{ a: null }])).toContain('NULL')
  })

  test('summarizes a blob instead of dumping bytes', () => {
    expect(renderRows([{ data: new Uint8Array(500) }])).toContain('500 bytes')
  })

  test('reports no rows', () => {
    expect(renderRows([])).toBe('(no rows)')
  })
})
