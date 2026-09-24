/**
 * Is the native bridge actually faster than the TypeScript path?
 *
 * `bun scripts/bench-native.ts`
 *
 * Written before routing any tool through the bridge, because "native is
 * faster" is an assumption until measured — and if the round trip costs more
 * than it saves on this workload, the right move is to leave the tools alone
 * and say so.
 */

import { Native } from '../packages/native/src/index.ts'
import { walk } from '../packages/tools/src/search.ts'

const ROOT = process.cwd()
/** Enough repetitions that process noise averages out. */
const RUNS = 5

interface Timing {
  label: string
  ms: number
  count: number
}

async function time(label: string, run: () => Promise<number>): Promise<Timing> {
  // One warm-up, discarded: the first run pays for module loading, the child
  // spawn, and a cold filesystem cache, none of which repeat.
  await run()

  const samples: number[] = []
  let count = 0

  for (let index = 0; index < RUNS; index++) {
    const started = performance.now()
    count = await run()
    samples.push(performance.now() - started)
  }

  // The median rather than the mean: one scheduler hiccup shifts a mean by
  // more than the difference being measured.
  samples.sort((a, b) => a - b)
  return { label, ms: samples[Math.floor(samples.length / 2)]!, count }
}

const native = Native.open()

if (!(await native.available())) {
  process.stderr.write(
    'the native binary is not built — run `cargo build --release -p pi-natives`\n',
  )
  process.exit(1)
}

const results: Timing[] = []

// ---- walking a tree --------------------------------------------------------

results.push(
  await time('walk  · TypeScript', async () => {
    let seen = 0
    for await (const entry of walk(ROOT, { limit: 100_000 })) {
      void entry
      seen++
    }
    return seen
  }),
)

results.push(
  await time('walk  · native', async () => {
    const walked = await native.walk(ROOT, { limit: 100_000 })
    return walked.count
  }),
)

// ---- one coreutil ----------------------------------------------------------

const lines = Array.from({ length: 20_000 }, (_, index) => `line ${index}`).join('\n')

results.push(
  await time('wc    · TypeScript', async () => {
    // What the `text` tool does today: split and count in JS.
    return lines.split('\n').length
  }),
)

results.push(
  await time('wc    · native', async () => {
    const result = await native.builtin('wc', [], lines)
    return Number.parseInt(result.stdout.trim().split(/\s+/)[0] ?? '0', 10)
  }),
)

// ---- structural search over the repo ---------------------------------------

results.push(
  await time('ast   · native (tree)', async () => {
    const matches = await native.searchTree(ROOT, 'export function $NAME($$$ARGS)', {
      glob: 'packages/**/*.ts',
      limit: 500,
    })
    return matches.length
  }),
)

native.close()

// ---- report ----------------------------------------------------------------

const width = Math.max(...results.map((result) => result.label.length))

process.stdout.write('\n')
for (const result of results) {
  process.stdout.write(
    `  ${result.label.padEnd(width)}  ${result.ms.toFixed(1).padStart(8)} ms   ${result.count} results\n`,
  )
}

/** Pairs a TypeScript timing with its native counterpart. */
function compare(prefix: string): void {
  const ts = results.find((r) => r.label.startsWith(prefix) && r.label.includes('TypeScript'))
  const rust = results.find((r) => r.label.startsWith(prefix) && r.label.includes('native'))
  if (!ts || !rust) return

  const ratio = ts.ms / rust.ms
  const verdict =
    ratio > 1.2
      ? `native is ${ratio.toFixed(1)}× faster`
      : ratio < 0.83
        ? `TypeScript is ${(1 / ratio).toFixed(1)}× faster — do not route this`
        : 'no meaningful difference — not worth routing'

  process.stdout.write(`  ${prefix.trim()}: ${verdict}\n`)

  if (ts.count !== rust.count) {
    // A speed comparison between two functions that disagree on the answer is
    // meaningless, and the disagreement is the more important finding.
    process.stdout.write(
      `  ${prefix.trim()}: WARNING — different result counts (${ts.count} vs ${rust.count})\n`,
    )
  }
}

process.stdout.write('\n')
compare('walk')
compare('wc')
process.stdout.write('\n')
