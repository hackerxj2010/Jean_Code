import { describe, expect, test } from 'bun:test'
import {
  awk,
  baseName,
  bc,
  column,
  comm,
  cut,
  date,
  diff,
  expand,
  fmt,
  fold,
  head,
  jq,
  join,
  nl,
  paste,
  rev,
  sed,
  seq,
  shuf,
  sort,
  tail,
  tr,
  unexpand,
  uniq,
  runPipeline,
  wc,
  xargs,
} from '../packages/coreutils/src/index.ts'

describe('head and tail', () => {
  const text = 'one\ntwo\nthree\nfour\nfive\n'

  test('take lines from each end', () => {
    expect(head(text, 2).stdout).toBe('one\ntwo\n')
    expect(tail(text, 2).stdout).toBe('four\nfive\n')
  })

  test('asking for more lines than exist returns everything', () => {
    expect(head(text, 100).stdout).toBe(text)
    expect(tail(text, 100).stdout).toBe(text)
  })

  test('count bytes when asked', () => {
    expect(head(text, 3, true).stdout).toBe('one')
  })
})

describe('wc', () => {
  test('counts lines, words, bytes, and characters', () => {
    const counts = wc('hello world\nsecond line\n')
    expect(counts.lines).toBe(2)
    expect(counts.words).toBe(4)
  })

  test('distinguishes bytes from characters', () => {
    const counts = wc('日本語')
    // Three characters, nine bytes in UTF-8 — `wc -c` means bytes.
    expect(counts.chars).toBe(3)
    expect(counts.bytes).toBe(9)
  })
})

describe('sort', () => {
  test('sorts lexically by default', () => {
    expect(sort('banana\napple\ncherry\n').stdout).toBe('apple\nbanana\ncherry\n')
  })

  test('sorts numerically when asked', () => {
    // Lexical order would put 10 before 9.
    expect(sort('10\n9\n100\n', { numeric: true }).stdout).toBe('9\n10\n100\n')
  })

  test('reverses, deduplicates, and ignores case', () => {
    expect(sort('b\na\n', { reverse: true }).stdout).toBe('b\na\n')
    expect(sort('a\nb\na\n', { unique: true }).stdout).toBe('a\nb\n')
    expect(sort('B\na\n', { ignoreCase: true }).stdout).toBe('a\nB\n')
  })

  test('sorts on a field', () => {
    const input = 'x 3\ny 1\nz 2\n'
    expect(sort(input, { key: 2, numeric: true }).stdout).toBe('y 1\nz 2\nx 3\n')
  })

  test('orders independently of locale', () => {
    // `localeCompare` would order these differently on different machines, and
    // a pipeline's output must not depend on the machine.
    expect(sort('README\ncrates\npackages\n').stdout).toBe('README\ncrates\npackages\n')
  })
})

describe('uniq', () => {
  test('collapses only adjacent duplicates', () => {
    // This is what the real `uniq` does; non-adjacent repeats survive.
    expect(uniq('a\na\nb\na\n').stdout).toBe('a\nb\na\n')
  })

  test('counts occurrences', () => {
    expect(uniq('a\na\nb\n', { count: true }).stdout).toContain('2 a')
  })

  test('filters to duplicates or to singletons', () => {
    expect(uniq('a\na\nb\n', { duplicatesOnly: true }).stdout).toBe('a\n')
    expect(uniq('a\na\nb\n', { uniqueOnly: true }).stdout).toBe('b\n')
  })
})

describe('cut, paste, join, comm', () => {
  test('cut selects fields', () => {
    expect(cut('a,b,c\nd,e,f\n', { fields: [1, 3], delimiter: ',' }).stdout).toBe('a,c\nd,f\n')
  })

  test('cut selects characters', () => {
    expect(cut('hello\n', { characters: [1, 3, 5] }).stdout).toBe('hlo\n')
  })

  test('cut passes an undelimited line through unless -s', () => {
    expect(cut('nodelimiter\n', { fields: [1], delimiter: ',' }).stdout).toBe('nodelimiter\n')
    expect(cut('nodelimiter\n', { fields: [1], delimiter: ',', onlyDelimited: true }).stdout).toBe('')
  })

  test('paste merges corresponding lines', () => {
    expect(paste(['1\n2\n', 'a\nb\n']).stdout).toBe('1\ta\n2\tb\n')
  })

  test('join matches on a shared field', () => {
    const result = join('1 alpha\n2 beta\n', '1 x\n2 y\n')
    expect(result.stdout).toBe('1 alpha x\n2 beta y\n')
  })

  test('comm reports what is unique to each side and shared', () => {
    const result = comm('a\nb\n', 'b\nc\n')
    expect(result.stdout).toContain('a')
    expect(result.stdout).toContain('\tc')
    expect(result.stdout).toContain('\t\tb')
  })
})

