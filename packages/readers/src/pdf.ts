import { spawnSync } from 'node:child_process'
import { inflateRawSync, inflateSync } from 'node:zlib'

/**
 * PDF text extraction.
 *
 * What an agent needs from a PDF — a spec, a paper, an invoice — is its
 * text, in reading order, page by page. `pdftotext` does that best, and is
 * used when it is installed; otherwise this module does it itself: objects
 * found by scanning (so a damaged cross-reference table does not matter),
 * object streams unpacked, the page tree walked in order, and each page's
 * content stream interpreted for its text operators, decoded through the
 * font's `ToUnicode` map or its encoding.
 *
 * Not handled: encrypted files (reported as such), text drawn as images
 * (nothing to extract without OCR), and exact layout — lines come out in the
 * order the page draws them, which for most documents is reading order.
 */

export interface PdfText {
  pages: string[]
  /** Which extractor produced it. */
  via: 'pdftotext' | 'builtin'
}

export class PdfError extends Error {}

/** Extracts the text of every page of the PDF at `path` (whose bytes are `bytes`). */
export function extractPdfText(bytes: Uint8Array, path?: string): PdfText {
  if (path) {
    const fast = viaPdftotext(path)
    if (fast) return fast
  }
  return { pages: new PdfDocument(bytes).pageTexts(), via: 'builtin' }
}

function viaPdftotext(path: string): PdfText | undefined {
  try {
    const run = spawnSync('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (run.status !== 0 || typeof run.stdout !== 'string') return undefined
    const pages = run.stdout.split('\f').map((page) => page.trimEnd())
    // pdftotext ends every page with a form feed, so the last piece is empty.
    if (pages.length > 1 && pages[pages.length - 1] === '') pages.pop()
    return { pages, via: 'pdftotext' }
  } catch {
    return undefined
  }
}

// ---- values -----------------------------------------------------------------

class Name {
  constructor(readonly value: string) {}
}
class Ref {
  constructor(
    readonly num: number,
    readonly gen: number,
  ) {}
}
class Str {
  constructor(readonly bytes: number[]) {}
}
class Op {
  constructor(readonly value: string) {}
}
type Dict = Map<string, Value>
type Value = number | boolean | null | Name | Ref | Str | Op | Value[] | Dict

interface PdfObject {
  value: Value
  stream?: Uint8Array
}

const isDict = (value: Value | undefined): value is Dict => value instanceof Map
const nameOf = (value: Value | undefined) => (value instanceof Name ? value.value : undefined)

// ---- lexer ------------------------------------------------------------------

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const DELIMITERS = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)))
const ESCAPES: Record<number, number> = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c }

class Lexer {
  pos: number
  constructor(
    readonly src: Uint8Array,
    start = 0,
    readonly end = src.length,
  ) {
    this.pos = start
  }

  private skip(): void {
    while (this.pos < this.end) {
      const c = this.src[this.pos]!
      if (WHITESPACE.has(c)) {
        this.pos++
      } else if (c === 0x25) {
        // A comment runs to the end of the line.
        while (this.pos < this.end && this.src[this.pos] !== 0x0a && this.src[this.pos] !== 0x0d) this.pos++
      } else {
        break
      }
    }
  }

  private word(): string {
    const start = this.pos
    while (this.pos < this.end && !WHITESPACE.has(this.src[this.pos]!) && !DELIMITERS.has(this.src[this.pos]!)) this.pos++
    return latin1(this.src, start, this.pos)
  }

