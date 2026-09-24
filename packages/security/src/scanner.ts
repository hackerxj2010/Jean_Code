import { readFile } from 'node:fs/promises'
import { walk } from '@jean/tools'
import { scanForSecrets, type SecretFinding } from './secrets.ts'
import { scanForPatterns, type CodeFinding, type Severity } from './patterns.ts'

/**
 * The repository scanner.
 *
 * Combines both detectors over a directory tree. The ordering rule that makes
 * the output usable: certain secrets first, then high-severity code findings,
 * then everything else — because a report whose first entry is a `low` finding
 * gets skimmed, and the real leak three screens down gets missed.
 */

export interface ScanOptions {
  /** Only scan paths matching this. */
  include?: RegExp
  /** Skip anything less severe than this. */
  minSeverity?: Severity
  /** Skip secret findings that are not certain. */
  certainOnly?: boolean
  maxFileBytes?: number
  signal?: AbortSignal
}

export interface ScanReport {
  secrets: SecretFinding[]
  code: CodeFinding[]
  filesScanned: number
  /** True when the scan stopped early. */
  truncated: boolean
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.rb': 'ruby',
  '.java': 'java',
  '.php': 'php',
  '.cs': 'csharp',
  '.sh': 'shell',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.toml': 'toml',
  '.tf': 'terraform',
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
const CONFIDENCE_ORDER = { certain: 0, likely: 1, possible: 2 } as const

/** Scans a directory tree. */
export async function scanDirectory(root: string, options: ScanOptions = {}): Promise<ScanReport> {
  const maxBytes = options.maxFileBytes ?? 1_000_000
  const secrets: SecretFinding[] = []
  const code: CodeFinding[] = []
  let filesScanned = 0
  let truncated = false

  for await (const entry of walk(root, { signal: options.signal, includeHidden: true })) {
    if (entry.isDir || entry.size > maxBytes) continue
    if (options.include && !options.include.test(entry.relPath)) continue

    const extension = (entry.relPath.match(/\.[^.\\/]+$/)?.[0] ?? '').toLowerCase()
    const name = entry.relPath.split('/').pop() ?? ''

    // Text files plus the dotfiles that commonly hold credentials, and nothing
    // else: a binary produces only entropy noise.
    const language = LANGUAGE_BY_EXTENSION[extension]
    const isCredentialFile = /^\.(env|npmrc|netrc|pypirc)/.test(name)
    if (!language && !isCredentialFile) continue

    const text = await readFile(entry.absPath, 'utf8').catch(() => undefined)
    if (text === undefined) continue

    filesScanned++
    secrets.push(...scanForSecrets(text, entry.relPath))
    if (language) code.push(...scanForPatterns(text, entry.relPath, language))

    // A repository with thousands of findings has a systemic problem this
    // cannot help with, and the full list helps nobody.
    if (secrets.length + code.length > 2000) {
      truncated = true
      break
    }
  }

  return {
    secrets: secrets
      .filter((finding) => !options.certainOnly || finding.confidence === 'certain')
      .sort(
        (a, b) =>
          CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] ||
          a.path.localeCompare(b.path),
      ),
    code: code
      .filter(
        (finding) =>
          !options.minSeverity ||
          SEVERITY_ORDER[finding.severity] <= SEVERITY_ORDER[options.minSeverity],
      )
      .sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.path.localeCompare(b.path),
      ),
    filesScanned,
    truncated,
  }
}

/** Scans one file's text. */
export function scanText(text: string, path: string): ScanReport {
  const extension = (path.match(/\.[^.\\/]+$/)?.[0] ?? '').toLowerCase()
  const language = LANGUAGE_BY_EXTENSION[extension]

  return {
    secrets: scanForSecrets(text, path),
    code: language ? scanForPatterns(text, path, language) : [],
    filesScanned: 1,
    truncated: false,
  }
}

/** Renders a report for the agent. */
export function renderReport(report: ScanReport): string {
  if (report.secrets.length === 0 && report.code.length === 0) {
    return `Nothing found across ${report.filesScanned} files.`
  }

  const sections: string[] = []

  if (report.secrets.length > 0) {
    sections.push(`## Secrets (${report.secrets.length})`, '')
    for (const finding of report.secrets.slice(0, 50)) {
      sections.push(
        `  ${finding.confidence.padEnd(8)} ${finding.path}:${finding.line}  ${finding.kind}`,
      )
      sections.push(`      ${finding.redacted}`)
    }
    if (report.secrets.length > 50) {
      sections.push(`  ... ${report.secrets.length - 50} more`)
    }
    sections.push('')
    sections.push(
      '  A committed secret stays in git history — rotate it rather than only deleting the line.',
    )
    sections.push('')
  }

  if (report.code.length > 0) {
    sections.push(`## Code (${report.code.length})`, '')
    for (const finding of report.code.slice(0, 60)) {
      sections.push(
        `  ${finding.severity.padEnd(6)} ${finding.path}:${finding.line}  ${finding.message}`,
      )
      sections.push(`      ${finding.snippet}`)
      sections.push(`      fix: ${finding.fix}`)
    }
    if (report.code.length > 60) {
      sections.push(`  ... ${report.code.length - 60} more`)
    }
  }

  if (report.truncated) {
    sections.push(
      '',
      'The scan stopped early: this repository has more findings than a report can usefully hold.',
    )
  }

  return sections.join('\n')
}
