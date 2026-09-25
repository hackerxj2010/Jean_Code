/**
 * `@jean/readers` — the extended `read` targets (architecture §8.1).
 *
 * Archives, notebooks, SQLite databases, CSV, PDFs, and files on other
 * machines over SSH: what an agent regularly meets and cannot usefully read
 * as raw local bytes. Each is parsed in-process
 * rather than shelled out to, because `unzip`, `tar`, and `sqlite3` behave
 * differently across platforms and none reliably exists on Windows.
 */

export {
  isArchive,
  readArchive,
  readTar,
  readZip,
  type ArchiveEntry,
} from './archive.ts'

export {
  describeDatabase,
  parseCsv,
  parseNotebook,
  queryDatabase,
  readCsv,
  renderNotebook,
  renderRows,
  type NotebookCell,
  type TableInfo,
} from './structured.ts'

export { createSqlTool } from './tool.ts'

export { extractPdfText, PdfError, type PdfText } from './pdf.ts'

export { parseSshPath, readSsh, sshCommand, type SshRead, type SshTarget } from './ssh.ts'
