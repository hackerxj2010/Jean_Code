/**
 * Secret detection.
 *
 * The failure this prevents is specific and common: an agent writes a config
 * file with a real key in it, or commits one that was already there, and the
 * secret ends up in git history where deleting it later does not help.
 *
 * Two detectors, because either alone is wrong. Named patterns catch known key
 * formats with near-zero false positives; entropy catches the ones nobody has a
 * pattern for. Entropy alone flags every hash, UUID, and minified bundle in the
 * repository, so it is heavily constrained here.
 */

export type Confidence = 'certain' | 'likely' | 'possible'

export interface SecretFinding {
  path: string
  line: number
  /** What kind of secret this looks like. */
  kind: string
  confidence: Confidence
  /** The line with the secret masked — never the secret itself. */
  redacted: string
  /** Why this was flagged, for a human deciding whether it is real. */
  reason: string
}

interface SecretPattern {
  kind: string
  regex: RegExp
  confidence: Confidence
  /** Extra check to suppress a known false-positive shape. */
  verify?: (match: string, line: string) => boolean
}

/**
 * Provider key formats.
 *
 * These are worth having exactly right: a real `sk-ant-` key has a fixed shape,
 * so matching it is certain rather than heuristic, and a certain finding can be
 * reported without hedging.
 */