  /** The next value, or an operator; `undefined` at the end. */
  value(): Value | undefined {
    this.skip()
    if (this.pos >= this.end) return undefined
    const c = this.src[this.pos]!
    if (c === 0x2f) {
      this.pos++
      return new Name(this.word().replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))))
    }
    if (c === 0x28) return this.literal()
    if (c === 0x3c) {
      if (this.src[this.pos + 1] === 0x3c) {
        this.pos += 2
        return this.dict()
      }
      return this.hex()
    }
    if (c === 0x5b) {
      this.pos++
      const items: Value[] = []
      for (;;) {
        this.skip()
        if (this.pos >= this.end) break
        if (this.src[this.pos] === 0x5d) {
          this.pos++
          break
        }
        const item = this.value()
        if (item === undefined) break
        items.push(item)
      }
      return items
    }
    if (c === 0x5d || c === 0x3e || c === 0x7b || c === 0x7d) {
      // Stray closers: skip them rather than stall.
      this.pos++
      return this.value()
    }
    const word = this.word()
    if (word === '') {
      this.pos++
      return this.value()
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      const number = Number(word)
      // `12 0 R` is a reference.
      if (/^\d+$/.test(word)) {
        const saved = this.pos
        this.skip()
        const gen = this.word()
        if (/^\d+$/.test(gen)) {
          this.skip()
          const next = this.src[this.pos + 1]
          if (this.src[this.pos] === 0x52 && (next === undefined || WHITESPACE.has(next) || DELIMITERS.has(next))) {
            this.pos++
            return new Ref(number, Number(gen))
          }
        }
        this.pos = saved
      }
      return number
    }
    if (word === 'true') return true
    if (word === 'false') return false
    if (word === 'null') return null
    return new Op(word)
  }

  private dict(): Dict {
    const dict: Dict = new Map()
    for (;;) {
      this.skip()
      if (this.pos >= this.end) break
      if (this.src[this.pos] === 0x3e && this.src[this.pos + 1] === 0x3e) {
        this.pos += 2
        break
      }
      const key = this.value()
      if (key === undefined) break
      if (!(key instanceof Name)) continue
      const value = this.value()
      if (value === undefined) break
      dict.set(key.value, value)
    }
    return dict
  }

  private literal(): Str {
    this.pos++
    const bytes: number[] = []
    let depth = 1
    while (this.pos < this.end) {
      const c = this.src[this.pos++]!
      if (c === 0x5c) {
        const e = this.src[this.pos++]
        if (e === undefined) break
        if (ESCAPES[e] !== undefined) {
          bytes.push(ESCAPES[e]!)
        } else if (e >= 0x30 && e <= 0x37) {
          let octal = e - 0x30
          for (let i = 0; i < 2 && this.src[this.pos]! >= 0x30 && this.src[this.pos]! <= 0x37; i++) {
            octal = octal * 8 + (this.src[this.pos++]! - 0x30)
          }
          bytes.push(octal & 0xff)
        } else if (e === 0x0d) {
          if (this.src[this.pos] === 0x0a) this.pos++
        } else if (e !== 0x0a) {
          bytes.push(e)
        }
        continue
      }
      if (c === 0x28) depth++
      if (c === 0x29 && --depth === 0) break
      bytes.push(c)
    }
    return new Str(bytes)
  }

  private hex(): Str {
    this.pos++
    let digits = ''
    while (this.pos < this.end && this.src[this.pos] !== 0x3e) {
      const c = String.fromCharCode(this.src[this.pos++]!)
      if (/[0-9a-fA-F]/.test(c)) digits += c
    }
    this.pos++
    if (digits.length % 2) digits += '0'
    const bytes: number[] = []
    for (let i = 0; i < digits.length; i += 2) bytes.push(Number.parseInt(digits.slice(i, i + 2), 16))
    return new Str(bytes)
  }

  /** Skips an inline image's data, which follows `ID` up to `EI`. */
  skipInlineImage(): void {
    this.pos++
    while (this.pos < this.end - 1) {
      const after = this.src[this.pos + 2]
      if (
        this.src[this.pos] === 0x45 &&
        this.src[this.pos + 1] === 0x49 &&
        WHITESPACE.has(this.src[this.pos - 1]!) &&
        (after === undefined || WHITESPACE.has(after))
      ) {
        this.pos += 2
        return
      }
      this.pos++
    }
    this.pos = this.end
  }
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset + start, Math.max(0, end - start)).toString('latin1')
}

// ---- the document -----------------------------------------------------------

class PdfDocument {
  private readonly objects = new Map<number, PdfObject>()
  private readonly source: string

  constructor(private readonly bytes: Uint8Array) {
    this.source = latin1(bytes, 0, bytes.length)
    if (!this.source.slice(0, 1024).includes('%PDF')) throw new PdfError('not a PDF (no %PDF header)')
    this.scan()
    this.unpackObjectStreams()
    if (this.encrypted()) throw new PdfError('the PDF is encrypted; its text cannot be read without the password')
  }

