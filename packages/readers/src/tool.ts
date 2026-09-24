import { queryDatabase, renderRows } from './structured.ts'

/**
 * The `sql` tool (architecture §8.1).
 *
 * Read-only by construction: the connection is opened read-only *and* the
 * statement is checked before it is sent. Either alone would do; both are
 * cheap, and the check is what produces an error naming the actual problem
 * rather than SQLite's "attempt to write a readonly database".
 */
export function createSqlTool(deps: {
  resolvePath: (path: string, context: unknown) => string
  displayPath: (absolute: string, context: unknown) => string
}) {
  return {
    name: 'sql',
    risk: 'read' as const,
    description: [
      'Run a read-only SQL query against a SQLite database file.',
      '',
      'Use `read` on the database first to see its tables and columns. Only',
      'SELECT, WITH, PRAGMA, and EXPLAIN are permitted — use a migration script',
      'to change data.',
    ].join('\n'),
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to the .db or .sqlite file.' },
        query: { type: 'string', description: 'A single read-only statement.' },
        limit: { type: 'integer', description: 'Row cap when the query has no LIMIT. Default 100.' },
      },
      required: ['path', 'query'],
    },
    summarize: (args: { query: string }) => `sql ${args.query.slice(0, 60)}`,

    async execute(
      args: { path: string; query: string; limit?: number },
      context: unknown,
    ): Promise<{ output: string; isError?: boolean }> {
      const absolute = deps.resolvePath(args.path, context)
      const shown = deps.displayPath(absolute, context)

      try {
        const rows = await queryDatabase(absolute, args.query, args.limit ?? 100)
        if (rows.length === 0) return { output: 'The query returned no rows.' }

        return {
          output: `${rows.length} row${rows.length === 1 ? '' : 's'} from ${shown}:\n\n${renderRows(rows)}`,
        }
      } catch (err) {
        return {
          output: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  }
}
