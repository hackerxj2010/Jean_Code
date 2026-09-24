import type { LspClient, Location, Position, Range } from './client.ts'
import { pathToUri, uriToPath } from './protocol.ts'

/**
 * The remaining LSP operations (architecture §8.3).
 *
 * Split from `client.ts` to keep that file about the connection lifecycle;
 * these are all requests over an already-established one.
 */

export interface TextEdit {
  range: Range
  newText: string
}

export interface CodeAction {
  title: string
  kind?: string
  /** Edits the action would make, by path. */
  edits: Map<string, TextEdit[]>
  /** A command the server runs instead of returning edits. */
  command?: { command: string; title: string; arguments?: unknown[] }
  isPreferred?: boolean
}

export interface CodeLens {
  range: Range
  title?: string
  command?: string
}

/**
 * Rename edits triggered by moving files.
 *
 * This is the operation that makes a file move safe: barrel files, re-exports,
 * and aliased imports all reference the old path, and a plain `git mv` leaves
 * every one of them broken. Servers compute the fix-ups from their own
 * resolution graph, which nothing outside the language's toolchain can do
 * correctly.
 */
export async function willRenameFiles(
  client: LspClient,
  renames: { from: string; to: string }[],
): Promise<Map<string, TextEdit[]>> {
  const edits = new Map<string, TextEdit[]>()
  if (!client.supports('workspace')) return edits

  const raw = (await client.rawRequest('workspace/willRenameFiles', {
    files: renames.map((r) => ({ oldUri: pathToUri(r.from), newUri: pathToUri(r.to) })),
    // Servers can take a while: this walks the whole import graph.
  }, 30_000)) as WorkspaceEdit | undefined

  return collectWorkspaceEdit(raw, edits)
}

/** Code actions available for a range — quick fixes, refactors, organize imports. */
export async function codeActions(
  client: LspClient,
  path: string,
  range: Range,
  only?: string[],
): Promise<CodeAction[]> {
  await client.openOrUpdate(path)

  // The server needs the diagnostics in context to offer fixes for them.
  const diagnostics = client
    .allDiagnostics()
    .filter((d) => d.path === path && overlaps(d.range, range))
    .map((d) => ({ range: d.range, message: d.message, severity: severityNumber(d.severity) }))

  const raw = (await client.rawRequest('textDocument/codeAction', {
    textDocument: { uri: pathToUri(path) },
    range,
    context: { diagnostics, only },
  })) as unknown[] | undefined

  if (!Array.isArray(raw)) return []

  return raw.map((node) => {
    const action = node as {
      title: string
      kind?: string
      edit?: WorkspaceEdit
      command?: { command: string; title: string; arguments?: unknown[] }
      isPreferred?: boolean
    }
    return {
      title: action.title,
      kind: action.kind,
      edits: collectWorkspaceEdit(action.edit, new Map()),
      command: action.command,
      isPreferred: action.isPreferred,
    }
  })
}

/** Code lenses for a file — reference counts, run/debug affordances. */
export async function codeLenses(client: LspClient, path: string): Promise<CodeLens[]> {
  await client.openOrUpdate(path)

  const raw = (await client.rawRequest('textDocument/codeLens', {
    textDocument: { uri: pathToUri(path) },
  })) as unknown[] | undefined

  if (!Array.isArray(raw)) return []
  return raw.map((node) => {
    const lens = node as { range: Range; command?: { title: string; command: string } }
    return { range: lens.range, title: lens.command?.title, command: lens.command?.command }
  })
}

/**
 * Formats a document, returning edits rather than applying them.
 *
 * Returning edits keeps writing behind the tool layer's permission gate, and
 * lets the caller show the change before it lands.
 */
export async function formatting(
  client: LspClient,
  path: string,
  options: { tabSize?: number; insertSpaces?: boolean } = {},
): Promise<TextEdit[]> {
  await client.openOrUpdate(path)

  const raw = (await client.rawRequest('textDocument/formatting', {
    textDocument: { uri: pathToUri(path) },
    options: {
      tabSize: options.tabSize ?? 2,
      insertSpaces: options.insertSpaces ?? true,
      trimTrailingWhitespace: true,
      insertFinalNewline: true,
    },
  })) as TextEdit[] | undefined

  return Array.isArray(raw) ? raw : []
}

/** Formats one range rather than the whole file. */
export async function rangeFormatting(
  client: LspClient,
  path: string,
  range: Range,
  options: { tabSize?: number; insertSpaces?: boolean } = {},
): Promise<TextEdit[]> {
  await client.openOrUpdate(path)

  const raw = (await client.rawRequest('textDocument/rangeFormatting', {
    textDocument: { uri: pathToUri(path) },
    range,
    options: {
      tabSize: options.tabSize ?? 2,
      insertSpaces: options.insertSpaces ?? true,
    },
  })) as TextEdit[] | undefined

  return Array.isArray(raw) ? raw : []
}