  /** Finds every `n g obj ... endobj` by scanning, later definitions winning. */
  private scan(): void {
    const { bytes, source } = this
    const header = /(\d+)\s+(\d+)\s+obj\b/g
    for (let match = header.exec(source); match; match = header.exec(source)) {
      const lexer = new Lexer(bytes, match.index + match[0].length)
      const value = lexer.value()
      if (value === undefined) continue
      const object: PdfObject = { value }
      // A stream follows its dictionary: `stream` EOL data EOL `endstream`.
      let after = lexer.pos
      while (after < bytes.length && WHITESPACE.has(bytes[after]!)) after++
      if (isDict(value) && source.startsWith('stream', after)) {
        let start = after + 6
        if (bytes[start] === 0x0d) start++
        if (bytes[start] === 0x0a) start++
        const declared = value.get('Length')
        let end = typeof declared === 'number' ? start + declared : -1
        if (end < start || end > bytes.length || !source.slice(end, end + 24).includes('endstream')) {
          end = source.indexOf('endstream', start)
          if (end < 0) end = bytes.length
          while (end > start && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end--
        }
        object.stream = bytes.subarray(start, end)
        header.lastIndex = end
      }
      this.objects.set(Number(match[1]), object)
    }
  }

  private unpackObjectStreams(): void {
    for (const object of [...this.objects.values()]) {
      if (!isDict(object.value) || nameOf(object.value.get('Type')) !== 'ObjStm' || !object.stream) continue
      let data: Uint8Array
      try {
        data = this.decode(object)
      } catch {
        continue
      }
      const count = this.number(object.value.get('N'))
      const first = this.number(object.value.get('First'))
      const header = new Lexer(data, 0, first)
      const entries: [number, number][] = []
      for (let i = 0; i < count; i++) {
        const num = header.value()
        const offset = header.value()
        if (typeof num !== 'number' || typeof offset !== 'number') break
        entries.push([num, offset])
      }
      for (const [num, offset] of entries) {
        if (this.objects.has(num)) continue
        const value = new Lexer(data, first + offset).value()
        if (value !== undefined) this.objects.set(num, { value })
      }
    }
  }

  private encrypted(): boolean {
    const tail = this.source.slice(Math.max(0, this.source.length - 8192))
    const trailer = tail.lastIndexOf('trailer')
    if (trailer >= 0 && /\/Encrypt\b/.test(tail.slice(trailer))) return true
    // A cross-reference stream carries the trailer's keys itself.
    return [...this.objects.values()].some((o) => isDict(o.value) && nameOf(o.value.get('Type')) === 'XRef' && o.value.has('Encrypt'))
  }

  resolve(value: Value | undefined, depth = 0): Value | undefined {
    if (value instanceof Ref && depth < 32) return this.resolve(this.objects.get(value.num)?.value, depth + 1)
    return value
  }

  private objectOf(value: Value | undefined): PdfObject | undefined {
    return value instanceof Ref ? this.objects.get(value.num) : undefined
  }

  private number(value: Value | undefined): number {
    const resolved = this.resolve(value)
    return typeof resolved === 'number' ? resolved : 0
  }

  private dict(value: Value | undefined): Dict | undefined {
    const resolved = this.resolve(value)
    return isDict(resolved) ? resolved : undefined
  }

  /** A stream's bytes with its filters undone. */
  decode(object: PdfObject): Uint8Array {
    let data = object.stream ?? new Uint8Array()
    if (!isDict(object.value)) return data
    const filterValue = this.resolve(object.value.get('Filter'))
    const filters = (Array.isArray(filterValue) ? filterValue : [filterValue])
      .map((f) => nameOf(this.resolve(f)))
      .filter((f): f is string => f !== undefined)
    const paramsValue = this.resolve(object.value.get('DecodeParms'))
    const params = Array.isArray(paramsValue) ? paramsValue.map((p) => this.dict(p)) : [this.dict(paramsValue)]
    const number = (v: Value | undefined) => this.number(v)
    filters.forEach((filter, index) => {
      switch (filter) {
        case 'FlateDecode':
        case 'Fl':
          data = unpredict(inflate(data), params[index], number)
          break
        case 'ASCIIHexDecode':
        case 'AHx':
          data = asciiHex(data)
          break
        case 'ASCII85Decode':
        case 'A85':
          data = ascii85(data)
          break
        case 'LZWDecode':
        case 'LZW':
          data = unpredict(lzw(data), params[index], number)
          break
        default:
          // Image codecs carry no text.
          throw new PdfError(`unsupported filter ${filter}`)
      }
    })
    return data
  }

  /** The pages in order, walking the page tree from the catalog. */
  private pages(): { page: Dict; resources: Dict | undefined }[] {
    const catalog = [...this.objects.values()]
      .map((o) => o.value)
      .find((v): v is Dict => isDict(v) && nameOf(v.get('Type')) === 'Catalog')
    const pages: { page: Dict; resources: Dict | undefined }[] = []
    const seen = new Set<Dict>()
    const walk = (node: Dict | undefined, inherited: Dict | undefined) => {
      if (!node || seen.has(node)) return
      seen.add(node)
      const resources = this.dict(node.get('Resources')) ?? inherited
      const kids = this.resolve(node.get('Kids'))
      if (Array.isArray(kids)) {
        for (const kid of kids) walk(this.dict(kid), resources)
      } else if (nameOf(node.get('Type')) === 'Page' || node.has('Contents')) {
        pages.push({ page: node, resources })
      }
    }
    walk(this.dict(catalog?.get('Pages')), undefined)
    if (pages.length > 0) return pages
    // No usable tree: every page object, in object order.
    return [...this.objects.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, o]) => o.value)
      .filter((v): v is Dict => isDict(v) && nameOf(v.get('Type')) === 'Page')
      .map((page) => ({ page, resources: this.dict(page.get('Resources')) }))
  }

  pageTexts(): string[] {
    return this.pages().map(({ page, resources }) => {
      const contents = this.resolve(page.get('Contents'))
      const parts = Array.isArray(contents) ? contents : [page.get('Contents')]
      const chunks: Uint8Array[] = []
      for (const part of parts) {
        const object = this.objectOf(part)
        if (!object?.stream) continue
        try {
          chunks.push(this.decode(object), new Uint8Array([0x0a]))
        } catch {
          // A stream that will not decode is skipped; the rest of the page is still text.
        }
      }
      return new TextRun(concat(chunks), this.fonts(resources), (name) => this.form(resources, name)).text()
    })
  }

  /** A form XObject's content and fonts, for pages that draw text through one. */
  private form(resources: Dict | undefined, name: string): { content: Uint8Array; fonts: Map<string, Font> } | undefined {
    const object = this.objectOf(this.dict(resources?.get('XObject'))?.get(name))
    if (!object?.stream || !isDict(object.value) || nameOf(object.value.get('Subtype')) !== 'Form') return undefined
    try {
      return { content: this.decode(object), fonts: this.fonts(this.dict(object.value.get('Resources')) ?? resources) }
    } catch {
      return undefined
    }
  }

  private readonly fontCache = new Map<Dict, Font>()

  private fonts(resources: Dict | undefined): Map<string, Font> {
    const fonts = new Map<string, Font>()
    const dict = this.dict(resources?.get('Font'))
    if (!dict) return fonts
    for (const [name, ref] of dict) {
      const font = this.dict(ref)
      if (!font) continue
      let built = this.fontCache.get(font)
      if (!built) {
        built = this.font(font)
        this.fontCache.set(font, built)
      }
      fonts.set(name, built)
    }
    return fonts
  }

  private font(font: Dict): Font {
    const toUnicode = this.objectOf(font.get('ToUnicode'))
    let cmap: CMap | undefined
    if (toUnicode?.stream) {
      try {
        cmap = parseCMap(this.decode(toUnicode))
      } catch {
        cmap = undefined
      }
    }
    const composite = nameOf(font.get('Subtype')) === 'Type0'
    const encoding = this.resolve(font.get('Encoding'))
    const table = simpleEncoding(nameOf(encoding) ?? nameOf(this.dict(encoding)?.get('BaseEncoding')))
    const differences = this.resolve(this.dict(encoding)?.get('Differences'))
    if (Array.isArray(differences)) {
      let code = 0
      for (const item of differences) {
        if (typeof item === 'number') code = item
        else if (item instanceof Name) table[code++] = glyphToUnicode(item.value)
      }
    }
    return { cmap, composite, table }
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

// ---- filters ----------------------------------------------------------------

function inflate(data: Uint8Array): Uint8Array {
  try {
    return inflateSync(data)
  } catch {
    try {
      return inflateRawSync(data.subarray(2))
    } catch (error) {
      throw new PdfError(`a compressed stream is damaged (${error instanceof Error ? error.message : String(error)})`)
    }
  }
}

/** Undoes a PNG predictor, which object and cross-reference streams often use. */
function unpredict(data: Uint8Array, params: Dict | undefined, number: (value: Value | undefined) => number): Uint8Array {
  const predictor = params ? number(params.get('Predictor')) : 1
  if (predictor < 10) return data
  const colors = Math.max(1, number(params?.get('Colors')) || 1)
  const bits = number(params?.get('BitsPerComponent')) || 8
  const columns = number(params?.get('Columns')) || 1
  const bpp = Math.max(1, Math.ceil((colors * bits) / 8))
  const rowLength = Math.ceil((colors * bits * columns) / 8)
  const rows = Math.floor(data.length / (rowLength + 1))
  const out = new Uint8Array(rows * rowLength)
  let previous = new Uint8Array(rowLength)
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLength + 1)]!
    const row = data.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1))
    const current = new Uint8Array(rowLength)
    for (let i = 0; i < rowLength; i++) {
      const left = i >= bpp ? current[i - bpp]! : 0
      const up = previous[i]!
      const upLeft = i >= bpp ? previous[i - bpp]! : 0
      let value = row[i]!
      if (type === 1) value += left
      else if (type === 2) value += up
      else if (type === 3) value += (left + up) >> 1
      else if (type === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      current[i] = value & 0xff
    }
    out.set(current, r * rowLength)
    previous = current
  }
  return out
}

