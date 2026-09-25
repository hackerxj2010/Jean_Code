/**
 * A unified diff between two versions of a file, for the edit card.
 *
 * Jean's `edit` hands back the file before and after rather than a patch, so
 * the card builds one. The common head and tail are trimmed first — an edit
 * usually touches a small region — and only the middle goes through the LCS
 * table, which keeps a large file with a small change cheap.
 */

export interface DiffStats {
  added: number
  removed: number
}

type Op = { kind: ' ' | '+' | '-'; text: string; oldLine: number; newLine: number }

/** Past this many cells the table is skipped and the middle shown as replaced. */
const MAX_TABLE_CELLS = 4_000_000

function diffOps(before: string[], after: string[]): Op[] {
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++
  }

  const a = before.slice(head, before.length - tail)
  const b = after.slice(head, after.length - tail)
  const ops: Op[] = []
  for (let i = 0; i < head; i++)
    ops.push({ kind: ' ', text: before[i]!, oldLine: i + 1, newLine: i + 1 })

  if (a.length * b.length > MAX_TABLE_CELLS) {
    a.forEach((text, i) => ops.push({ kind: '-', text, oldLine: head + i + 1, newLine: head }))
    b.forEach((text, j) => ops.push({ kind: '+', text, oldLine: head, newLine: head + j + 1 }))
  } else {
    const n = a.length
    const m = b.length
    const lcs = new Uint32Array((n + 1) * (m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * (m + 1) + j] =
          a[i] === b[j]
            ? lcs[(i + 1) * (m + 1) + j + 1]! + 1
            : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        ops.push({ kind: ' ', text: a[i]!, oldLine: head + i + 1, newLine: head + j + 1 })
        i++
        j++
      } else if (i < n && (j === m || lcs[(i + 1) * (m + 1) + j]! >= lcs[i * (m + 1) + j + 1]!)) {
        // Removals first, as `diff` prints them.
        ops.push({ kind: '-', text: a[i]!, oldLine: head + i + 1, newLine: head + j })
        i++
      } else {
        ops.push({ kind: '+', text: b[j]!, oldLine: head + i, newLine: head + j + 1 })
        j++
      }
    }
  }

  const tailStartOld = before.length - tail
  const tailStartNew = after.length - tail
  for (let k = 0; k < tail; k++) {
    ops.push({
      kind: ' ',
      text: before[tailStartOld + k]!,
      oldLine: tailStartOld + k + 1,
      newLine: tailStartNew + k + 1,
    })
  }
  return ops
}

/**
 * Unified-diff hunks (`@@` headers, then ` `/`+`/`-` lines) with `context`
 * unchanged lines around each change. Empty when nothing changed.
 */
export function unifiedDiff(before: string, after: string, context = 2): string {
  if (before === after) return ''
  const ops = diffOps(before.split('\n'), after.split('\n'))

  const changed = ops.map((op, index) => (op.kind === ' ' ? -1 : index)).filter((i) => i >= 0)
  if (changed.length === 0) return ''

  const out: string[] = []
  let start = Math.max(0, changed[0]! - context)
  let end = Math.min(ops.length - 1, changed[0]! + context)

  const flush = () => {
    const slice = ops.slice(start, end + 1)
    const first = slice[0]!
    const oldCount = slice.filter((op) => op.kind !== '+').length
    const newCount = slice.filter((op) => op.kind !== '-').length
    const oldStart = first.kind === '+' ? first.oldLine + 1 : first.oldLine
    const newStart = first.kind === '-' ? first.newLine + 1 : first.newLine
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const op of slice) out.push(`${op.kind}${op.text}`)
  }

  for (const index of changed.slice(1)) {
    if (index - context <= end + 1) {
      end = Math.min(ops.length - 1, index + context)
    } else {
      flush()
      start = Math.max(0, index - context)
      end = Math.min(ops.length - 1, index + context)
    }
  }
  flush()
  return out.join('\n')
}

export function diffStats(diff: string): DiffStats {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}
