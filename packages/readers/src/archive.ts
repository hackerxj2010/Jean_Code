import { inflateRawSync, gunzipSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'

/**
 * Archive reading (architecture §8.1).
 *
 * ZIP and TAR are parsed here rather than shelled out to, because `unzip` and
 * `tar` behave differently across platforms and neither reliably exists on
 * Windows. Both formats are simple enough that a correct reader is smaller than
 * the code needed to normalize three implementations of the CLI tools.
 *
 * Only `store` and `deflate` compression are handled for ZIP — together they
 * cover essentially every archive in practice.
 */

export interface ArchiveEntry {
  path: string
  size: number
  compressedSize: number
  isDirectory: boolean
  /** Read lazily: an archive can be far larger than memory. */
  read: () => Promise<Buffer>
}

/** ZIP end-of-central-directory signature. */
const EOCD = 0x06054b50
const CENTRAL_HEADER = 0x02014b50

/**
 * Lists a ZIP archive's entries.
 *
 * Read from the central directory at the end of the file rather than by walking
 * local headers forward: the central directory is authoritative, and a
 * forward walk misreads any archive written with data descriptors.
 */
export function readZip(buffer: Buffer): ArchiveEntry[] {
  const eocdOffset = findEocd(buffer)
  if (eocdOffset === -1) throw new Error('not a ZIP archive: no end-of-central-directory record')

  const entryCount = buffer.readUInt16LE(eocdOffset + 10)
  let offset = buffer.readUInt32LE(eocdOffset + 16)

  const entries: ArchiveEntry[] = []

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.length) break
    if (buffer.readUInt32LE(offset) !== CENTRAL_HEADER) break

    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)

    const path = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')

    entries.push({
      path,
      size,
      compressedSize,
      isDirectory: path.endsWith('/'),
      read: async () => extractZipEntry(buffer, localOffset, method, compressedSize),
    })

    offset += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

function findEocd(buffer: Buffer): number {
  // The record is at the end but may be followed by a comment of up to 64KB,
  // so the tail is scanned backwards for the signature.
  const start = Math.max(0, buffer.length - 65_557)
  for (let i = buffer.length - 22; i >= start; i--) {
    if (buffer.readUInt32LE(i) === EOCD) return i
  }
  return -1
}

function extractZipEntry(
  buffer: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
): Buffer {
  // The local header's name and extra lengths differ from the central
  // directory's, so they are re-read here rather than reused.
  const nameLength = buffer.readUInt16LE(localOffset + 26)
  const extraLength = buffer.readUInt16LE(localOffset + 28)
  const dataStart = localOffset + 30 + nameLength + extraLength
  const data = buffer.subarray(dataStart, dataStart + compressedSize)

  if (method === 0) return Buffer.from(data)
  if (method === 8) return inflateRawSync(data)
  throw new Error(`unsupported ZIP compression method ${method}`)
}

/**
 * Lists a TAR archive's entries.
 *
 * TAR is a sequence of 512-byte headers each followed by its file content,
 * padded to a 512-byte boundary. GNU long names are handled because any archive
 * of a real source tree contains them.
 */
export function readTar(buffer: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  let offset = 0
  let longName: string | undefined

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)

    // Two consecutive zero blocks mark the end.
    if (header.every((byte) => byte === 0)) break

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeField = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
    const size = Number.parseInt(sizeField, 8) || 0
    const typeFlag = header.subarray(156, 157).toString('ascii')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')

    const dataStart = offset + 512
    const padded = Math.ceil(size / 512) * 512

    // 'L' is a GNU long-name record: its content is the next entry's real name.
    if (typeFlag === 'L') {
      longName = buffer.subarray(dataStart, dataStart + size).toString('utf8').replace(/\0.*$/, '')
      offset = dataStart + padded
      continue
    }

    const path = longName ?? (prefix ? `${prefix}/${rawName}` : rawName)
    longName = undefined

    if (path) {
      const start = dataStart
      entries.push({
        path,
        size,
        compressedSize: size,
        isDirectory: typeFlag === '5' || path.endsWith('/'),
        read: async () => Buffer.from(buffer.subarray(start, start + size)),
      })
    }

    offset = dataStart + padded
  }

  return entries
}

/** Reads an archive from disk, detecting the format from its magic bytes. */
export async function readArchive(path: string): Promise<ArchiveEntry[]> {
  let buffer = await readFile(path)

  // Gzip wrapping: `.tar.gz` and `.tgz` are a tar inside a gzip stream.
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    buffer = gunzipSync(buffer)
  }

  if (buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50) return readZip(buffer)
  if (buffer.length > 262 && buffer.subarray(257, 262).toString('ascii') === 'ustar') {
    return readTar(buffer)
  }

  // A ZIP whose first entry was removed still has a valid central directory.
  if (findEocd(buffer) !== -1) return readZip(buffer)

  // TAR has no magic in older formats; the header checksum is the tell.
  if (looksLikeTar(buffer)) return readTar(buffer)

  throw new Error('unrecognized archive format (expected ZIP, TAR, or gzipped TAR)')
}

function looksLikeTar(buffer: Buffer): boolean {
  if (buffer.length < 512) return false
  const checksumField = buffer.subarray(148, 156).toString('ascii').replace(/\0.*$/, '').trim()
  const declared = Number.parseInt(checksumField, 8)
  if (Number.isNaN(declared)) return false

  // The checksum is computed with its own field treated as spaces.
  let sum = 0
  for (let i = 0; i < 512; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : buffer[i]!
  }
  return sum === declared
}

/** Whether a path looks like an archive, by extension. */
export function isArchive(path: string): boolean {
  return /\.(zip|tar|tgz|tar\.gz|jar|whl|egg|nupkg|crate)$/i.test(path)
}