describe('tr', () => {
  test('translates character sets', () => {
    expect(tr('hello', 'a-z', 'A-Z').stdout).toBe('HELLO')
  })

  test('deletes a set', () => {
    expect(tr('hello world', 'lo', '', { delete: true }).stdout).toBe('he wrd')
  })

  test('repeats a short target set, as tr does', () => {
    expect(tr('abc', 'abc', 'x').stdout).toBe('xxx')
  })

  test('complements a set', () => {
    expect(tr('a1b2', '0-9', '', { delete: true, complement: true }).stdout).toBe('12')
  })
})

describe('sed', () => {
  test('substitutes the first match per line', () => {
    expect(sed('aaa\n', 's/a/b/').stdout).toBe('baa\n')
  })

  test('substitutes globally with /g', () => {
    expect(sed('aaa\n', 's/a/b/g').stdout).toBe('bbb\n')
  })

  test('supports capture groups', () => {
    expect(sed('john smith\n', 's/(\\w+) (\\w+)/\\2 \\1/').stdout).toBe('smith john\n')
  })

  test('deletes and prints matching lines', () => {
    expect(sed('keep\ndrop\n', '/drop/d').stdout).toBe('keep\n')
    expect(sed('keep\ndrop\n', '/drop/p').stdout).toBe('drop\n')
  })

  test('reports an unsupported script rather than doing nothing', () => {
    const result = sed('x\n', 'H;x;s/a/b/')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('unsupported')
  })
})

describe('awk', () => {
  test('prints selected fields', () => {
    expect(awk('a b c\nd e f\n', '{print $1, $3}').stdout).toBe('a c\nd f\n')
  })

  test('filters by pattern', () => {
    expect(awk('apple 1\nbanana 2\n', '/banana/ {print $2}').stdout).toBe('2\n')
  })

  test('exposes NF and NR', () => {
    expect(awk('a b c\n', '{print NF}').stdout).toBe('3\n')
    expect(awk('x\ny\n', '{print NR}').stdout).toBe('1\n2\n')
  })

  test('honours a field separator', () => {
    expect(awk('a,b,c\n', '{print $2}', ',').stdout).toBe('b\n')
  })
})

describe('formatting utilities', () => {
  test('fold hard-wraps at a width', () => {
    expect(fold('abcdefghij\n', 3).stdout).toBe('abc\ndef\nghi\nj\n')
  })

  test('fmt reflows a paragraph', () => {
    const result = fmt('one two three four five six\n', 10)
    for (const line of result.stdout.trim().split('\n')) {
      expect(line.length).toBeLessThanOrEqual(10)
    }
  })

  test('expand and unexpand round-trip leading indentation', () => {
    expect(expand('\tx\n', 4).stdout).toBe('    x\n')
    expect(unexpand('    x\n', 4).stdout).toBe('\tx\n')
  })

  test('nl numbers lines', () => {
    expect(nl('a\nb\n').stdout).toContain('1\ta')
  })

  test('column aligns fields', () => {
    const result = column('a bb\nccc d\n')
    // Every row's second field starts at the same offset.
    const offsets = result.stdout.trim().split('\n').map((line) => line.indexOf(line.trim().split(/\s+/)[1]!))
    expect(new Set(offsets).size).toBe(1)
  })

  test('rev reverses each line', () => {
    expect(rev('abc\n').stdout).toBe('cba\n')
  })
})

describe('seq and shuf', () => {
  test('generates a sequence', () => {
    expect(seq(1, 3).stdout).toBe('1\n2\n3\n')
    expect(seq(3).stdout).toBe('1\n2\n3\n')
    expect(seq(0, 10, 5).stdout).toBe('0\n5\n10\n')
  })

  test('returns nothing when the step runs away from the end', () => {
    expect(seq(5, 1).stdout).toBe('')
  })

  test('rejects a zero step rather than looping forever', () => {
    expect(seq(1, 5, 0).exitCode).toBe(1)
  })

  test('shuf is reproducible for a given seed', () => {
    const input = 'a\nb\nc\nd\ne\n'
    expect(shuf(input, undefined, 42).stdout).toBe(shuf(input, undefined, 42).stdout)
    // And it is a permutation, not a filter.
    expect(shuf(input, undefined, 42).stdout.trim().split('\n').sort()).toEqual([
      'a', 'b', 'c', 'd', 'e',
    ])
  })
})

