import { readFile } from 'node:fs/promises'
import { git, status as gitStatus } from '@jean/git'
import { scanText, type ScanReport } from '@jean/security'
import { ToolError, type Tool, type ToolResult } from '@jean/tools'

/**
 * `@jean/review` — pre-commit review of the working tree.
 *
 * Gathers what a careful reviewer would look at before a change goes out: the
 * diff, what the change touches, and the mechanical problems a human would have
 * to spot by eye. It does not review *for* the agent — judgment about whether
 * the change is right belongs to the model reading this output. What it does is
 * make sure nothing mechanical is missed, and that the model is looking at the
 * whole change rather than the file it happens to remember editing.
 *
 * The habit this supports is the one that catches most real problems: read the
 * diff before claiming the work is done.
 */

export interface ReviewOptions {
  cwd: string
  /** Compare against this ref instead of the working tree. */
  base?: string
  /** Skip the security scan. */
  skipScan?: boolean
  signal?: AbortSignal
}

export interface ChangedFile {
  path: string
  added: number
  removed: number
  status: string
  /** True when the file has no test covering it, by name convention. */
  untested?: boolean
}

export interface ReviewReport {
  files: ChangedFile[]
  totalAdded: number
  totalRemoved: number
  diff: string
  scan: ScanReport
  /** Things worth the reviewer's attention, in the order they should be read. */
  observations: string[]
  branch?: string
}

/** Filenames that look like tests. */
function isTestFile(path: string): boolean {
  return /(?:^|[\\/])(?:tests?|__tests__|spec)[\\/]|\.(?:test|spec)\.[\w]+$|_test\.\w+$/.test(path)
}

/** Whether the tree contains a test that plausibly covers a file. */
function hasCompanionTest(path: string, allPaths: string[]): boolean {
  const base = path.split(/[\\/]/).pop()?.replace(/\.\w+$/, '')
  if (!base) return false
  return allPaths.some((other) => other !== path && isTestFile(other) && other.includes(base))
}

/**
 * Reviews the working tree, or a range against `base`.
 *
 * Everything here is derived from the diff rather than from what the agent
 * remembers doing — the two diverge exactly when it matters, because a change
 * made three turns ago is the one most likely to be forgotten.
 */
export async function review(options: ReviewOptions): Promise<ReviewReport> {
  const { cwd } = options

  const range = options.base ? [options.base] : []
  const numstat = await git(['diff', '--numstat', ...range], cwd)
  const diffText = await git(['diff', '--no-color', ...range], cwd)
  const branchResult = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)

  const files: ChangedFile[] = []
  let totalAdded = 0
  let totalRemoved = 0

  for (const line of numstat.stdout.split('\n').filter(Boolean)) {
    const [added, removed, path] = line.split('\t')
    if (!path) continue

    // A binary file reports `-` rather than a count.
    const addedCount = added === '-' ? 0 : Number(added) || 0
    const removedCount = removed === '-' ? 0 : Number(removed) || 0

    files.push({ path, added: addedCount, removed: removedCount, status: 'modified' })
    totalAdded += addedCount
    totalRemoved += removedCount
  }

  // Untracked files are part of the change even though `git diff` omits them,
  // and a new file with no test is exactly what a reviewer should see.
  if (!options.base) {
    for (const entry of await gitStatus(cwd)) {
      if (!entry.untracked) continue
      const text = await readFile(`${cwd}/${entry.path}`, 'utf8').catch(() => undefined)
      const lines = text ? text.split('\n').length : 0
      files.push({ path: entry.path, added: lines, removed: 0, status: 'new' })
      totalAdded += lines
    }
  }

  const paths = files.map((file) => file.path)
  for (const file of files) {
    if (isTestFile(file.path)) continue
    if (/\.(?:json|md|lock|toml|yaml|yml|txt)$/i.test(file.path)) continue
    file.untested = !hasCompanionTest(file.path, paths)
  }

  // The scan runs over the changed files only: a repository-wide scan reports
  // problems this change did not introduce, which is a different question.
  const scan: ScanReport = { secrets: [], code: [], filesScanned: 0, truncated: false }
  if (!options.skipScan) {
    for (const file of files) {
      const text = await readFile(`${cwd}/${file.path}`, 'utf8').catch(() => undefined)
      if (text === undefined) continue

      const report = scanText(text, file.path)
      scan.secrets.push(...report.secrets)
      scan.code.push(...report.code)
      scan.filesScanned++
    }
  }

  return {
    files,
    totalAdded,
    totalRemoved,
    diff: diffText.stdout,
    scan,
    observations: observe(files, scan, totalAdded),
    branch: branchResult.ok ? branchResult.stdout.trim() : undefined,
  }
}

/**
 * Notes worth raising, ordered by how much they should change the reviewer's
 * behaviour.
 *
 * Deliberately few. A checklist that fires on every change is read once and
 * skipped thereafter, so each of these earns its place by being wrong to ignore.
 */