function asciiHex(data: Uint8Array): Uint8Array {
  const hex = (latin1(data, 0, data.length).split('>')[0] ?? '').replace(/[^0-9a-fA-F]/g, '')
  const padded = hex.length % 2 ? `${hex}0` : hex
  const out = new Uint8Array(padded.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16)
  return out
}

function ascii85(data: Uint8Array): Uint8Array {
  const text = latin1(data, 0, data.length).replace(/\s+/g, '').replace(/^<~/, '').split('~>')[0] ?? ''
  const out: number[] = []
  let group: number[] = []
  const flush = (digits: number[], keep: number) => {
    let value = 0
    for (const digit of digits) value = value * 85 + digit
    out.push(...[(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].slice(0, keep))
  }
  for (const char of text) {
    if (char === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0)
      continue
    }
    group.push(char.charCodeAt(0) - 33)
    if (group.length === 5) {
      flush(group, 4)
      group = []
    }
  }
  if (group.length > 1) {
    const keep = group.length - 1
    while (group.length < 5) group.push(84)
    flush(group, keep)
  }
  return new Uint8Array(out)
}

function lzw(data: Uint8Array): Uint8Array {
  const out: number[] = []
  let table: number[][] = []
  const reset = () => {
    table = Array.from({ length: 258 }, (_, i) => (i < 256 ? [i] : []))
  }
  reset()
  let width = 9
  let bits = 0
  let count = 0
  let previous: number[] | undefined
  for (const byte of data) {
    bits = ((bits << 8) | byte) & 0xffffff
    count += 8
    while (count >= width) {
      const code = (bits >> (count - width)) & ((1 << width) - 1)
      count -= width
      if (code === 256) {
        reset()
        width = 9
        previous = undefined
        continue
      }
      if (code === 257) return new Uint8Array(out)
      let entry = table[code]
      if (!entry || entry.length === 0) entry = previous ? [...previous, previous[0]!] : []
      out.push(...entry)
      if (previous && entry.length > 0) table.push([...previous, entry[0]!])
      previous = entry
      // PDF's LZW widens the code one entry early.
      if (table.length + 1 >= 1 << width && width < 12) width++
    }
  }
  return new Uint8Array(out)
}

