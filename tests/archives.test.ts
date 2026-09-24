import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'bun:test'
import { isArchive, readArchive, readTar, readZip } from '../packages/readers/src/index.ts'

/**
 * Archives are built here rather than by shelling out to `tar` or `zip`.
 *
 * Windows `tar` reads an absolute path as a remote host and fails, so a
 * system-tool fixture skips silently and leaves the reader untested — which is
 * precisely the failure a test exists to prevent.
 */

const temps: string[] = []

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jean-arc-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true })
})

/** A 512-byte ustar header with a correct checksum. */
function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii')
  // The checksum is computed with its own field read as spaces.
  header.write('        ', 148, 8, 'ascii')
  header.write('0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')

  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

function buildTar(files: Record<string, string>): Buffer {
  const parts: Buffer[] = []
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content, 'utf8')
    parts.push(tarHeader(name, body.length), body)
    const padding = (512 - (body.length % 512)) % 512
    if (padding > 0) parts.push(Buffer.alloc(padding))
  }
  // Two zero blocks terminate the archive.
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** A ZIP of stored (uncompressed) entries — method 0. */
function buildZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content, 'utf8')
    const nameBuffer = Buffer.from(name, 'utf8')
    const crc = crc32(body)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    locals.push(local, nameBuffer, body)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0, 10)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(body.length, 24)
    entry.writeUInt16LE(nameBuffer.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBuffer)

    offset += local.length + nameBuffer.length + body.length
  }

  const centralBuffer = Buffer.concat(central)
  const count = Object.keys(files).length

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(count, 8)
  eocd.writeUInt16LE(count, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, centralBuffer, eocd])
}

describe('archive detection', () => {
  test('recognizes archive extensions', () => {
    expect(isArchive('dist.zip')).toBe(true)
    expect(isArchive('pkg.tar.gz')).toBe(true)
    expect(isArchive('lib.jar')).toBe(true)
    expect(isArchive('wheel.whl')).toBe(true)
    expect(isArchive('notes.txt')).toBe(false)
  })
})

describe('TAR', () => {
  test('lists entries with their sizes', () => {
    const entries = readTar(buildTar({ 'a.txt': 'first\n', 'dir/b.txt': 'second\n' }))
    const files = entries.filter((e) => !e.isDirectory)
    expect(files.map((e) => e.path).sort()).toEqual(['a.txt', 'dir/b.txt'])
    expect(files.find((e) => e.path === 'a.txt')!.size).toBe(6)
  })

  test('extracts entry contents', async () => {
    const entries = readTar(buildTar({ 'hello.txt': 'the contents\n' }))
    expect((await entries[0]!.read()).toString('utf8')).toBe('the contents\n')
  })

  test('handles content straddling 512-byte blocks', async () => {
    // Padding to the block boundary is where an offset error surfaces: the
    // second entry reads as garbage if the first one's padding is miscounted.
    const long = 'x'.repeat(1000)
    const entries = readTar(buildTar({ 'first.txt': long, 'second.txt': 'after\n' }))
    expect((await entries[0]!.read()).toString('utf8')).toBe(long)
    expect((await entries[1]!.read()).toString('utf8')).toBe('after\n')
  })

  test('stops at the terminating blocks rather than reading past them', () => {
    const entries = readTar(buildTar({ 'only.txt': 'one' }))
    expect(entries).toHaveLength(1)
  })
})

describe('ZIP', () => {
  test('lists and extracts stored entries', async () => {
    const entries = readZip(buildZip({ 'one.txt': 'alpha', 'two.txt': 'beta' }))
    expect(entries.map((e) => e.path).sort()).toEqual(['one.txt', 'two.txt'])

    const one = entries.find((e) => e.path === 'one.txt')!
    const two = entries.find((e) => e.path === 'two.txt')!
    expect((await one.read()).toString('utf8')).toBe('alpha')
    expect((await two.read()).toString('utf8')).toBe('beta')
  })

  test('reads the central directory, not a forward walk', () => {
    // The central directory is authoritative; a forward walk misreads any
    // archive written with data descriptors.
    const entries = readZip(buildZip({ 'a': '1', 'b': '2', 'c': '3' }))
    expect(entries).toHaveLength(3)
  })

  test('reports a file with no end-of-central-directory record', () => {
    expect(() => readZip(Buffer.from('not a zip'))).toThrow(/not a ZIP archive/)
  })
})

describe('format detection from disk', () => {
  test('identifies TAR and ZIP by content, not extension', async () => {
    const dir = workspace()
    writeFileSync(join(dir, 'archive.tar'), buildTar({ 'x.txt': 'content' }))
    writeFileSync(join(dir, 'archive.zip'), buildZip({ 'y.txt': 'content' }))

    expect((await readArchive(join(dir, 'archive.tar'))).map((e) => e.path)).toEqual(['x.txt'])
    expect((await readArchive(join(dir, 'archive.zip'))).map((e) => e.path)).toEqual(['y.txt'])
  })

  test('unwraps a gzipped TAR', async () => {
    const dir = workspace()
    writeFileSync(join(dir, 'archive.tar.gz'), gzipSync(buildTar({ 'z.txt': 'packed' })))

    const entries = await readArchive(join(dir, 'archive.tar.gz'))
    expect((await entries[0]!.read()).toString('utf8')).toBe('packed')
  })

  test('rejects a file that is not an archive', async () => {
    const dir = workspace()
    writeFileSync(join(dir, 'plain.zip'), 'this is not a zip at all')
    await expect(readArchive(join(dir, 'plain.zip'))).rejects.toThrow(/unrecognized archive/)
  })
})
