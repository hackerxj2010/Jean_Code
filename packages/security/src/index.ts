/**
 * `@jean/security` — secret and dangerous-pattern detection.
 *
 * Catches the class of mistake an agent is most likely to introduce: a real key
 * written into a config file, SQL built by interpolation, a shell command
 * assembled from a variable. Not a replacement for a real static analyzer,
 * which needs the type information and dataflow a line scanner does not have.
 */

export {
  entropy,
  isFileSuppressed,
  isSuppressed,
  redact,
  scanForSecrets,
  type Confidence,
  type SecretFinding,
} from './secrets.ts'

export {
  listRules,
  scanForPatterns,
  type CodeFinding,
  type Severity,
} from './patterns.ts'

export {
  renderReport,
  scanDirectory,
  scanText,
  type ScanOptions,
  type ScanReport,
} from './scanner.ts'

export { createSecurityTools } from './tools.ts'
