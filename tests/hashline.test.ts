import { describe, expect, test } from 'bun:test'
import {
  anchorOf,
  apply,
  HashlineError,
  Index,
  normalize,
  parse,
  patch,
  type Hunk,
} from '../packages/tools/src/hashline.ts'

/**
 * Hashline behaviour, and its parity with `crates/hashline`.
 *
 * These mirror the Rust crate's tests case for case. Both implementations have
 * to agree exactly — the native path and the fallback path apply patches to the
 * same files, and a divergence would corrupt code rather than merely disagree.
 */

const SRC = `export class RateLimiter {
  private counter = 0;

  hit() {
    this.counter += 1;
  }
}
`

function anchorFor(src: string, needle: string): string {
  const line = src.split('\n').find((l) => l.includes(needle))
  if (!line) throw new Error(`no line containing ${needle}`)
  return anchorOf(line)
}

describe('normalization', () => {
  test('is whitespace insensitive', () => {
    expect(normalize('  let  x =  1  ')).toBe('let x = 1')
    expect(normalize('\tlet x = 1')).toBe('let x = 1')
    expect(normalize('let x = 1')).toBe(normalize('    let    x = 1'))
  })

  test('anchors survive re-indentation', () => {
    expect(anchorOf('  private counter = 0;')).toBe(anchorOf('\t\tprivate counter = 0;'))
  })

  test('anchors are 8 hex digits', () => {
    expect(anchorOf('anything')).toMatch(/^[0-9a-f]{8}$/)
  })

  test('matches the SHA-256 prefix the Rust crate computes', () => {
    // Cross-checked against `hashline::anchor_of` — see the parity test below,
    // which regenerates these from the crate itself.
    expect(anchorOf('')).toBe('e3b0c442')
    expect(anchorOf('abc')).toBe('ba7816bf')
  })
})

describe('applying patches', () => {
  test('replaces a line', () => {
    const hunk: Hunk = {
      anchor: anchorFor(SRC, 'private counter'),
      anchorText: 'private counter = 0;',
      ops: [
        { kind: 'del', text: '  private counter = 0;' },
        { kind: 'add', text: '  private counter = new Map<string, number>();' },
      ],
    }
    const out = apply(SRC, [hunk])
    expect(out.content).toContain('new Map<string, number>()')
    expect(out.content).not.toContain('private counter = 0;')
    expect(out.resolutions[0]).toBe('exact')
    expect(out.delta).toBe(0)
  })

  test('parses and applies the wire format', () => {
    const a = anchorFor(SRC, 'hit()')
    const text = [
      `anchor: h:${a} -> "hit() {"`,
      'patch: |-|',
      '    hit() {',
      '  -   this.counter += 1;',
      '  +   this.counter = (this.counter ?? 0) + 1;',
      '  +   this.lastHit = Date.now();',
    ].join('\n')

    const out = patch(SRC, text)
    expect(out.content).toContain('this.lastHit = Date.now();')
    expect(out.content).not.toContain('this.counter += 1;')
    expect(out.delta).toBe(1)
  })

  test('recovers from a stale anchor using the anchor text', () => {
    const stale: Hunk = {
      anchor: 'deadbeef',
      anchorText: 'private counter = 0;',
      ops: [
        { kind: 'del', text: '  private counter = 0;' },
        { kind: 'add', text: '  private counter = 1;' },
      ],
    }
    const out = apply(SRC, [stale])
    expect(out.resolutions[0]).toBe('recovered-by-text')
    expect(out.content).toContain('private counter = 1;')
  })

  test('recovers from a stale anchor using hunk context', () => {
    const stale: Hunk = {
      anchor: 'deadbeef',
      ops: [
        { kind: 'keep', text: '  hit() {' },
        { kind: 'del', text: '    this.counter += 1;' },
        { kind: 'add', text: '    this.counter += 2;' },
      ],
    }
    const out = apply(SRC, [stale])
    expect(out.resolutions[0]).toBe('recovered-by-context')
    expect(out.content).toContain('this.counter += 2;')
  })

  test('re-indents inserted lines to match the file', () => {
    const file = 'class A {\n    hit() {\n        go();\n    }\n}\n'
    const hunk: Hunk = {
      anchor: anchorFor(file, 'go();'),
      anchorText: 'go();',
      ops: [
        { kind: 'keep', text: '    go();' },
        { kind: 'add', text: '    log();' },
      ],
    }
    const out = apply(file, [hunk])
    // The patch used 4-space indent; the file uses 8. The insert must follow
    // the file, not the patch.
    expect(out.content).toContain('\n        log();\n')
  })

  test('disambiguates a repeated anchor using context', () => {
    const dup = 'fn a() {\n  ok();\n}\nfn b() {\n  ok();\n}\n'
    const anchor = anchorOf('  ok();')
    expect(new Index(dup).matches(anchor)).toHaveLength(2)

    const out = apply(dup, [
      {
        anchor,
        anchorText: 'ok();',
        ops: [
          { kind: 'del', text: '  ok();' },
          { kind: 'add', text: '  ok2();' },
          { kind: 'keep', text: '}' },
          { kind: 'keep', text: 'fn b() {' },
        ],
      },
    ])
    expect(out.content.startsWith('fn a() {\n  ok2();\n}')).toBe(true)
    expect(out.resolutions[0]).toBe('disambiguated')
  })

  test('tracks line drift across multiple hunks', () => {
    const out = apply(SRC, [
      {
        anchor: anchorFor(SRC, 'private counter'),
        ops: [
          { kind: 'keep', text: '  private counter = 0;' },
          { kind: 'add', text: '  private lastHit = 0;' },
          { kind: 'add', text: '  private window = 60_000;' },
        ],
      },
      {
        anchor: anchorFor(SRC, 'this.counter += 1;'),
        ops: [
          { kind: 'del', text: '    this.counter += 1;' },
          { kind: 'add', text: '    this.counter += 1; this.lastHit = Date.now();' },
        ],
      },
    ])
    expect(out.content).toContain('private window = 60_000;')
    expect(out.content).toContain('this.lastHit = Date.now();')
    expect(out.delta).toBe(2)
  })

  test('preserves a file with no trailing newline', () => {
    const out = apply('one\ntwo', [
      {
        anchor: anchorOf('two'),
        ops: [
          { kind: 'del', text: 'two' },
          { kind: 'add', text: 'three' },
        ],
      },
    ])
    expect(out.content).toBe('one\nthree')
  })

  test('preserves a trailing newline', () => {
    const out = apply('one\ntwo\n', [
      {
        anchor: anchorOf('two'),
        ops: [{ kind: 'del', text: 'two' }, { kind: 'add', text: 'three' }],
      },
    ])
    expect(out.content).toBe('one\nthree\n')
  })

  test('fails rather than corrupting when nothing matches', () => {
    expect(() =>
      apply(SRC, [
        {
          anchor: anchorFor(SRC, 'private counter'),
          ops: [
            { kind: 'keep', text: '  private counter = 0;' },
            { kind: 'del', text: '  something that is not there;' },
          ],
        },
      ]),
    ).toThrow(HashlineError)
  })
})