/** Declaration, which differs from definition in C-family languages. */
export async function declaration(
  client: LspClient,
  path: string,
  position: Position,
): Promise<Location[]> {
  await client.openOrUpdate(path)
  const raw = await client.rawRequest('textDocument/declaration', {
    textDocument: { uri: pathToUri(path) },
    position,
  })
  return toLocations(raw)
}

/** The call hierarchy into a symbol — who calls this. */
export async function incomingCalls(
  client: LspClient,
  path: string,
  position: Position,
): Promise<{ name: string; path: string; range: Range }[]> {
  await client.openOrUpdate(path)

  const prepared = (await client.rawRequest('textDocument/prepareCallHierarchy', {
    textDocument: { uri: pathToUri(path) },
    position,
  })) as unknown[] | undefined

  if (!Array.isArray(prepared) || prepared.length === 0) return []

  const calls = (await client.rawRequest('callHierarchy/incomingCalls', {
    item: prepared[0],
  })) as unknown[] | undefined

  if (!Array.isArray(calls)) return []
  return calls.map((node) => {
    const call = node as { from: { name: string; uri: string; range: Range } }
    return {
      name: call.from.name,
      path: uriToPath(call.from.uri),
      range: call.from.range,
    }
  })
}

/** The call hierarchy out of a symbol — what this calls. */
export async function outgoingCalls(
  client: LspClient,
  path: string,
  position: Position,
): Promise<{ name: string; path: string; range: Range }[]> {
  await client.openOrUpdate(path)

  const prepared = (await client.rawRequest('textDocument/prepareCallHierarchy', {
    textDocument: { uri: pathToUri(path) },
    position,
  })) as unknown[] | undefined

  if (!Array.isArray(prepared) || prepared.length === 0) return []

  const calls = (await client.rawRequest('callHierarchy/outgoingCalls', {
    item: prepared[0],
  })) as unknown[] | undefined

  if (!Array.isArray(calls)) return []
  return calls.map((node) => {
    const call = node as { to: { name: string; uri: string; range: Range } }
    return { name: call.to.name, path: uriToPath(call.to.uri), range: call.to.range }
  })
}

interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>
  documentChanges?: (
    | { textDocument: { uri: string }; edits: TextEdit[] }
    | { kind: 'rename' | 'create' | 'delete' }
  )[]
}

/**
 * Flattens the two shapes a `WorkspaceEdit` can take.
 *
 * `documentChanges` also carries file create/rename/delete operations, which
 * are skipped here: this returns text edits, and the caller performs file
 * operations through the tool layer where they are gated and audited.
 */
function collectWorkspaceEdit(
  raw: WorkspaceEdit | undefined,
  into: Map<string, TextEdit[]>,
): Map<string, TextEdit[]> {
  if (!raw) return into

  for (const [uri, edits] of Object.entries(raw.changes ?? {})) {
    const path = uriToPath(uri)
    into.set(path, [...(into.get(path) ?? []), ...edits])
  }

  for (const change of raw.documentChanges ?? []) {
    if (!('textDocument' in change)) continue
    const path = uriToPath(change.textDocument.uri)
    into.set(path, [...(into.get(path) ?? []), ...change.edits])
  }

  return into
}

function toLocations(raw: unknown): Location[] {
  if (!raw) return []
  const list = Array.isArray(raw) ? raw : [raw]

  const out: Location[] = []
  for (const node of list) {
    const item = node as {
      uri?: string
      range?: Range
      targetUri?: string
      targetSelectionRange?: Range
    }
    const uri = item.uri ?? item.targetUri
    const range = item.range ?? item.targetSelectionRange
    if (uri && range) out.push({ path: uriToPath(uri), range })
  }
  return out
}

function overlaps(a: Range, b: Range): boolean {
  if (a.end.line < b.start.line || b.end.line < a.start.line) return false
  return true
}

function severityNumber(severity: string): number {
  return { error: 1, warning: 2, information: 3, hint: 4 }[severity] ?? 1
}

/**
 * Applies text edits to a string.
 *
 * Edits are applied back to front so earlier offsets stay valid — applying
 * forward shifts every later range by the length delta of the ones before it,
 * which silently corrupts the result rather than failing.
 */
export function applyEdits(text: string, edits: TextEdit[]): string {
  const lines = text.split('\n')

  const sorted = [...edits].sort((a, b) => {
    const line = b.range.start.line - a.range.start.line
    return line !== 0 ? line : b.range.start.character - a.range.start.character
  })

  for (const edit of sorted) {
    const { start, end } = edit.range
    if (start.line >= lines.length) continue

    const before = lines[start.line]!.slice(0, start.character)
    const endLine = Math.min(end.line, lines.length - 1)
    const after = lines[endLine]!.slice(end.character)

    const replacement = (before + edit.newText + after).split('\n')
    lines.splice(start.line, endLine - start.line + 1, ...replacement)
  }

  return lines.join('\n')
}