function observe(files: ChangedFile[], scan: ScanReport, totalAdded: number): string[] {
  const notes: string[] = []

  const certain = scan.secrets.filter((finding) => finding.confidence === 'certain')
  if (certain.length > 0) {
    notes.push(
      `${certain.length} confirmed secret${certain.length === 1 ? '' : 's'} in the change. Do not commit this — and rotate the credential, because deleting the line does not remove it from history.`,
    )
  }

  const high = scan.code.filter((finding) => finding.severity === 'high')
  if (high.length > 0) {
    notes.push(`${high.length} high-severity issue${high.length === 1 ? '' : 's'} in the changed code.`)
  }

  const untested = files.filter((file) => file.untested)
  if (untested.length > 0 && files.some((file) => isTestFile(file.path)) === false) {
    notes.push(
      `No test files changed. ${untested.length} changed source file${untested.length === 1 ? ' has' : 's have'} no obvious test: ${untested.slice(0, 5).map((f) => f.path).join(', ')}.`,
    )
  }

  if (files.length > 25) {
    notes.push(
      `${files.length} files changed. A change this wide is hard to review as one unit — consider whether it is really one change.`,
    )
  }

  const generated = files.filter((file) =>
    /(?:^|[\\/])(?:dist|build|vendor|node_modules|target)[\\/]|\.(?:min\.js|lock)$/.test(file.path),
  )
  if (generated.length > 0) {
    notes.push(
      `${generated.length} generated or vendored file${generated.length === 1 ? '' : 's'} in the diff: ${generated.slice(0, 3).map((f) => f.path).join(', ')}. Check these are meant to be committed.`,
    )
  }

  if (totalAdded === 0 && files.length === 0) {
    notes.push('Nothing has changed in the working tree.')
  }

  return notes
}

/** Renders a report for the model. */
export function renderReview(report: ReviewReport, maxDiffChars = 40_000): string {
  if (report.files.length === 0) {
    return 'Nothing has changed in the working tree.'
  }

  const sections: string[] = [
    `${report.files.length} files changed, +${report.totalAdded} −${report.totalRemoved}${report.branch ? ` on ${report.branch}` : ''}`,
    '',
  ]

  // Observations first: they are the reason to read the rest.
  if (report.observations.length > 0) {
    sections.push('## Worth checking', '')
    for (const note of report.observations) sections.push(`  ${note}`)
    sections.push('')
  }

  sections.push('## Files', '')
  for (const file of report.files) {
    const marker = file.untested ? '  (no test)' : ''
    sections.push(`  ${file.status.padEnd(9)} +${file.added} −${file.removed}  ${file.path}${marker}`)
  }
  sections.push('')

  if (report.scan.secrets.length > 0 || report.scan.code.length > 0) {
    sections.push('## Scan', '')
    for (const finding of report.scan.secrets.slice(0, 20)) {
      sections.push(`  ${finding.confidence}  ${finding.path}:${finding.line}  ${finding.kind}`)
    }
    for (const finding of report.scan.code.slice(0, 30)) {
      sections.push(`  ${finding.severity.padEnd(6)} ${finding.path}:${finding.line}  ${finding.message}`)
    }
    sections.push('')
  }

  sections.push('## Diff', '')
  sections.push(
    report.diff.length > maxDiffChars
      ? `${report.diff.slice(0, maxDiffChars)}\n\n[diff truncated — read individual files with \`read\`]`
      : report.diff || '(no tracked changes; the files above are new)',
  )

  return sections.join('\n')
}

/** The review tool. */
export function createReviewTool(): Tool<{ base?: string; skipScan?: boolean }> {
  return {
    name: 'review',
    risk: 'read',
    description: [
      'Review the working tree before committing: the diff, what changed, and the',
      'mechanical problems worth catching.',
      '',
      'Run this before saying work is done. It shows the whole change rather than',
      'the files you happen to remember editing — which is the point, because a',
      'change made several turns ago is the one most likely to be forgotten.',
      '',
      'It reports leaked secrets, high-severity patterns, source files with no',
      'test, and generated files that may not belong in the commit. Judging',
      'whether the change is *right* is still your job.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'Compare against this ref rather than the working tree.' },
        skipScan: { type: 'boolean', description: 'Skip the security scan.' },
      },
    },
    summarize: (args) => (args.base ? `review against ${args.base}` : 'review changes'),

    async execute(args, context): Promise<ToolResult> {
      const repo = await git(['rev-parse', '--is-inside-work-tree'], context.cwd)
      if (!repo.ok) {
        throw new ToolError(
          'This directory is not a git repository, so there is no diff to review.',
          'Use `security_scan` to check the files directly.',
        )
      }

      const report = await review({
        cwd: context.cwd,
        base: args.base,
        skipScan: args.skipScan,
        signal: context.signal,
      })

      return {
        output: renderReview(report),
        // A confirmed secret makes this a failure, not information: the turn
        // must not continue as though the review passed.
        isError: report.scan.secrets.some((finding) => finding.confidence === 'certain'),
        display: {
          kind: 'review',
          files: report.files.length,
          added: report.totalAdded,
          removed: report.totalRemoved,
        },
      }
    },
  }
}
