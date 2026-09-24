import { join } from 'node:path'
import { jeanHome } from '@jean/config'
import type { Message, ModelClient } from '@jean/model'
import { collect, estimateTokens } from '@jean/model'
import { nativeReady } from '@jean/native'
import { ToolError, type Tool, type ToolResult } from '@jean/tools'
import { renderTranscript, splitForCompaction } from './context.ts'
import type { EventStore } from './eventstore.ts'

/**
 * Compaction (architecture §9.4, §6.2).
 *
 * Two strategies, both landing as a `compaction` event so the full history
 * stays on disk while the model sees a summary:
 *
 * * **Auto-compact** fires at the context threshold. It has to work, so it is
 *   summarize-and-continue with a deterministic fallback if the model call
 *   fails — running out of context must never end a session.
 * * **Smart compaction** fires after an idle gap, when the provider's prompt
 *   cache has expired and the next turn would be re-billed at full price
 *   anyway. Since nothing is lost by rewriting the transcript at that moment,
 *   it is the cheapest possible time to do it.
 */

/** Prompt-cache lifetime across providers, near enough. */
export const IDLE_COMPACTION_MS = 5 * 60 * 1000

export interface CompactionResult {
  summary: string
  tokensBefore: number
  tokensAfter: number
  /** True when the model summarized; false when the deterministic path ran. */
  modelGenerated: boolean
}

const SUMMARY_PROMPT = `You are compacting a coding session's transcript so work can continue in a fresh context.

Write a summary that lets someone resume the work with no other information. Include:

1. What the user asked for, in their own terms, including any constraints they stated.
2. What has been done so far — files created or modified, with paths.
3. What was learned about the codebase that would be expensive to rediscover: where things live, how they fit together, conventions in use.
4. Decisions taken and the reasoning behind them.
5. What is still outstanding, and what the immediate next step is.
6. Anything that failed, and why, so it is not retried blindly.

Be specific. Names, paths, and signatures are worth more than prose. Do not editorialize about progress. Do not invent anything that is not in the transcript.`

/**
 * Compacts the session, appending a `compaction` event.
 *
 * Returns `undefined` when there is not enough history to be worth compacting.
 */
export async function compact(
  store: EventStore,
  client: ModelClient,
  options: {
    reason: 'threshold' | 'idle' | 'manual'
    signal?: AbortSignal
    /**
     * Live state appended to the summary verbatim — the task list, above all.
     * A summarizer paraphrases; the list of what is done and what is not has
     * to survive exactly, or the agent redoes finished work.
     */
    appendix?: string
  } = {
    reason: 'manual',
  },
): Promise<CompactionResult | undefined> {
  const messages = store.transcript()
  const { older, recent } = splitForCompaction(messages)
  if (older.length === 0) return undefined

  const tokensBefore = estimateTokens(renderTranscript(messages))
  const rendered = renderTranscript(older)

  let summary: string
  let modelGenerated = true

  try {
    const response = await collect(
      client.stream(
        {
          system: SUMMARY_PROMPT,
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: `Transcript to summarize:\n\n${rendered}` }],
            },
          ],
          // Long sessions carry a lot worth keeping; a summary cut off at 2K
          // tokens drops exactly the late details the next turn needs.
          maxTokens: 6144,
          temperature: 0,
          signal: options.signal,
        },
        // The cheap role: this is summarization, not reasoning, and it must
        // stay affordable enough to run on every long session.
        'smol',
      ),
    )
    summary = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!summary) throw new Error('summary was empty')
  } catch {
    // The deterministic path. Worse than a model summary, but compaction is
    // load-bearing: if it can fail, a long session can hit a wall it cannot
    // recover from.
    summary = deterministicSummary(store, older)
    modelGenerated = false
  }
  if (options.appendix?.trim()) summary = `${summary}\n\n${options.appendix.trim()}`

  const archived = await archiveTurns(older)
  if (archived) summary = `${summary}\n\n${archived}`

  const tokensAfter = estimateTokens(summary) + estimateTokens(renderTranscript(recent))

  store.append({
    type: 'compaction',
    at: Date.now(),
    throughIndex: store.length,
    summary,
    tokensBefore,
    tokensAfter,
  })

  return { summary, tokensBefore, tokensAfter, modelGenerated }
}

/**
 * A summary built from events alone, with no model call.
 *
 * Structural facts survive: what was asked, which files were touched, which
 * commands ran, what errored. Reasoning does not — which is exactly why this is
 * the fallback and not the default.
 */
