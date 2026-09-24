/**
 * Prints the wordmark the way the interface will draw it.
 *
 * `bun packages/tui2/preview-banner.ts [width]`
 *
 * Exists so the banner can be checked without starting the whole interface —
 * a full-screen app is an awkward place to iterate on six rows of ASCII.
 */

import {
  LOGO,
  LOGO_SMALL,
  LOGO_TEXT,
  SHADOW_CHARS,
  logoSizeFor,
  parseLogoLines,
} from './src/branding/logo'

const ESC = String.fromCharCode(27)
const RESET = `${ESC}[0m`

/** White blocks, acid-green shadows — the default palette's logo colours. */
const BLOCK = `${ESC}[38;2;255;255;255m`
const ACCENT = `${ESC}[38;2;158;252;98m`
const MUTED = `${ESC}[38;2;140;150;137m`

const width = Number(process.argv[2] ?? process.stdout.columns ?? 80)
const size = logoSizeFor(width)

/**
 * Colours one row, blocks and shadows separately.
 *
 * Runs of the same class are emitted as a single escape sequence rather than
 * one per character: on a 70-column banner that is ~20 sequences instead of
 * ~420, which is the difference between a clean paint and a visible flicker.
 */
function colorize(line: string): string {
  let out = ''
  let run = ''
  let runIsShadow: boolean | undefined

  const flush = () => {
    if (run === '') return
    out += `${runIsShadow === true ? ACCENT : BLOCK}${run}${RESET}`
    run = ''
  }

  for (const character of line) {
    // A space belongs to whichever run it sits in; switching colour for it
    // would emit a sequence that changes nothing visible.
    if (character === ' ') {
      run += character
      continue
    }

    const isShadow = SHADOW_CHARS.has(character)
    if (runIsShadow !== undefined && isShadow !== runIsShadow) flush()

    runIsShadow = isShadow
    run += character
  }

  flush()
  return out
}

process.stdout.write(`\n${MUTED}width ${width} → ${size}${RESET}\n\n`)

const rows =
  size === 'full'
    ? parseLogoLines(LOGO)
    : size === 'small'
      ? parseLogoLines(LOGO_SMALL)
      : size === 'text'
        ? [LOGO_TEXT]
        : []

for (const row of rows) {
  process.stdout.write(`${colorize(row)}\n`)
}

if (rows.length > 0) {
  const widths = new Set(rows.map((row) => row.length))
  process.stdout.write(
    `\n${MUTED}${rows.length} rows, ${[...widths].join('/')} columns` +
      `${widths.size > 1 ? '  ← RAGGED: rows must be equal width' : ''}${RESET}\n`,
  )
}

process.stdout.write(
  `${MUTED}Jean Code will read your files and run commands on your behalf.${RESET}\n\n`,
)
