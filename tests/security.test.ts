import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  entropy,
  listRules,
  redact,
  renderReport,
  scanDirectory,
  scanForPatterns,
  scanForSecrets,
  scanText,
} from '../packages/security/src/index.ts'

/* jean-scan-ignore — every fixture below is a synthetic key by design. */
const temps: string[] = []
const NL = String.fromCharCode(10)

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'jean-sec-'))
  temps.push(dir)
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true })
})

describe('entropy', () => {
  test('separates random from prose from repetition', () => {
    expect(entropy('aB3xK9mQ7pL2wR5tY8uI1oP4sD6fG0hJ')).toBeGreaterThan(4.5)
    expect(entropy('the quick brown fox')).toBeLessThan(4.2)
    expect(entropy('aaaaaaaaaaaa')).toBe(0)
    expect(entropy('')).toBe(0)
  })
})

describe('redaction', () => {
  test('masks the value but keeps the line readable', () => {
    const line = 'const key = "sk-ant-abcdefghijklmnop"'
    const redacted = redact(line, 'sk-ant-abcdefghijklmnop')

    // The report must never contain the secret itself.
    expect(redacted).not.toContain('abcdefghijklmnop')
    expect(redacted).toContain('const key')
  })

  test('reveals nothing from a short value', () => {
    expect(redact('pwd = "short"', 'short')).toContain('***')
  })
})

describe('secret detection', () => {
  test('finds provider keys by their format', () => {
    // Lengths are exact: these formats are fixed-width, which is what makes
    // matching them certain rather than heuristic.
    const sources: [string, string][] = [
      ['Anthropic key', 'const k = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz12"'],
      ['AWS access key', `AKIA${'A'.repeat(16)}`],
      ['GitHub token', `ghp_${'a'.repeat(36)}`],
      ['Google API key', `AIza${'B'.repeat(35)}`],
      ['private key', '-----BEGIN RSA PRIVATE KEY-----'],
    ]

    for (const [kind, source] of sources) {
      const findings = scanForSecrets(source, 'x.ts')
      expect(findings.length).toBeGreaterThan(0)
      expect(findings[0]!.kind).toBe(kind)
      expect(findings[0]!.confidence).toBe('certain')
    }
  })

  test('reports one key once, not once per overlapping pattern', () => {
    // `sk-ant-…` also matches the generic OpenAI shape; without a lookahead and
    // deduplication it is reported twice under two provider names.
    const findings = scanForSecrets('const k = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz12"', 'x.ts')
    expect(findings).toHaveLength(1)
  })

  test('does not flag a value read from the environment', () => {
    // Flagging this would make the scanner fire on exactly the code doing the
    // right thing, which teaches people to ignore it.
    const source = [
      'const apiKey = process.env.API_KEY',
      'const token = import.meta.env.VITE_TOKEN',
      'password = os.environ["DB_PASSWORD"]',
    ].join(NL)
    expect(scanForSecrets(source, 'x.ts')).toHaveLength(0)
  })

  test('does not flag obvious placeholders', () => {
    const source = [
      'api_key = "your-api-key-here"',
      'password = "changeme123"',
      'token = "xxxxxxxxxxxxxxxxxxxx"',
      'apiKey = "example-key-placeholder"',
    ].join(NL)
    expect(scanForSecrets(source, 'x.ts')).toHaveLength(0)
  })

  test('flags a connection string with a real password', () => {
    const findings = scanForSecrets('DATABASE_URL=postgres://user:r3alP4ssw0rd@host/db', 'x.env')
    expect(findings[0]!.kind).toContain('connection string')
  })

  test('ignores a connection string with a placeholder password', () => {
    expect(scanForSecrets('postgres://user:changeme@localhost/db', 'x.env')).toHaveLength(0)
  })

  test('finds a secret inside a comment', () => {
    // A commented-out key is still a leak once it reaches git history.
    const findings = scanForSecrets('// const k = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"', 'x.ts')
    expect(findings).toHaveLength(1)
  })

  test('skips a minified line rather than producing thousands of findings', () => {
    expect(scanForSecrets(`const x="${'a1B2'.repeat(400)}"`, 'bundle.js')).toHaveLength(0)
  })

  test('ignores a hex hash despite its entropy', () => {
    const source = 'const cacheKey = "a3f5e8d9c2b1a0f7e6d5c4b3a2918077"'
    expect(scanForSecrets(source, 'x.ts')).toHaveLength(0)
  })
})

