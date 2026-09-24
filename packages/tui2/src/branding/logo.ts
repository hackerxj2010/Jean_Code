/**
 * The JEAN CODE wordmark.
 *
 * ANSI Shadow lettering: solid blocks with a box-drawing shadow behind them.
 * The two character classes are coloured separately — blocks in one colour,
 * shadows in an accent — which is what gives the letterforms depth in a
 * terminal that has no shading to work with.
 *
 * Three sizes, chosen by available width rather than by a flag. A wordmark that
 * wraps is worse than none at all: the shadow characters land under the wrong
 * blocks and the whole thing reads as line noise.
 */

/** Full lettering. 70 columns wide, 6 rows tall. */
export const LOGO = `
     ██╗███████╗ █████╗ ███╗   ██╗   ██████╗  ██████╗ ██████╗ ███████╗
     ██║██╔════╝██╔══██╗████╗  ██║  ██╔════╝ ██╔═══██╗██╔══██╗██╔════╝
     ██║█████╗  ███████║██╔██╗ ██║  ██║      ██║   ██║██║  ██║█████╗
██   ██║██╔══╝  ██╔══██║██║╚██╗██║  ██║      ██║   ██║██║  ██║██╔══╝
╚█████╔╝███████╗██║  ██║██║ ╚████║  ╚██████╗ ╚██████╔╝██████╔╝███████╗
 ╚════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═════╝  ╚═════╝ ╚═════╝ ╚══════╝
`

/** Initials, for a terminal too narrow for the full lettering. 16 columns. */
export const LOGO_SMALL = `
     ██╗ ██████╗
     ██║██╔════╝
     ██║██║
██   ██║██║
╚█████╔╝╚██████╗
 ╚════╝  ╚═════╝
`

/** Below the small logo's width, the name is just text. */
export const LOGO_TEXT = 'JEAN CODE'

/** Width thresholds the sizes switch at. */
export const LOGO_FULL_MIN_WIDTH = 72
export const LOGO_SMALL_MIN_WIDTH = 19

/**
 * The characters drawn in the accent colour.
 *
 * Everything that is not a solid block: the box-drawing runs forming the
 * shadow. Listed explicitly rather than matched with a range, because the range
 * covering these also covers the frame characters used elsewhere in the UI.
 */
export const SHADOW_CHARS = new Set([
  '╚',
  '═',
  '╝',
  '║',
  '╔',
  '╗',
  '╠',
  '╣',
  '╦',
  '╩',
  '╬',
])

/** Where the project lives, for the help text. */
export const WEBSITE_URL = 'https://github.com/jean-code/jean-code'

// ---- the sheen animation --------------------------------------------------

/**
 * A highlight that sweeps across the wordmark once at startup.
 *
 * Deliberately one pass, not a loop: an animation that never stops draws the
 * eye away from the prompt for the whole session.
 */
export const SHEEN_INTERVAL_MS = 45
export const SHEEN_STEP = 2

/** How wide the bright band is, in characters. */
export const SHEEN_WIDTH = 12

/**
 * Splits the logo into rows, dropping the blank lines the template literal
 * leaves at each end, and clips to the available width.
 *
 * Rows are padded to a common width rather than relying on trailing spaces in
 * the source. Several glyphs here — `E`, `C`, `D` — end in whitespace that is
 * part of the letterform, and every formatter, linter, and editor that trims
 * trailing whitespace silently shortens those rows. The result is a wordmark
 * whose right edge is ragged by two columns, which is subtle enough to ship and
 * obvious enough to look broken.
 */
export function parseLogoLines(logo: string, maxWidth?: number): string[] {
  const lines = logo.split('\n')

  // The template literal starts and ends with a newline, so the first and last
  // entries are empty. Trimming every blank line would also eat a deliberately
  // blank row inside the art, so only the ends are trimmed.
  while (lines.length > 0 && lines[0]?.trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop()

  const widest = lines.reduce((max, line) => Math.max(max, line.length), 0)
  const padded = lines.map((line) => line.padEnd(widest, ' '))

  if (maxWidth === undefined) return padded

  return padded.map((line) => (line.length > maxWidth ? line.slice(0, maxWidth) : line))
}

/**
 * The colour for one character of the sheen sweep.
 *
 * `position` is the character's column, `offset` how far the band has travelled.
 * Characters inside the band get the highlight, everything else the base colour,
 * with a one-character falloff so the edge is not a hard line.
 */
export function getSheenColor(
  position: number,
  offset: number,
  baseColor: string,
  highlightColor: string,
): string {
  const distance = Math.abs(position - offset)
  if (distance > SHEEN_WIDTH / 2) return baseColor
  return distance < SHEEN_WIDTH / 4 ? highlightColor : blend(baseColor, highlightColor)
}

/** Averages two hex colours, for the sheen's soft edge. */
function blend(a: string, b: string): string {
  const parse = (hex: string): [number, number, number] => {
    const value = hex.replace('#', '')
    return [
      Number.parseInt(value.slice(0, 2), 16) || 0,
      Number.parseInt(value.slice(2, 4), 16) || 0,
      Number.parseInt(value.slice(4, 6), 16) || 0,
    ]
  }

  const [r1, g1, b1] = parse(a)
  const [r2, g2, b2] = parse(b)
  const mix = (x: number, y: number) => Math.round((x + y) / 2)
  const hex = (value: number) => value.toString(16).padStart(2, '0')

  return `#${hex(mix(r1, r2))}${hex(mix(g1, g2))}${hex(mix(b1, b2))}`
}

/** Which size fits in `width`. */
export function logoSizeFor(width: number): 'full' | 'small' | 'text' | 'none' {
  if (width >= LOGO_FULL_MIN_WIDTH) return 'full'
  if (width >= LOGO_SMALL_MIN_WIDTH) return 'small'
  if (width >= LOGO_TEXT.length) return 'text'
  return 'none'
}

/** The wordmark as plain rows, for a log or a `--no-color` run. */
export function logoText(width: number): string[] {
  switch (logoSizeFor(width)) {
    case 'full':
      return parseLogoLines(LOGO)
    case 'small':
      return parseLogoLines(LOGO_SMALL)
    case 'text':
      return [LOGO_TEXT]
    default:
      return []
  }
}