// ---- fonts ------------------------------------------------------------------

interface CMap {
  /** Code lengths in bytes the map's code space uses, longest first. */
  widths: number[]
  map: Map<number, string>
  ranges: { lo: number; hi: number; bytes: number }[]
}

interface Font {
  cmap?: CMap
  composite: boolean
  /** Byte code to text, for simple fonts. */
  table: string[]
}

function utf16(str: Str): string {
  let out = ''
  for (let i = 0; i + 1 < str.bytes.length; i += 2) out += String.fromCharCode((str.bytes[i]! << 8) | str.bytes[i + 1]!)
  if (str.bytes.length % 2) out += String.fromCharCode(str.bytes[str.bytes.length - 1]!)
  return out
}

const codeOf = (str: Str) => str.bytes.reduce((n, b) => n * 256 + b, 0)

function parseCMap(data: Uint8Array): CMap {
  const lexer = new Lexer(data)
  const map = new Map<number, string>()
  const ranges: CMap['ranges'] = []
  const operands: Value[] = []
  for (let value = lexer.value(); value !== undefined; value = lexer.value()) {
    if (!(value instanceof Op)) {
      operands.push(value)
      continue
    }
    const op = value.value
    if (op === 'endcodespacerange') {
      for (let i = 0; i + 1 < operands.length; i += 2) {
        const lo = operands[i]
        const hi = operands[i + 1]
        if (lo instanceof Str && hi instanceof Str) ranges.push({ lo: codeOf(lo), hi: codeOf(hi), bytes: lo.bytes.length })
      }
    } else if (op === 'endbfchar') {
      for (let i = 0; i + 1 < operands.length; i += 2) {
        const src = operands[i]
        const dst = operands[i + 1]
        if (src instanceof Str && dst instanceof Str) map.set(codeOf(src), utf16(dst))
        else if (src instanceof Str && dst instanceof Name) map.set(codeOf(src), glyphToUnicode(dst.value))
      }
    } else if (op === 'endbfrange') {
      for (let i = 0; i + 2 < operands.length; i += 3) {
        const lo = operands[i]
        const hi = operands[i + 1]
        const dst = operands[i + 2]
        if (!(lo instanceof Str) || !(hi instanceof Str)) continue
        const start = codeOf(lo)
        const end = Math.min(codeOf(hi), start + 65535)
        if (dst instanceof Str) {
          const base = utf16(dst)
          const last = base.charCodeAt(base.length - 1)
          for (let c = start; c <= end; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - start)))
        } else if (Array.isArray(dst)) {
          dst.forEach((item, offset) => {
            if (item instanceof Str) map.set(start + offset, utf16(item))
          })
        }
      }
    }
    operands.length = 0
  }
  const widths = [...new Set(ranges.map((r) => r.bytes))].sort((a, b) => b - a)
  return { widths: widths.length > 0 ? widths : [2, 1], map, ranges }
}