describe('dangerous patterns', () => {
  test('finds SQL built by interpolation', () => {
    const findings = scanForPatterns('db.query(`SELECT * FROM users WHERE id = ${id}`)', 'x.ts')
    expect(findings[0]!.rule).toBe('sql-injection')
    expect(findings[0]!.severity).toBe('high')
    // A warning without a remedy gets ignored, correctly.
    expect(findings[0]!.fix).toContain('parameterized')
  })

  test('allows a clause composed from fixed literals', () => {
    // The correct way to build an optional filter: the clause is assembled from
    // literals, and every value still goes through a `?` placeholder. Flagging
    // this would fire on every well-written query builder.
    const safe =
      'db.prepare(`SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT ?`).all(...params)'
    expect(scanForPatterns(safe, 'x.ts')).toHaveLength(0)
  })

  test('still flags a value interpolated into a statement', () => {
    const unsafe = 'db.query(`SELECT * FROM users WHERE name = ${name}`)'
    expect(scanForPatterns(unsafe, 'x.ts')[0]!.rule).toBe('sql-injection')
  })

  test('finds a command built by concatenation', () => {
    // The closing quote sits between the string and the `+`; a rule that does
    // not allow for it misses the commonest form.
    const findings = scanForPatterns('exec("rm -rf " + userPath)', 'x.ts')
    expect(findings[0]!.rule).toBe('command-injection')
  })

  test('finds disabled certificate verification', () => {
    const findings = scanForPatterns('const agent = { rejectUnauthorized: false }', 'x.ts')
    expect(findings[0]!.rule).toBe('tls-disabled')
  })

  test('flags Math.random only where the value looks security-relevant', () => {
    const source = [
      'const index = Math.random() * items.length',
      'const sessionToken = Math.random().toString(36)',
    ].join(NL)

    const findings = scanForPatterns(source, 'x.ts')
    // `\\btoken\\b` never matches `sessionToken`: there is no word boundary
    // inside a camelCase identifier.
    expect(findings).toHaveLength(1)
    expect(findings[0]!.line).toBe(2)
  })

  test('allows a weak hash used as a cache key', () => {
    const source = [
      'const etag = createHash("md5").update(body).digest("hex")',
      'const stored = createHash("md5").update(password).digest("hex")',
    ].join(NL)

    const findings = scanForPatterns(source, 'x.ts')
    // MD5 for a content address is fine; for a password it is not.
    expect(findings).toHaveLength(1)
    expect(findings[0]!.line).toBe(2)
  })

  test('allows sanitized HTML insertion', () => {
    const source = [
      'el.innerHTML = raw',
      'el.innerHTML = DOMPurify.sanitize(raw)',
    ].join(NL)
    expect(scanForPatterns(source, 'x.ts')).toHaveLength(1)
  })

  test('allows innerHTML cleared with a literal', () => {
    // `el.innerHTML = ''` is how you empty an element; a literal carries no
    // injection, and flagging it fires on nearly every DOM teardown.
    const source = [
      "el.innerHTML = ''",
      'el.innerHTML = untrustedValue',
    ].join(NL)

    const findings = scanForPatterns(source, 'x.ts')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.line).toBe(2)
  })

  test('applies language-specific rules only to that language', () => {
    const python = 'data = pickle.loads(payload)'
    expect(scanForPatterns(python, 'x.py', 'python')).toHaveLength(1)
    // The same text in a TypeScript file is not a Python deserialization bug.
    expect(scanForPatterns(python, 'x.ts', 'typescript')).toHaveLength(0)
  })

  test('does not flag its own documentation', () => {
    const source = '// exec("rm -rf " + path) is dangerous'
    expect(scanForPatterns(source, 'x.ts')).toHaveLength(0)
  })

  test('exposes its rule list', () => {
    const rules = listRules()
    expect(rules.length).toBeGreaterThan(8)
    for (const rule of rules) {
      expect(rule.id).toMatch(/^[a-z-]+$/)
      expect(['high', 'medium', 'low']).toContain(rule.severity)
    }
  })
})

