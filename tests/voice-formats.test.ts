import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '../packages/config/src/index.ts'
import { NativeBridge, findBinary } from '../packages/native/src/index.ts'
import { createSessionState, readTool, transcribeTool } from '../packages/tools/src/index.ts'

/**
 * Recordings beyond WAV, read and transcribed through `pi-voice`, and the
 * microphone path driven by a stand-in recorder — the same code a real
 * `parecord`, `sox`, or `ffmpeg` feeds.
 */

const built = findBinary() !== undefined
const temps: string[] = []
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jean-voice-')))
  temps.push(dir)
  return dir
}

const RATE = 16_000

/** Silence, a second of a 440 Hz tone standing in for speech, silence. */
function speechLike(): Int16Array {
  const samples = new Int16Array(RATE * 3)
  for (let i = RATE / 2; i < RATE * 1.5; i++)
    samples[i] = Math.round(Math.sin((i / RATE) * 440 * 2 * Math.PI) * 12_000)
  return samples
}

/** A Sun `.au` file: 16-bit big-endian linear PCM. */
function au(samples: Int16Array): Buffer {
  const header = Buffer.alloc(24)
  header.write('.snd', 0)
  header.writeUInt32BE(24, 4)
  header.writeUInt32BE(samples.length * 2, 8)
  header.writeUInt32BE(3, 12)
  header.writeUInt32BE(RATE, 16)
  header.writeUInt32BE(1, 20)
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((sample, i) => data.writeInt16BE(sample, i * 2))
  return Buffer.concat([header, data])
}

/** An AIFF file with the same audio. */
function aiff(samples: Int16Array): Buffer {
  const comm = Buffer.alloc(18)
  comm.writeUInt16BE(1, 0)
  comm.writeUInt32BE(samples.length, 2)
  comm.writeUInt16BE(16, 6)
  // 16000 as an 80-bit extended float: exponent 16383 + 13, mantissa 16000 << 50.
  comm.writeUInt16BE(0x400c, 8)
  comm.writeBigUInt64BE(16000n << 50n, 10)
  const ssnd = Buffer.alloc(8 + samples.length * 2)
  samples.forEach((sample, i) => ssnd.writeInt16BE(sample, 8 + i * 2))
  const chunk = (id: string, body: Buffer) => {
    const head = Buffer.alloc(8)
    head.write(id, 0)
    head.writeUInt32BE(body.length, 4)
    return Buffer.concat([head, body])
  }
  const body = Buffer.concat([Buffer.from('AIFF'), chunk('COMM', comm), chunk('SSND', ssnd)])
  const head = Buffer.alloc(8)
  head.write('FORM', 0)
  head.writeUInt32BE(body.length, 4)
  return Buffer.concat([head, body])
}

const context = (cwd: string) => ({
  cwd,
  config: defaultConfig(),
  session: createSessionState(cwd),
})

describe.skipIf(!built)('recordings beyond WAV', () => {
  test('`read` describes an .au recording: format, length, and where the speech is', async () => {
    const dir = workspace()
    writeFileSync(join(dir, 'memo.au'), au(speechLike()))
    const result = await readTool.execute({ path: 'memo.au' }, context(dir))
    expect(result.output).toContain('AU audio, 3.00s, 16000 Hz')
    expect(result.output).toMatch(/Speech \(1 segment\)/)
  })

  test('`transcribe` prepares an AIFF and sends it to the speech service', async () => {
    const dir = workspace()
    writeFileSync(join(dir, 'memo.aiff'), aiff(speechLike()))
    const uploads: { name: string; size: number }[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const form = await request.formData()
        const file = form.get('file') as File
        uploads.push({ name: file.name, size: file.size })
        return Response.json({ text: 'hello from the recording' })
      },
    })
    const saved = process.env.JEAN_TRANSCRIBE_URL
    process.env.JEAN_TRANSCRIBE_URL = `http://127.0.0.1:${server.port}/v1/audio/transcriptions`
    try {
      const result = await transcribeTool.execute({ path: 'memo.aiff' }, context(dir))
      expect(result.output).toContain('hello from the recording')
      // Trimmed to the speech and sent as a 16 kHz mono WAV: about one second.
      expect(uploads[0]!.name).toBe('memo.wav')
      expect(uploads[0]!.size).toBeLessThan(RATE * 2 * 1.5)
    } finally {
      if (saved === undefined) delete process.env.JEAN_TRANSCRIBE_URL
      else process.env.JEAN_TRANSCRIBE_URL = saved
      server.stop(true)
    }
  })

  test('a recording stops once the speaker has finished', async () => {
    const dir = workspace()
    // A stand-in recorder: writes 16 kHz mono PCM to stdout, with more
    // speech after a long pause, which must not be recorded.
    const pcm = Buffer.alloc(RATE * 2 * 6)
    speechLike().forEach((sample, i) => pcm.writeInt16LE(sample, i * 2))
    for (let i = RATE * 4; i < RATE * 5; i++)
      pcm.writeInt16LE(Math.round(Math.sin(i / 3) * 12_000), i * 2)
    writeFileSync(join(dir, 'stream.pcm'), pcm)
    writeFileSync(
      join(dir, 'recorder.ts'),
      `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(join(dir, 'stream.pcm'))}))\n`,
    )

    const saved = process.env.JEAN_RECORDER
    process.env.JEAN_RECORDER = `bun ${join(dir, 'recorder.ts')}`
    const bridge = new NativeBridge({ binaryPath: findBinary() })
    try {
      const recorders = (await bridge.call('voice.recorders', {})) as { name: string }[]
      expect(recorders[0]?.name).toBe('custom')
      const recording = (await bridge.call(
        'voice.record',
        { output: join(dir, 'take.wav') },
        60_000,
      )) as {
        durationMs: number
        recorder: string
        heardSpeech: boolean
      }
      expect(recording.recorder).toBe('custom')
      expect(recording.heardSpeech).toBe(true)
      // The wait, the speech, and the pause that ended it — not the later speech.
      expect(recording.durationMs).toBeGreaterThan(2000)
      expect(recording.durationMs).toBeLessThan(3000)
    } finally {
      bridge.close()
      if (saved === undefined) delete process.env.JEAN_RECORDER
      else process.env.JEAN_RECORDER = saved
    }
  })
})