const PATTERNS: SecretPattern[] = [
  { kind: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/g, confidence: 'certain' },
  { kind: 'AWS secret key', regex: /\baws_secret_access_key\s*[=:]\s*['"]?([A-Za-z0-9/+=]{40})/gi, confidence: 'certain' },
  { kind: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, confidence: 'certain' },
  { kind: 'GitHub fine-grained token', regex: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g, confidence: 'certain' },
  { kind: 'Anthropic key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, confidence: 'certain' },
  // The lookahead keeps this from also claiming `sk-ant-` and `sk-or-` keys,
  // which have their own patterns and would otherwise be reported twice.
  { kind: 'OpenAI key', regex: /\bsk-(?!ant-|or-)(?:proj-)?[A-Za-z0-9_-]{32,}/g, confidence: 'certain' },
  { kind: 'OpenRouter key', regex: /\bsk-or-v1-[A-Za-z0-9]{40,}/g, confidence: 'certain' },
  { kind: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, confidence: 'certain' },
  { kind: 'Slack token', regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g, confidence: 'certain' },
  { kind: 'Stripe key', regex: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{24,}/g, confidence: 'certain' },
  { kind: 'Twilio key', regex: /\bSK[0-9a-fA-F]{32}\b/g, confidence: 'likely' },
  { kind: 'SendGrid key', regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, confidence: 'certain' },
  { kind: 'npm token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g, confidence: 'certain' },
  { kind: 'private key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, confidence: 'certain' },
  { kind: 'JSON Web Token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, confidence: 'likely' },
  {
    kind: 'connection string with password',
    regex: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s]+:([^@\s]{6,})@/gi,
    confidence: 'certain',
    // `password`, `changeme`, and friends in a docker-compose file are examples,
    // not leaks, and flagging them trains people to ignore the scanner.
    verify: (match) => !/:(?:password|changeme|example|placeholder|secret|test|xxx+)@/i.test(match),
  },
  {
    kind: 'hardcoded password',
    regex: /\b(?:password|passwd|pwd)\s*[=:]\s*['"]([^'"\s]{8,})['"]/gi,
    confidence: 'possible',
    verify: (_match, line) => !isPlaceholder(line),
  },
  {
    kind: 'generic API key assignment',
    regex: /\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[=:]\s*['"]([^'"\s]{16,})['"]/gi,
    confidence: 'likely',
    verify: (_match, line) => !isPlaceholder(line),
  },
]

/**
 * Whether a line is obviously an example rather than a secret.
 *
 * The check that matters most: a value interpolated from the environment is the
 * *correct* pattern, and flagging `process.env.API_KEY` would make the scanner
 * fire on exactly the code that does the right thing.
 */
function isPlaceholder(line: string): boolean {
  return (
    /process\.env|import\.meta\.env|os\.environ|System\.getenv|ENV\[/.test(line) ||
    /\$\{|\{\{|<%|%s\b|\$[A-Z_]+\b/.test(line) ||
    /\b(?:example|placeholder|your[_-]?|my[_-]?|dummy|sample|fake|test|xxx+|todo|changeme|redacted|\*{4,}|\.{3,})/i.test(
      line,
    )
  )
}

/**
 * Whether a finding on this line is explicitly suppressed.
 *
 * Accepts the markers other scanners use as well as its own, so a repository
 * already annotated for gitleaks or bandit does not have to be annotated twice.
 * The preceding line counts too, since a suppression is often written above the
 * line it covers.
 */
export function isSuppressed(line: string, previous?: string): boolean {
  return SUPPRESSION.test(line) || (previous !== undefined && SUPPRESSION.test(previous))
}

const SUPPRESSION =
  /(?:jean-scan-ignore|nosec|gitleaks:allow|pragma:\s*allowlist secret|trufflehog:ignore)/i

/**
 * Whether a whole file is annotated as holding deliberate fixtures.
 *
 * Only the header is checked: a marker buried mid-file would make it too easy
 * to silence the scanner by accident. A fixture file for a secret scanner is
 * the case this exists for — its contents look exactly like secrets, and
 * skipping test files wholesale would miss real keys committed in them.
 */
export function isFileSuppressed(lines: string[]): boolean {
  return lines.slice(0, 25).some((line) => SUPPRESSION.test(line))
}

/**
 * Shannon entropy in bits per character.
 *
 * A random 32-character key sits near 4.5; English prose near 3.5; a repeated
 * string near 0. The threshold is what separates them, imperfectly.
 */
export function entropy(text: string): number {
  if (text.length === 0) return 0

  const counts = new Map<string, number>()
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1)

  let bits = 0
  for (const count of counts.values()) {
    const p = count / text.length
    bits -= p * Math.log2(p)
  }
  return bits
}

/** Masks a secret, keeping enough to locate it. */
export function redact(line: string, secret: string): string {
  const masked = secret.length <= 8 ? '***' : `${secret.slice(0, 4)}...${secret.slice(-2)}`
  return line.replace(secret, masked).trim().slice(0, 160)
}

/**
 * Scans text for secrets.
 *
 * Comments are not skipped: a commented-out line with a real key is still a
 * leak once it reaches git history.
 */
export function scanForSecrets(text: string, path = '<text>'): SecretFinding[] {
  const findings: SecretFinding[] = []
  const lines = text.split('\n')
  if (isFileSuppressed(lines)) return findings
  const seen = new Set<string>()

  for (const [index, line] of lines.entries()) {
    // A minified bundle is one enormous line of high-entropy text and would
    // otherwise produce thousands of findings.
    if (line.length > 1000) continue
    // An explicit suppression. Every scanner needs one, because some strings
    // that look exactly like secrets are not — a test fixture for a secret
    // scanner being the obvious case. The alternative is skipping test files
    // wholesale, which would miss real keys committed in them.
    if (isSuppressed(line, lines[index - 1])) continue

    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0
      let match: RegExpExecArray | null

      while ((match = pattern.regex.exec(line)) !== null) {
        const secret = match[1] ?? match[0]
        if (pattern.verify && !pattern.verify(match[0], line)) continue

        const key = `${index}:${secret.slice(0, 16)}`
        if (seen.has(key)) continue
        seen.add(key)

        findings.push({
          path,
          line: index + 1,
          kind: pattern.kind,
          confidence: pattern.confidence,
          redacted: redact(line, secret),
          reason: `matches the ${pattern.kind} format`,
        })
      }
    }

    // Entropy, only for values that look assigned to a credential-ish name.
    // Unconstrained it flags every hash and UUID in the repository.
    const assignment = /\b(\w*(?:key|token|secret|password|credential|auth)\w*)\s*[=:]\s*['"]([A-Za-z0-9+/=_-]{24,})['"]/gi
    assignment.lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = assignment.exec(line)) !== null) {
      const value = match[2]!
      if (isPlaceholder(line)) continue
      if (findings.some((f) => f.line === index + 1)) continue
      if (entropy(value) < 4.0) continue
      // A hex hash is high entropy and almost never a credential.
      if (/^[0-9a-f]+$/i.test(value)) continue

      findings.push({
        path,
        line: index + 1,
        kind: 'high-entropy value',
        confidence: 'possible',
        redacted: redact(line, value),
        reason: `${entropy(value).toFixed(1)} bits per character in a value named "${match[1]}"`,
      })
    }
  }

  return findings
}
