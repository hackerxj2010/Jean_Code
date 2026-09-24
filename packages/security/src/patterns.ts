import { isFileSuppressed, isSuppressed } from './secrets.ts'
/**
 * Dangerous code patterns.
 *
 * Not a replacement for a real static analyzer — those need type information
 * and dataflow, which a line scanner does not have. What this catches is the
 * class of mistake an agent is most likely to *introduce*: string-built SQL, a
 * command assembled from a variable, a path joined from user input.
 *
 * Every finding names the safe alternative. A warning that says "this is
 * dangerous" without saying what to do instead gets ignored, correctly.
 */

export type Severity = 'high' | 'medium' | 'low'

export interface CodeFinding {
  path: string
  line: number
  rule: string
  severity: Severity
  message: string
  /** What to do instead. */
  fix: string
  snippet: string
}

interface Rule {
  id: string
  severity: Severity
  languages?: string[]
  regex: RegExp
  message: string
  fix: string
  /** Suppresses a shape that matches but is safe. */
  safe?: (line: string) => boolean
}

const RULES: Rule[] = [
  {
    id: 'sql-injection',
    severity: 'high',
    regex: /\b(?:query|execute|exec|prepare)\s*\(\s*[`'"][^`'"]*\b(?:SELECT|INSERT|UPDATE|DELETE|DROP)\b[^`'"]*(?:\$\{|\+\s*\w|%s|\bformat\()/i,
    message: 'SQL built by string interpolation',
    fix: 'Use a parameterized query: pass values as arguments rather than concatenating them into the statement.',
    /**
     * Composing a *clause* from fixed literals is the correct way to build an
     * optional filter, and it looks identical to interpolating a value.
     *
     * The distinguishing signal: the statement still uses `?` placeholders, and
     * the interpolated name is a clause rather than a value. Without this the
     * rule fires on every well-written query builder — and a scanner that flags
     * correct code teaches people to ignore it, which costs more than the rule
     * is worth.
     */
    safe: (line) =>
      /\?/.test(line) &&
      /\$\{\s*(?:\w*(?:where|clause|filter|order|sort|limit|offset|join|having|columns?|fields?)\w*)\s*\}/i.test(
        line,
      ),
  },
  {
    id: 'command-injection',
    severity: 'high',
    // The optional closing quote matters: `exec("rm -rf " + path)` has one
    // between the string and the concatenation, and without it the rule misses
    // the commonest form of this bug.
    regex: /\b(?:exec|execSync|spawnSync?|system|popen|shell_exec)\s*\(\s*[`'"][^`'"]*[`'"]?\s*(?:\$\{|\+\s*\w)/,
    message: 'A shell command assembled from a variable',
    fix: 'Use the argument-array form (`execFile(cmd, [args])`), which never invokes a shell.',
  },
  {
    id: 'eval-use',
    severity: 'high',
    regex: /\b(?:eval|Function)\s*\(\s*(?!['"`]\s*['"`])[^)]*\b(?:input|body|param|query|req|arg|user|data)\b/i,
    message: 'Code evaluated from what looks like external input',
    fix: 'Parse the value instead. If it is genuinely code, run it in a sandbox with no access to this process.',
  },
  {
    id: 'path-traversal',
    severity: 'high',
    regex: /\b(?:readFile|writeFile|readFileSync|writeFileSync|createReadStream|open|unlink)\s*\(\s*(?:path\.)?join\s*\([^)]*\b(?:req|input|param|user|query|body)\b/i,
    message: 'A filesystem path built from external input',
    fix: 'Resolve the path and check it is still inside the intended directory before using it.',
  },
  {
    id: 'weak-hash',
    severity: 'medium',
    regex: /\bcreateHash\s*\(\s*['"](?:md5|sha1)['"]/i,
    message: 'MD5 or SHA-1 used for hashing',
    fix: 'Use SHA-256 for integrity. For passwords use a password hash — argon2, scrypt, or bcrypt — not a general-purpose one.',
    // Both are fine for a cache key or a content address, which is what most
    // uses in a codebase actually are.
    safe: (line) => /\b(?:etag|cache|checksum|fingerprint|dedup|content[_-]?address)\b/i.test(line),
  },
  {
    id: 'insecure-random',
    severity: 'medium',
    regex: /Math\.random\s*\(\s*\)/,
    message: 'Math.random() where the value looks security-relevant',
    fix: 'Use `crypto.randomUUID()` or `crypto.getRandomValues()` for anything an attacker should not predict.',
    // No word boundaries: `\btoken\b` does not match `sessionToken`, because a
    // camelCase identifier has no boundary inside it — so the check silently
    // never fired on exactly the names that matter.
    safe: (line) =>
      !/(?:token|secret|password|key|nonce|salt|session|csrf|otp|reset|verify|auth)/i.test(line),
  },
  {
    id: 'tls-disabled',
    severity: 'high',
    regex: /\b(?:rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true)/i,
    message: 'Certificate verification disabled',
    fix: 'Add the certificate to the trust store instead. Disabling verification makes the connection interceptable.',
  },
  {
    id: 'wildcard-cors',
    severity: 'medium',
    regex: /['"]Access-Control-Allow-Origin['"]\s*[,:]\s*['"]\*['"]/i,
    message: 'CORS open to every origin',
    fix: 'List the origins that need access. A wildcard with credentials is rejected by browsers anyway.',
  },
  {
    id: 'dangerous-html',
    severity: 'medium',
    regex: /\b(?:dangerouslySetInnerHTML|innerHTML\s*=|v-html|outerHTML\s*=)/,
    message: 'HTML injected without sanitization',
    fix: 'Set text content instead, or sanitize the HTML before inserting it.',
    // A string literal cannot carry an injection: `innerHTML = ''` is how an
    // element gets emptied, and flagging it fires on nearly every DOM teardown.
    // The last clause skips this rule's own definition, which is text *about*
    // the pattern rather than an instance of it.
    safe: (line) =>
      /\b(?:sanitiz|purify|escape|DOMPurify)/i.test(line) ||
      /innerHTML\s*=\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*[;,)]?\s*$/.test(line) ||
      /regex:\s*\//.test(line),
  },
  {
    id: 'unsafe-deserialization',
    severity: 'high',
    languages: ['python'],
    regex: /\b(?:pickle\.loads?|yaml\.load\s*\((?![^)]*Loader)|marshal\.loads?)\s*\(/,
    message: 'Deserialization that can execute arbitrary code',
    fix: 'Use `yaml.safe_load` or JSON. `pickle` on untrusted input is remote code execution.',
  },
  {
    id: 'shell-true',
    severity: 'medium',
    languages: ['python'],
    regex: /\bsubprocess\.(?:run|call|Popen|check_output)\s*\([^)]*shell\s*=\s*True/,
    message: 'A subprocess run through a shell',
    fix: 'Pass the command as a list and drop `shell=True`, so arguments are never re-parsed by a shell.',
  },
  {
    id: 'unwrap-in-library',
    severity: 'low',
    languages: ['rust'],
    regex: /\.unwrap\(\)/,
    message: 'unwrap() panics rather than returning an error',
    fix: 'Return a `Result` and let the caller decide. `expect("why this cannot fail")` is better than `unwrap()` where a panic really is correct.',
    safe: (line) => /#\[test\]|#\[cfg\(test\)\]|assert|\/\//.test(line),
  },
]

/** Scans text against the rules. */
export function scanForPatterns(
  text: string,
  path = '<text>',
  language?: string,
): CodeFinding[] {
  const findings: CodeFinding[] = []
  const lines = text.split('\n')
  if (isFileSuppressed(lines)) return findings

  for (const [index, line] of lines.entries()) {
    if (line.length > 1000) continue

    if (isSuppressed(line, lines[index - 1])) continue

    const trimmed = line.trim()
    // A rule firing on its own documentation is noise; this file would flag
    // itself a dozen times otherwise.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue

    for (const rule of RULES) {
      if (rule.languages && language && !rule.languages.includes(language)) continue
      if (!rule.regex.test(line)) continue
      if (rule.safe?.(line)) continue

      findings.push({
        path,
        line: index + 1,
        rule: rule.id,
        severity: rule.severity,
        message: rule.message,
        fix: rule.fix,
        snippet: trimmed.slice(0, 160),
      })
    }
  }

  return findings
}

/** The rules, for documentation and `jean scan --rules`. */
export function listRules(): { id: string; severity: Severity; message: string }[] {
  return RULES.map((rule) => ({ id: rule.id, severity: rule.severity, message: rule.message }))
}
