/**
 * Is the Rust structural search worth wiring, or is the TypeScript one enough?
 *
 * `bun scripts/bench-ast.ts`
 *
 * Asked before wiring anything, because the last measurement produced the
 * opposite of the expected answer for half the operations tested. `ast_grep` is
 * the only remaining candidate whose cost is plausibly dominated by traversal,
 * so it is the only one worth checking.
 *
 * Two things are compared, and the second matters more: speed, and whether the
 * two implementations *agree*. A faster engine that returns different matches
 * is not an optimisation, it is a second bug surface.
 */

import { Native } from '../packages/native/src/index.ts'
import { searchStructural } from '../packages/codemap/src/structural.ts'

const ROOT = process.cwd()
const RUNS = 3

const PATTERNS = [
  'export function $NAME($$$ARGS)',
  'if ($COND) { $$$BODY }',
  'catch ($E) { $$$BODY }',
]

const native = Native.open()

if (!(await native.available())) {
  process.stderr.write('binaire natif absent — `cargo build --release -p pi-natives`\n')
  process.exit(1)
}

async function median(run: () => Promise<number>): Promise<{ ms: number; count: number }> {
  await run() // warm-up, discarded

  const samples: number[] = []
  let count = 0
  for (let index = 0; index < RUNS; index++) {
    const started = performance.now()
    count = await run()
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  return { ms: samples[Math.floor(samples.length / 2)]!, count }
}

process.stdout.write('\n')

for (const pattern of PATTERNS) {
  const ts = await median(async () => {
    const matches = await searchStructural(ROOT, pattern, { limit: 500 })
    return matches.length
  })

  const rust = await median(async () => {
    const matches = await native.searchTree(ROOT, pattern, {
      glob: '**/*.ts',
      limit: 500,
    })
    return matches.length
  })

  const ratio = ts.ms / rust.ms
  const speed =
    ratio > 1.2
      ? `Rust ${ratio.toFixed(1)}× plus rapide`
      : ratio < 0.83
        ? `TypeScript ${(1 / ratio).toFixed(1)}× plus rapide`
        : 'pas de différence utile'

  process.stdout.write(`  ${pattern}\n`)
  process.stdout.write(
    `    TypeScript ${ts.ms.toFixed(0).padStart(6)} ms  ${String(ts.count).padStart(4)} résultats\n`,
  )
  process.stdout.write(
    `    Rust       ${rust.ms.toFixed(0).padStart(6)} ms  ${String(rust.count).padStart(4)} résultats\n`,
  )
  process.stdout.write(`    → ${speed}\n`)

  if (ts.count !== rust.count) {
    // The finding that outranks the timing: two engines that disagree cannot be
    // swapped for one another, however fast either is.
    process.stdout.write(
      `    ⚠ DÉSACCORD : ${ts.count} contre ${rust.count} — les deux moteurs ne trouvent pas la même chose\n`,
    )
  }
  process.stdout.write('\n')
}

native.close()