describe('scanning a tree', () => {
  test('scans code and credential files, skipping the rest', async () => {
    const dir = workspace({
      'src/app.ts': 'const k = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"' + NL,
      '.env': 'SECRET=sk-ant-api03-abcdefghijklmnopqrstuvwxyz12' + NL,
      'README.md': 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' + NL,
    })

    const report = await scanDirectory(dir)
    const paths = report.secrets.map((finding) => finding.path).sort()

    expect(paths).toContain('src/app.ts')
    expect(paths).toContain('.env')
    // Markdown is prose, and scanning it produces documentation false positives.
    expect(paths).not.toContain('README.md')
  })

  test('orders certain findings before uncertain ones', async () => {
    const dir = workspace({
      'a.ts': 'password = "probablyNotReal"' + NL,
      'b.ts': 'const k = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"' + NL,
    })

    const report = await scanDirectory(dir)
    // A report whose first entry is a maybe gets skimmed, and the real leak
    // three screens down gets missed.
    expect(report.secrets[0]!.confidence).toBe('certain')
  })

  test('certainOnly drops the guesses', async () => {
    const dir = workspace({ 'a.ts': 'password = "probablyNotReal"' + NL })

    expect((await scanDirectory(dir)).secrets.length).toBeGreaterThan(0)
    expect((await scanDirectory(dir, { certainOnly: true })).secrets).toHaveLength(0)
  })

  test('minSeverity filters code findings', async () => {
    const dir = workspace({
      'a.rs': 'let x = foo().unwrap();' + NL,
      'b.ts': 'const o = { rejectUnauthorized: false }' + NL,
    })

    const high = await scanDirectory(dir, { minSeverity: 'high' })
    expect(high.code.every((finding) => finding.severity === 'high')).toBe(true)
  })
})

describe('the report', () => {
  test('says so when nothing was found', () => {
    expect(renderReport({ secrets: [], code: [], filesScanned: 12, truncated: false })).toContain(
      '12 files',
    )
  })

  test('tells the user to rotate, not just delete', () => {
    const report = scanText('const k = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"', 'x.ts')
    // Deleting the line does not remove it from git history.
    expect(renderReport(report)).toContain('rotate')
  })

  test('never contains the secret itself', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    const rendered = renderReport(scanText(`const k = "${secret}"`, 'x.ts'))
    expect(rendered).not.toContain(secret)
  })
})

describe('suppression', () => {
  test('an inline marker silences that line', () => {
    const source = `const k = "ghp_${'a'.repeat(36)}" // gitleaks:allow`
    expect(scanForSecrets(source, 'x.ts')).toHaveLength(0)
  })

  test('a marker on the preceding line covers the one below', () => {
    const source = ['// nosec', `const k = "ghp_${'a'.repeat(36)}"`].join(NL)
    expect(scanForSecrets(source, 'x.ts')).toHaveLength(0)
  })

  test('a header marker silences the whole file', () => {
    // A fixture file for a secret scanner looks exactly like a leak. Skipping
    // test files wholesale would instead miss real keys committed in them.
    const source = [
      '/* jean-scan-ignore */',
      '',
      ...Array.from({ length: 40 }, () => 'const filler = 1'),
      `const k = "ghp_${'a'.repeat(36)}"`,
    ].join(NL)
    expect(scanForSecrets(source, 'fixtures.ts')).toHaveLength(0)
  })

  test('a marker buried mid-file does not silence it', () => {
    // Otherwise the scanner is too easy to disable by accident.
    const source = [
      ...Array.from({ length: 40 }, () => 'const filler = 1'),
      '// nosec',
      '',
      `const k = "ghp_${'a'.repeat(36)}"`,
    ].join(NL)
    expect(scanForSecrets(source, 'x.ts').length).toBeGreaterThan(0)
  })

  test('suppression applies to code rules too', () => {
    const source = ['/* jean-scan-ignore */', 'exec("rm -rf " + p)'].join(NL)
    expect(scanForPatterns(source, 'x.ts')).toHaveLength(0)
  })
})
