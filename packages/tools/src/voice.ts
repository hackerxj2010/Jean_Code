import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { nativeReady } from '@jean/native'
import { displayPath, resolveInWorkspace } from './file.ts'
import type { Tool, ToolResult } from './types.ts'
import { ToolError } from './types.ts'

/**
 * `transcribe` — speech in a recording, as text.
 *
 * `pi-voice` does the part that runs here: it decodes the recording (WAV,
 * FLAC, AIFF, `.au` itself; MP3, Ogg, M4A, WebM through ffmpeg), mixes it to
 * mono, resamples to 16 kHz, and trims the silence at both ends. That is the
 * format every speech-to-text service wants, and usually a fraction of the
 * original upload. The recognition itself goes to a Whisper-compatible
 * endpoint: Groq when `GROQ_API_KEY` is set, OpenAI when `OPENAI_API_KEY` is,
 * or `JEAN_TRANSCRIBE_URL` (with `JEAN_TRANSCRIBE_KEY`) for anything else —
 * a local whisper.cpp server included.
 */

/** Recordings `read` and `transcribe` take. */
export const AUDIO_EXTENSIONS = [
  '.wav', '.flac', '.aiff', '.aif', '.aifc', '.au', '.snd',
  '.mp3', '.ogg', '.oga', '.opus', '.m4a', '.mp4', '.webm', '.aac', '.wma', '.amr',
]

/** What a Whisper-compatible service accepts as uploaded, when it cannot be prepared here. */
const UPLOADABLE = ['.flac', '.m4a', '.mp3', '.mp4', '.mpeg', '.mpga', '.oga', '.ogg', '.wav', '.webm']

export function isAudio(path: string): boolean {
  return AUDIO_EXTENSIONS.includes(extname(path).toLowerCase())
}

interface Endpoint {
  url: string
  key?: string
  model: string
  label: string
}

/** The first configured speech-to-text service, in order of preference. */
export function transcriptionEndpoint(env: NodeJS.ProcessEnv = process.env): Endpoint | undefined {
  if (env.JEAN_TRANSCRIBE_URL) {
    return {
      url: env.JEAN_TRANSCRIBE_URL,
      key: env.JEAN_TRANSCRIBE_KEY,
      model: env.JEAN_TRANSCRIBE_MODEL ?? 'whisper-1',
      label: new URL(env.JEAN_TRANSCRIBE_URL).host,
    }
  }
  if (env.GROQ_API_KEY) {
    return {
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      key: env.GROQ_API_KEY,
      model: 'whisper-large-v3-turbo',
      label: 'Groq',
    }
  }
  if (env.OPENAI_API_KEY) {
    return {
      url: 'https://api.openai.com/v1/audio/transcriptions',
      key: env.OPENAI_API_KEY,
      model: 'whisper-1',
      label: 'OpenAI',
    }
  }
  return undefined
}

export const transcribeTool: Tool<{ path: string; language?: string; prompt?: string }> = {
  name: 'transcribe',
  risk: 'network',
  description: [
    'Transcribe the speech in a recording to text: WAV, FLAC, AIFF, MP3, Ogg/Opus, M4A, WebM.',
    '',
    'The audio is prepared locally (mono, 16 kHz, silence trimmed), then sent to the',
    'configured speech-to-text service. `read` on the same file shows its length and',
    'where the speech is without sending anything.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The recording, relative to the project root.' },
      language: { type: 'string', description: 'ISO-639-1 code, e.g. "en" or "fr". Optional.' },
      prompt: { type: 'string', description: 'Words to expect — names, jargon. Optional.' },
    },
    required: ['path'],
  },
  summarize: (args) => `transcribe ${args.path}`,

  async execute(args, context): Promise<ToolResult> {
    const absolute = resolveInWorkspace(args.path, context)
    const shown = displayPath(absolute, context)
    const extension = extname(absolute).toLowerCase()
    if (!isAudio(absolute)) {
      throw new ToolError(`${shown} is not a recording this reads.`, `Recordings: ${AUDIO_EXTENSIONS.join(' ')}`)
    }

    const native = await nativeReady()
    const scratch = mkdtempSync(join(tmpdir(), 'jean-transcribe-'))
    try {
      // Prepared here when it can be: smaller, and silence-only recordings
      // are caught without a request. Otherwise a format the service takes
      // goes as it is.
      let upload: { path: string; seconds?: number } | undefined
      let unprepared = ''
      if (native) {
        try {
          const probed = await native.voiceProbe(absolute)
          if (probed.speech.length === 0) {
            return { output: `${shown} has no speech in it (${(probed.durationMs / 1000).toFixed(1)}s of audio).` }
          }
          const prepared = await native.voicePrepare(absolute, join(scratch, 'prepared.wav'))
          upload = { path: prepared.output, seconds: prepared.durationMs / 1000 }
        } catch (error) {
          unprepared = error instanceof Error ? error.message : String(error)
        }
      } else {
        unprepared = 'the native bridge is not built'
      }
      if (!upload) {
        if (!UPLOADABLE.includes(extension)) {
          throw new ToolError(`${shown} could not be prepared (${unprepared}).`, 'Install ffmpeg, which decodes it, or convert it to WAV.')
        }
        upload = { path: absolute }
      }

      const endpoint = transcriptionEndpoint()
      if (!endpoint) {
        throw new ToolError(
          `${shown} is ready to transcribe, but no speech-to-text service is configured.`,
          'Set GROQ_API_KEY or OPENAI_API_KEY, or JEAN_TRANSCRIBE_URL for a Whisper-compatible server.',
        )
      }

      const prepared = upload
      const name = prepared.path === absolute ? basename(absolute) : `${basename(absolute, extension)}.wav`
      const form = new FormData()
      form.append('file', new Blob([readFileSync(prepared.path)]), name)
      form.append('model', endpoint.model)
      form.append('response_format', 'json')
      if (args.language) form.append('language', args.language)
      if (args.prompt) form.append('prompt', args.prompt)

      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: endpoint.key ? { authorization: `Bearer ${endpoint.key}` } : undefined,
        body: form,
        signal: context.signal,
      })
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 400)
        throw new ToolError(`${endpoint.label} refused the transcription (${response.status}): ${detail}`)
      }
      const body = (await response.json()) as { text?: string }
      const text = body.text?.trim() ?? ''
      return {
        output: text
          ? `${shown} (${prepared.seconds === undefined ? 'sent as recorded' : `${prepared.seconds.toFixed(1)}s of speech`}, via ${endpoint.label}):\n\n${text}`
          : `${endpoint.label} heard no words in ${shown}.`,
        display: { kind: 'transcript', path: shown, chars: text.length },
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  },
}
