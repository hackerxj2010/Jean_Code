import { readFile } from 'node:fs/promises'

/**
 * Structured-document readers (architecture §8.1).
 *
 * Notebooks, SQLite databases, and CSV. Each is a format an agent regularly
 * meets and cannot usefully read as raw bytes: a `.ipynb` is JSON with the code
 * buried in arrays of strings, and a `.db` is binary.
 */

// ---- Jupyter notebooks ----------------------------------------------------

export interface NotebookCell {
  index: number
  type: 'code' | 'markdown' | 'raw'
  source: string
  /** Text and error output, flattened. Images are noted but not included. */
  outputs: string[]
  executionCount?: number
}

/**
 * Reads a `.ipynb` into cells.
 *
 * Source arrives as an array of lines *with* their newlines, which is why it is
 * joined rather than newline-joined — doing the latter doubles every line
 * break, a mistake that is invisible until the agent edits the notebook.
 */
export function parseNotebook(text: string): { cells: NotebookCell[]; language?: string } {
  let parsed: {
    cells?: unknown[]
    metadata?: { kernelspec?: { language?: string }; language_info?: { name?: string } }
  }

  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch (err) {
    throw new Error(`not a valid notebook: ${err instanceof Error ? err.message : String(err)}`)
  }

  const language =
    parsed.metadata?.language_info?.name ?? parsed.metadata?.kernelspec?.language ?? undefined

  const cells: NotebookCell[] = (parsed.cells ?? []).map((raw, index) => {
    const cell = raw as {
      cell_type?: string
      source?: string | string[]
      outputs?: unknown[]
      execution_count?: number
    }

    const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '')

    return {
      index,
      type: (cell.cell_type as NotebookCell['type']) ?? 'raw',
      source,
      outputs: flattenOutputs(cell.outputs ?? []),
      executionCount: cell.execution_count ?? undefined,
    }
  })

  return { cells, language }
}

function flattenOutputs(outputs: unknown[]): string[] {
  const out: string[] = []

  for (const raw of outputs) {
    const output = raw as {
      output_type?: string
      text?: string | string[]
      data?: Record<string, unknown>
      ename?: string
      evalue?: string
      traceback?: string[]
    }

    if (output.output_type === 'stream' && output.text) {
      out.push(Array.isArray(output.text) ? output.text.join('') : output.text)
      continue
    }

    if (output.output_type === 'error') {
      // The traceback is the useful part; without it the agent sees only the
      // exception name and cannot tell where it came from.
      out.push(`${output.ename}: ${output.evalue}`)
      if (output.traceback) out.push(stripAnsi(output.traceback.join('\n')))
      continue
    }

    const data = output.data
    if (!data) continue

    const plain = data['text/plain']
    if (plain) {
      out.push(Array.isArray(plain) ? (plain as string[]).join('') : String(plain))
    }
    // Images are noted rather than included: base64 of a plot is thousands of
    // tokens of nothing the model can use.
    for (const key of Object.keys(data)) {
      if (key.startsWith('image/')) out.push(`[${key} output, not shown]`)
    }
  }

  return out
}

function stripAnsi(text: string): string {
  const escape = String.fromCharCode(27)
  return text.replace(new RegExp(`${escape}\\[[0-9;]*m`, 'g'), '')
}

/** Renders a notebook for display, with cell numbers so it can be edited. */
export function renderNotebook(
  cells: NotebookCell[],
  options: { maxOutputLines?: number } = {},
): string {
  const maxOutput = options.maxOutputLines ?? 15
  const sections: string[] = []

  for (const cell of cells) {
    const marker = cell.type === 'code' ? `[${cell.executionCount ?? ' '}]` : cell.type
    sections.push(`--- cell ${cell.index} (${marker}) ---`)
    sections.push(cell.source.trimEnd())

    if (cell.outputs.length > 0) {
      const text = cell.outputs.join('\n').split('\n')
      sections.push('  output:')
      for (const line of text.slice(0, maxOutput)) sections.push(`  ${line}`)
      if (text.length > maxOutput) sections.push(`  ... ${text.length - maxOutput} more lines`)
    }
    sections.push('')
  }

  return sections.join('\n')
}

// ---- SQLite ---------------------------------------------------------------

export interface TableInfo {
  name: string
  columns: { name: string; type: string; notNull: boolean; primaryKey: boolean }[]
  rowCount: number
}

/**
 * Opens a SQLite database.
 *
 * Resolves the binding at runtime — `bun:sqlite` under Bun, `node:sqlite` under
 * Node — because they are not interchangeable and neither exists in the other
 * runtime.
 */