describe('jq', () => {
  const document = JSON.stringify({
    name: 'jean',
    version: 2,
    tags: ['cli', 'agent'],
    nested: { deep: { value: 42 } },
    items: [
      { id: 1, active: true },
      { id: 2, active: false },
    ],
  })

  test('identity returns the document', () => {
    expect(JSON.parse(jq(document, '.').stdout).name).toBe('jean')
  })

  test('reaches into fields', () => {
    expect(jq(document, '.name').stdout.trim()).toBe('"jean"')
    expect(jq(document, '.nested.deep.value').stdout.trim()).toBe('42')
  })

  test('indexes arrays, including from the end', () => {
    expect(jq(document, '.tags[0]').stdout.trim()).toBe('"cli"')
    expect(jq(document, '.tags[-1]').stdout.trim()).toBe('"agent"')
  })

  test('iterates and pipes', () => {
    expect(jq(document, '.items[] | .id').stdout.trim().split('\n')).toEqual(['1', '2'])
  })

  test('selects by condition', () => {
    const result = jq(document, '.items[] | select(.active == true) | .id')
    expect(result.stdout.trim()).toBe('1')
  })

  test('supports keys, length, and type', () => {
    expect(jq(document, '.tags | length').stdout.trim()).toBe('2')
    expect(jq(document, '.name | type').stdout.trim()).toBe('"string"')
    expect(JSON.parse(jq(document, '.nested | keys').stdout)).toEqual(['deep'])
  })

  test('reports invalid JSON rather than throwing', () => {
    const result = jq('{not json', '.')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('invalid JSON')
  })

  test('missing fields yield null, not an error', () => {
    expect(jq(document, '.nope').stdout.trim()).toBe('null')
  })
})

describe('bc', () => {
  test('evaluates arithmetic with correct precedence', () => {
    expect(bc('2 + 3 * 4').stdout.trim()).toBe('14')
    expect(bc('(2 + 3) * 4').stdout.trim()).toBe('20')
  })

  test('exponentiation is right-associative', () => {
    // 2^(3^2) = 512, not (2^3)^2 = 64.
    expect(bc('2 ^ 3 ^ 2').stdout.trim()).toBe('512')
  })

  test('handles unary minus', () => {
    expect(bc('-5 + 3').stdout.trim()).toBe('-2')
    expect(bc('10 * -2').stdout.trim()).toBe('-20')
  })

  test('supports functions', () => {
    expect(bc('sqrt(16)').stdout.trim()).toBe('4')
    expect(bc('abs(0 - 7)').stdout.trim()).toBe('7')
  })

  test('reports division by zero rather than returning Infinity', () => {
    const result = bc('1 / 0')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('division by zero')
  })

  test('rejects malformed input rather than evaluating it', () => {
    // The input comes from a model; `eval` here would be arbitrary code execution.
    expect(bc('2 +').exitCode).toBe(1)
    expect(bc('process.exit(1)').exitCode).toBe(1)
  })

  test('evaluates several expressions', () => {
    expect(bc('1+1; 2+2').stdout).toBe('2\n4\n')
  })
})

describe('paths, env, and dates', () => {
  test('basename strips directories and an optional suffix', () => {
    expect(baseName('/a/b/c.txt').stdout.trim()).toBe('c.txt')
    expect(baseName('/a/b/c.txt', '.txt').stdout.trim()).toBe('c')
  })

  test('date formats with strftime specifiers', () => {
    const when = new Date(2026, 0, 15, 9, 30, 0)
    expect(date('%Y-%m-%d', when).stdout.trim()).toBe('2026-01-15')
    expect(date('%H:%M', when).stdout.trim()).toBe('09:30')
  })
})

describe('xargs', () => {
  test('batches arguments', () => {
    expect(xargs('a b c d', { maxArgs: 2 })).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  test('returns one batch by default', () => {
    expect(xargs('a b c')).toEqual([['a', 'b', 'c']])
  })
})

describe('diff', () => {
  test('reports nothing for identical input', () => {
    expect(diff('a\nb\n', 'a\nb\n').stdout).toBe('')
  })

  test('emits a unified hunk header', () => {
    const result = diff('a\nb\nc\n', 'a\nX\nc\n')
    expect(result.stdout).toContain('@@')
    expect(result.stdout).toContain('-b')
    expect(result.stdout).toContain('+X')
  })

  test('marks added and removed lines', () => {
    expect(diff('a\n', 'a\nb\n').stdout).toContain('+b')
    expect(diff('a\nb\n', 'a\n').stdout).toContain('-b')
  })
})

describe('the pipeline', () => {
  test('threads stages in order', () => {
    const result = runPipeline('3\n1\n2\n1\n', [
      { op: 'sort', args: { numeric: true } },
      { op: 'uniq' },
      { op: 'head', args: { count: 2 } },
    ])
    expect(result.stdout).toBe('1\n2\n')
  })

  test('stops at the first failing stage', () => {
    const result = runPipeline('x\n', [
      { op: 'sed', args: {} },
      { op: 'head' },
    ])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('required')
  })

  test('reports an unknown operation rather than passing input through', () => {
    // Silently ignoring it would make the agent believe the stage ran.
    const result = runPipeline('x\n', [{ op: 'frobnicate' }])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('unknown operation')
  })

  test('combines jq and text stages', () => {
    const json = JSON.stringify({ items: [{ n: 3 }, { n: 1 }, { n: 2 }] })
    const result = runPipeline(json, [
      { op: 'jq', args: { filter: '.items[] | .n' } },
      { op: 'sort', args: { numeric: true } },
    ])
    expect(result.stdout).toBe('1\n2\n3\n')
  })
})