function decodeString(bytes: number[], font: Font | undefined): string {
  if (!font) return String.fromCharCode(...bytes)
  const { cmap } = font
  if (!cmap) {
    // A composite font without a ToUnicode map has no recoverable text.
    return font.composite ? '' : bytes.map((b) => font.table[b] ?? '').join('')
  }
  let out = ''
  for (let i = 0; i < bytes.length; ) {
    let used = 0
    for (const width of cmap.widths) {
      if (i + width > bytes.length) continue
      let code = 0
      for (let k = 0; k < width; k++) code = code * 256 + bytes[i + k]!
      const inSpace = cmap.ranges.length === 0 || cmap.ranges.some((r) => r.bytes === width && code >= r.lo && code <= r.hi)
      if (!inSpace) continue
      out += cmap.map.get(code) ?? (width === 1 && !font.composite ? (font.table[code] ?? '') : '')
      used = width
      break
    }
    if (used === 0) {
      out += font.composite ? '' : (font.table[bytes[i]!] ?? '')
      used = font.composite ? 2 : 1
    }
    i += used
  }
  return out
}

/** Windows-1252 over Latin-1: what WinAnsi, and most unlabelled fonts, mean. */
const WIN_ANSI_HIGH: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
}

function simpleEncoding(name: string | undefined): string[] {
  const table = Array.from({ length: 256 }, (_, i) => (i < 32 ? '' : String.fromCharCode(i)))
  if (name === 'StandardEncoding') {
    table[0x27] = '’'
    table[0x60] = '‘'
  } else if (name !== 'MacRomanEncoding') {
    for (const [code, char] of Object.entries(WIN_ANSI_HIGH)) table[Number(code)] = char
  }
  return table
}