async function openDatabase(path: string): Promise<{
  query: (sql: string) => unknown[]
  close: () => void
}> {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

  if (isBun) {
    const { Database } = (await import('bun:sqlite')) as {
      Database: new (path: string, options?: { readonly?: boolean }) => {
        query: (sql: string) => { all: () => unknown[] }
        close: () => void
      }
    }
    const db = new Database(path, { readonly: true })
    return { query: (sql) => db.query(sql).all(), close: () => db.close() }
  }

  const { DatabaseSync } = (await import('node:sqlite')) as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
      prepare: (sql: string) => { all: () => unknown[] }
      close: () => void
    }
  }
  const db = new DatabaseSync(path, { readOnly: true })
  return { query: (sql) => db.prepare(sql).all(), close: () => db.close() }
}

/** Lists a database's tables and their shapes. */
export async function describeDatabase(path: string): Promise<TableInfo[]> {
  const db = await openDatabase(path)

  try {
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ) as { name: string }[]

    return tables.map((table) => {
      const columns = db.query(`PRAGMA table_info("${table.name}")`) as {
        name: string
        type: string
        notnull: number
        pk: number
      }[]

      const counted = db.query(`SELECT COUNT(*) AS n FROM "${table.name}"`) as { n: number }[]

      return {
        name: table.name,
        columns: columns.map((column) => ({
          name: column.name,
          type: column.type || 'ANY',
          notNull: column.notnull === 1,
          primaryKey: column.pk > 0,
        })),
        rowCount: counted[0]?.n ?? 0,
      }
    })
  } finally {
    db.close()
  }
}

/**
 * Runs a read-only query.
 *
 * Statements that would modify the database are refused before they reach
 * SQLite. The connection is already read-only, so this is belt and braces —
 * but the error it produces names the problem, where SQLite's would not.
 */
export async function queryDatabase(
  path: string,
  sql: string,
  limit = 100,
): Promise<Record<string, unknown>[]> {
  const normalized = sql.trim().replace(/;+\s*$/, '')

  if (!/^\s*(select|with|pragma|explain)\b/i.test(normalized)) {
    throw new Error(
      'only read-only statements are allowed here (SELECT, WITH, PRAGMA, EXPLAIN). Use a migration or a script to change data.',
    )
  }
  if (/;/.test(normalized)) {
    // Several statements in one string is how a read-only check gets bypassed.
    throw new Error('only one statement at a time')
  }

  const db = await openDatabase(path)
  try {
    const wrapped = /\blimit\b/i.test(normalized) ? normalized : `${normalized} LIMIT ${limit}`
    return db.query(wrapped) as Record<string, unknown>[]
  } finally {
    db.close()
  }
}

/** Renders query rows as an aligned table. */
export function renderRows(rows: Record<string, unknown>[], maxWidth = 40): string {
  if (rows.length === 0) return '(no rows)'

  const columns = Object.keys(rows[0]!)
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return 'NULL'
    if (value instanceof Uint8Array) return `<${value.length} bytes>`
    const text = String(value)
    return text.length > maxWidth ? `${text.slice(0, maxWidth - 1)}…` : text
  }

  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => cell(row[column]).length)),
  )

  const header = columns.map((column, i) => column.padEnd(widths[i]!)).join('  ')
  const rule = widths.map((width) => '-'.repeat(width)).join('  ')
  const body = rows.map((row) =>
    columns.map((column, i) => cell(row[column]).padEnd(widths[i]!)).join('  '),
  )

  return [header, rule, ...body].join('\n')
}

// ---- CSV ------------------------------------------------------------------

/**
 * Parses CSV, respecting quotes.
 *
 * A `split(',')` implementation is wrong for any real file — quoted fields
 * routinely contain commas and newlines, and the failure is silent
 * misalignment rather than an error.
 */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
    } else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') {
      field += char
    }
  }

  if (field || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

/** Reads a CSV file and renders it as an aligned table with a row count. */
export async function readCsv(
  path: string,
  options: { limit?: number; delimiter?: string } = {},
): Promise<string> {
  const text = await readFile(path, 'utf8')
  const rows = parseCsv(text, options.delimiter)
  if (rows.length === 0) return '(empty)'

  const limit = options.limit ?? 50
  const header = rows[0]!
  const body = rows.slice(1, limit + 1)

  const asObjects = body.map((row) =>
    Object.fromEntries(header.map((column, i) => [column, row[i] ?? ''])),
  )

  const rendered = renderRows(asObjects)
  const total = rows.length - 1
  return total > body.length ? `${rendered}\n\n(${body.length} of ${total} rows)` : rendered
}