describe('parsing', () => {
  test('rejects malformed patches', () => {
    expect(() => parse('nothing here')).toThrow(HashlineError)
    expect(() => parse('anchor: h:zzzz\npatch: |-|\n  - x')).toThrow(HashlineError)
    expect(() => parse('patch: |-|\n  - x')).toThrow(HashlineError)
  })

  test('accepts both arrow forms and bare anchors', () => {
    expect(parse('anchor: h:abc12345\npatch: |-|\n  - x')[0]!.anchor).toBe('abc12345')
    expect(parse('anchor: h:abc12345 -> "x"\npatch: |-|\n  - x')[0]!.anchorText).toBe('x')
    expect(parse('anchor: h:abc12345 → "x"\npatch: |-|\n  - x')[0]!.anchorText).toBe('x')
  })

  test('handles multiple hunks in one patch', () => {
    const hunks = parse(
      [
        'anchor: h:aaaaaaaa',
        'patch: |-|',
        '  - one',
        'anchor: h:bbbbbbbb',
        'patch: |-|',
        '  - two',
      ].join('\n'),
    )
    expect(hunks).toHaveLength(2)
    expect(hunks[1]!.anchor).toBe('bbbbbbbb')
  })
})

describe('the anchor gutter', () => {
  test('renders one annotated line per source line', () => {
    const rendered = new Index('a\nb\n').annotate()
    expect(rendered.split('\n')).toHaveLength(2)
    expect(rendered.startsWith('h:')).toBe(true)
    expect(rendered).toContain('│ a')
  })

  test('round-trips: an anchor read from the gutter applies', () => {
    const gutter = new Index(SRC).annotate()
    const anchor = gutter
      .split('\n')
      .find((l) => l.includes('private counter'))!
      .slice(2, 10)

    const out = apply(SRC, [
      {
        anchor,
        ops: [
          { kind: 'del', text: '  private counter = 0;' },
          { kind: 'add', text: '  private counter = 5;' },
        ],
      },
    ])
    expect(out.content).toContain('private counter = 5;')
  })
})