export function deterministicSummary(
  store: EventStore,
  older: import('@jean/model').Message[],
): string {
  const requests = store
    .ofType('user_message')
    .map((e) => e.text)
    .slice(0, 5)

  const touched = store.touchedFiles()
  const commands: string[] = []
  const errors: string[] = []

  for (const event of store.all()) {
    if (event.type === 'tool_call' && event.name === 'bash') {
      const command = (event.input as { command?: string })?.command
      if (command) commands.push(command.split('\n')[0]!.slice(0, 120))
    }
    if (event.type === 'tool_result' && event.isError) {
      errors.push(`${event.name}: ${event.output.split('\n')[0]!.slice(0, 160)}`)
    }
  }

  const sections: string[] = ['[Summary generated without a model call.]', '']

  if (requests.length > 0) {
    sections.push('## What was asked', ...requests.map((r) => `- ${clamp(r, 400)}`), '')
  }
  if (touched.length > 0) {
    sections.push('## Files changed', ...touched.slice(0, 40).map((f) => `- ${f}`), '')
  }
  if (commands.length > 0) {
    sections.push(
      '## Commands run',
      ...dedupe(commands).slice(-15).map((c) => `- \`${c}\``),
      '',
    )
  }
  if (errors.length > 0) {
    sections.push('## Errors seen', ...dedupe(errors).slice(-10).map((e) => `- ${e}`), '')
  }

  // The last assistant text is usually the most recent statement of intent.
  const lastText = [...older]
    .reverse()
    .flatMap((m) => (m.role === 'assistant' ? m.content : []))
    .find((b): b is { type: 'text'; text: string } => b.type === 'text')
  if (lastText) {
    sections.push('## Last assistant message', clamp(lastText.text, 1200))
  }

  return sections.join('\n')
}

/**
 * Where compacted turns are archived. Content-addressed, so the same turns
 * land on the same hash from any session, and nothing is stored twice.
 */
export function archiveRoot(): string {
  return join(jeanHome(), 'archive')
}

/**
 * Archives the turns a summary replaces, through `snapcompact`, and returns
 * the section the summary carries about them.
 *
 * A summary paraphrases. This keeps the original text on disk under a hash,
 * so a detail the summary dropped — the exact error, the exact path — is one
 * `recall_archive` call away instead of gone. The frame also lists the
 * entities the turns mention, which is often all the next turn needs.
 */
async function archiveTurns(older: Message[]): Promise<string | undefined> {
  const native = await nativeReady()
  if (!native) return undefined

  const turns = older
    .map((message) => ({
      role: message.content.some((block) => block.type === 'tool_result') ? 'tool' : message.role,
      text: renderTranscript([message], Number.MAX_SAFE_INTEGER),
    }))
    .filter((turn) => turn.text.trim() !== '')
  if (turns.length === 0) return undefined

  try {
    const frame = await native.snapFrame(archiveRoot(), turns)
    const entities = frame.entities.slice(0, 24).map((entity) => entity.text)
    return [
      '## Archived transcript',
      `The ${turns.length} compacted turns are archived verbatim as frame \`${frame.hash.slice(0, 12)}\` (${frame.tokensBefore} tokens). Call \`recall_archive\` with that frame — and a \`query\` to narrow it — to read any of it again.`,
      ...(entities.length > 0 ? [`Mentioned: ${entities.join(', ')}.`] : []),
    ].join('\n')
  } catch {
    return undefined
  }
}

/**
 * `recall_archive`: reads back turns that compaction replaced with a summary.
 *
 * With a `query`, only the lines that mention it, with a little context — the
 * usual need is one error message or one path, not the whole frame.
 */
export function createArchiveTool(): Tool<{ frame: string; query?: string; context?: number }> {
  return {
    name: 'recall_archive',
    risk: 'read',
    description: [
      'Read back the exact text of turns that were compacted into a summary.',
      '',
      'The summary names the frame (`Archived transcript` → frame `abc123...`). Pass a',
      '`query` to get only the lines that mention it; without one, the whole frame.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        frame: { type: 'string', description: 'The frame id from the summary (a prefix is enough).' },
        query: { type: 'string', description: 'Only lines containing this text (case-insensitive).' },
        context: { type: 'integer', description: 'Lines of context around each hit. Default 2.' },
      },
      required: ['frame'],
    },
    summarize: (args) => `recall archive ${args.frame.slice(0, 12)}${args.query ? ` for ${args.query}` : ''}`,

    async execute(args): Promise<ToolResult> {
      const native = await nativeReady()
      if (!native) {
        throw new ToolError('The archive is read by the native bridge, which is not built.', 'Run `jean native build`.')
      }
      let text: string
      try {
        text = await native.snapGet(archiveRoot(), args.frame.trim())
      } catch (error) {
        throw new ToolError(
          error instanceof Error ? error.message : String(error),
          'Use the frame id exactly as the compaction summary gives it.',
        )
      }

      if (!args.query) {
        return { output: text.length > 30_000 ? `${text.slice(0, 30_000)}\n[truncated — pass a query]` : text }
      }

      const lines = text.split('\n')
      const wanted = args.query.toLowerCase()
      const around = Math.min(Math.max(args.context ?? 2, 0), 10)
      const keep = new Set<number>()
      lines.forEach((line, index) => {
        if (!line.toLowerCase().includes(wanted)) return
        for (let k = Math.max(0, index - around); k <= Math.min(lines.length - 1, index + around); k++) keep.add(k)
      })
      if (keep.size === 0) return { output: `Nothing in frame ${args.frame.slice(0, 12)} mentions \`${args.query}\`.` }
      const shown = [...keep].sort((a, b) => a - b).map((index) => lines[index]!)
      return { output: shown.join('\n').slice(0, 30_000) }
    },
  }
}

/** True when enough idle time has passed that the prompt cache has expired. */
export function shouldCompactOnIdle(lastActivityMs: number, now = Date.now()): boolean {
  return now - lastActivityMs >= IDLE_COMPACTION_MS
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)]
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