const GLYPHS: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'", quoteright: '’', quoteleft: '‘',
  parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', minus: '−', period: '.', slash: '/', colon: ':', semicolon: ';',
  less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_',
  grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~', bullet: '•', endash: '–', emdash: '—', quotedblleft: '“', quotedblright: '”',
  ellipsis: '…', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', copyright: '©', registered: '®', trademark: '™', degree: '°', section: '§',
  paragraph: '¶', dagger: '†', daggerdbl: '‡', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  eacute: 'é', egrave: 'è', ecircumflex: 'ê', agrave: 'à', acircumflex: 'â', ccedilla: 'ç', ocircumflex: 'ô', ucircumflex: 'û', ugrave: 'ù', icircumflex: 'î',
  idieresis: 'ï', edieresis: 'ë', udieresis: 'ü', odieresis: 'ö', adieresis: 'ä', germandbls: 'ß', Eacute: 'É', nbspace: ' ', uni00A0: ' ',
}

function glyphToUnicode(name: string): string {
  if (GLYPHS[name] !== undefined) return GLYPHS[name]!
  if (/^[A-Za-z]$/.test(name)) return name
  const uni = /^uni([0-9A-Fa-f]{4,})$/.exec(name) ?? /^u([0-9A-Fa-f]{4,6})$/.exec(name)
  if (uni) {
    const hex = uni[1]!
    let out = ''
    for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCodePoint(Number.parseInt(hex.slice(i, i + 4), 16))
    return out
  }
  // `a.sc`, `T_h` — a variant of a known glyph.
  const base = name.split(/[._]/)[0] ?? ''
  return base && base !== name ? glyphToUnicode(base) : ''
}

// ---- content streams --------------------------------------------------------

/**
 * Walks a content stream's text operators and lays the text out in lines:
 * a new line where the text moves down, a space where it jumps right or a
 * `TJ` kerning gap is as wide as one.
 */
class TextRun {
  private readonly lines: string[] = []
  private line = ''
  private font: Font | undefined
  private lastY: number | undefined
  private depth = 0

  constructor(
    private readonly content: Uint8Array,
    private readonly fonts: Map<string, Font>,
    private readonly form: (name: string) => { content: Uint8Array; fonts: Map<string, Font> } | undefined,
  ) {}

  text(): string {
    this.run(this.content, this.fonts)
    this.newline()
    return this.lines
      .join('\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  private newline(): void {
    if (this.line.trim()) this.lines.push(this.line.trimEnd())
    this.line = ''
  }

  private space(): void {
    if (this.line && !this.line.endsWith(' ')) this.line += ' '
  }

  private run(content: Uint8Array, fonts: Map<string, Font>): void {
    if (this.depth > 8) return
    this.depth++
    const lexer = new Lexer(content)
    const operands: Value[] = []
    for (let value = lexer.value(); value !== undefined; value = lexer.value()) {
      if (!(value instanceof Op)) {
        operands.push(value)
        if (operands.length > 64) operands.shift()
        continue
      }
      const num = (i: number) => (typeof operands[i] === 'number' ? (operands[i] as number) : 0)
      switch (value.value) {
        case 'Tf': {
          const name = nameOf(operands[0])
          this.font = name ? fonts.get(name) : undefined
          break
        }
        case 'Td':
        case 'TD':
          if (Math.abs(num(1)) > 0.5) {
            this.lastY = (this.lastY ?? 0) + num(1)
            this.newline()
          } else if (num(0) > 1) {
            this.space()
          }
          break
        case 'Tm': {
          const y = num(5)
          if (this.lastY !== undefined && Math.abs(y - this.lastY) > 1) this.newline()
          else if (this.line) this.space()
          this.lastY = y
          break
        }
        case 'T*':
          this.newline()
          break
        case 'Tj':
          if (operands[0] instanceof Str) this.line += decodeString(operands[0].bytes, this.font)
          break
        case "'":
        case '"': {
          this.newline()
          const str = operands[operands.length - 1]
          if (str instanceof Str) this.line += decodeString(str.bytes, this.font)
          break
        }
        case 'TJ': {
          const items = operands[0]
          if (Array.isArray(items)) {
            for (const item of items) {
              if (item instanceof Str) this.line += decodeString(item.bytes, this.font)
              // A gap of more than about a quarter of an em reads as a space.
              else if (typeof item === 'number' && item < -250) this.space()
            }
          }
          break
        }
        case 'Do': {
          const name = nameOf(operands[0])
          const form = name ? this.form(name) : undefined
          if (form) this.run(form.content, form.fonts)
          break
        }
        case 'ID':
          lexer.skipInlineImage()
          break
        default:
          break
      }
      operands.length = 0
    }
    this.depth--
  }
}
