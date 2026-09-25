import { mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { JeanConfig } from '@jean/config'
import { nativeReady } from '@jean/native'
import { createSessionState, transcribeTool, transcriptionEndpoint } from '@jean/tools'
import { color, errorLine, line, symbols } from '../ui.ts'

/**
 * `jean voice` — the microphone, from the command line.
 *
 *   jean voice devices          which recorders this machine has
 *   jean voice record [secs]    record until you stop talking (or secs), then
 *                               transcribe it when a speech service is set
 *
 * Recordings are kept in `.jean/recordings/`, so one can be read, sent to
 * `transcribe`, or attached to a prompt afterwards.
 */
export async function runVoiceCommand(positional: string[], config: JeanConfig, cwd: string): Promise<number> {
  const action = positional[0] ?? 'devices'
  const native = await nativeReady()
  if (!native) {
    errorLine(`${symbols.cross} Voice needs the Rust core. Run \`jean native build\`.`)
    return 1
  }

  if (action === 'devices') {
    const recorders = await native.voiceRecorders()
    line()
    if (recorders.length === 0) {
      line(color.yellow(`  ${symbols.warn} No recorder found. Install ffmpeg or sox (on Linux, arecord or parecord also work).`))
    } else {
      for (const [index, recorder] of recorders.entries()) {
        line(`  ${index === 0 ? color.green('●') : color.dim('○')} ${recorder.name.padEnd(10)} ${color.dim(recorder.program)}`)
      }
      line()
      line(color.dim('  The first one records; set JEAN_RECORDER to a command writing 16 kHz mono s16le PCM to use another.'))
    }
    const endpoint = transcriptionEndpoint()
    line(color.dim(`  Transcription: ${endpoint ? endpoint.label : 'not configured (GROQ_API_KEY, OPENAI_API_KEY, or JEAN_TRANSCRIBE_URL)'}`))
    line()
    return 0
  }

  if (action !== 'record') {
    errorLine(`Unknown action "${action}". Use devices or record [seconds].`)
    return 2
  }

  const seconds = Number(positional[1])
  const timed = Number.isFinite(seconds) && seconds > 0
  const directory = join(cwd, '.jean', 'recordings')
  mkdirSync(directory, { recursive: true })
  const output = join(directory, `recording-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`)

  line(color.dim(timed ? `  Recording for ${seconds}s.` : '  Listening — speak, then pause to finish.'))
  let recording: Awaited<ReturnType<typeof native.voiceRecord>>
  try {
    recording = await native.voiceRecord(output, { maxMs: timed ? seconds * 1000 : 60_000, untilSilence: !timed })
  } catch (error) {
    errorLine(color.red(`${symbols.cross} ${error instanceof Error ? error.message : String(error)}`))
    return 1
  }
  const shown = relative(cwd, recording.output)
  line(`${color.green(symbols.check)} ${shown} ${color.dim(`(${(recording.durationMs / 1000).toFixed(1)}s, via ${recording.recorder})`)}`)
  if (!recording.heardSpeech) {
    line(color.yellow(`  ${symbols.warn} No speech was heard.`))
    return 0
  }
  if (!transcriptionEndpoint()) {
    line(color.dim('  Set GROQ_API_KEY or OPENAI_API_KEY to have it transcribed.'))
    return 0
  }
  try {
    const result = await transcribeTool.execute({ path: shown }, { cwd, config, session: createSessionState(cwd) })
    line()
    line(result.output)
    line()
    return 0
  } catch (error) {
    errorLine(color.red(`${symbols.cross} ${error instanceof Error ? error.message : String(error)}`))
    return 1
  }
}
