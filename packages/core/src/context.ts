import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { jeanHome, splitModelRef } from '@jean/config'
import { contextWindow, estimateTokens } from '@jean/model'
import type { Message } from '@jean/model'
import { nativeReady } from '@jean/native'

/**
 * Context window management (architecture §6.2, §9.4).
 *
 * Two jobs: measure how full the window is, and decide what to do when it fills
 * up. The measurement is an estimate by design — see `estimateTokens` — because
 * every decision made from it has a wide tolerance.
 */

export interface ContextStatus {
  /** Estimated tokens in the transcript plus the system prompt. */
  used: number
  /** The model's context window. */
  limit: number
  /** `used / limit`, 0 to 1+. */
  ratio: number
  /** Tokens left before the window is full. */
  remaining: number
  /** True once `ratio` crosses the configured compaction threshold. */
  shouldCompact: boolean
}

/** The window of `model` or `provider:model` — the provider picks the right catalog entry. */
function windowOf(ref: string): number {
  const { provider, modelId } = splitModelRef(ref)
  return contextWindow(modelId, provider)
}

export function measureContext(
  messages: Message[],
  systemPrompt: string,
  modelId: string,
  threshold: number,
  /** Reserved headroom for the next response. */
  maxOutputTokens = 8192,
): ContextStatus {
  const limit = windowOf(modelId)
  const used = estimateTokens(systemPrompt) + messages.reduce((sum, m) => sum + messageTokens(m), 0)
  // The output has to fit too, so the usable window is smaller than the raw one.
  const usable = Math.max(limit - maxOutputTokens, Math.floor(limit * 0.5))
  const ratio = used / usable

  return {
    used,
    limit,
    ratio,
    remaining: Math.max(usable - used, 0),
    shouldCompact: ratio >= threshold,
  }
}

/**
 * {@link measureContext}, counted by the `pi-tokens` crate.
 *
 * `length / 3.6` is fine for English and wrong for code, where every bracket
 * and operator is its own token — it under-counts exactly the transcripts an
 * agent produces, and under-counting is the dangerous direction: it compacts
 * too late and overflows the window. The crate's estimate is calibrated on
 * code and biased to over-count; with `~/.jean/tokenizer.tiktoken` present it
 * is an exact BPE count instead. All blocks go in one call.
 */
export async function measureContextExact(
  messages: Message[],
  systemPrompt: string,
  modelId: string,
  threshold: number,
  maxOutputTokens = 8192,
): Promise<ContextStatus> {
  const native = await nativeReady()
  if (!native) return measureContext(messages, systemPrompt, modelId, threshold, maxOutputTokens)

  const texts: string[] = [systemPrompt]
  let fixed = 0
  for (const message of messages) {
    fixed += 4
    for (const block of message.content) {
      if (block.type === 'text' || block.type === 'thinking') texts.push(block.text)
      else if (block.type === 'tool_call') texts.push(block.name, JSON.stringify(block.input ?? {}))
      else if (block.type === 'tool_result') texts.push(block.output)
      else if (block.type === 'image') fixed += 1_500
    }
  }

  let counts: number[]
  try {
    const vocabulary = join(jeanHome(), 'tokenizer.tiktoken')
    counts = await native.countTokensMany(texts, existsSync(vocabulary) ? vocabulary : undefined)
  } catch {
    return measureContext(messages, systemPrompt, modelId, threshold, maxOutputTokens)
  }

  const limit = windowOf(modelId)
  const used = fixed + counts.reduce((sum, n) => sum + n, 0)
  const usable = Math.max(limit - maxOutputTokens, Math.floor(limit * 0.5))
  const ratio = used / usable
  return { used, limit, ratio, remaining: Math.max(usable - used, 0), shouldCompact: ratio >= threshold }
}

/** Estimated tokens for one message, including tool traffic. */
export function messageTokens(message: Message): number {
  let total = 4 // per-message envelope overhead
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
      case 'thinking':
        total += estimateTokens(block.text)
        break
      case 'tool_call':
        total += estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input ?? {}))
        break
      case 'tool_result':
        total += estimateTokens(block.output)
        break
      case 'image':
        // A rough constant: image token cost varies by provider and resolution,
        // and being precise here would not change any decision.
        total += 1_500
        break
    }
  }
  return total
}

/**
 * Trims oversized tool results in place-safe fashion, returning a new array.
 *
 * This is the cheap intervention that runs before real compaction: a single
 * 200 KB test log can dominate a window, and the agent almost never needs its
 * middle. Keeping the head and tail preserves the command, the first errors,
 * and the summary line, which is what actually gets read.
 */
export function trimToolResults(messages: Message[], maxCharsPerResult = 8000): Message[] {
  return messages.map((message) => {
    if (message.role !== 'tool') return message
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type !== 'tool_result' || block.output.length <= maxCharsPerResult) return block
        const head = Math.floor(maxCharsPerResult * 0.6)
        const tail = maxCharsPerResult - head
        const omitted = block.output.length - maxCharsPerResult
        return {
          ...block,
          output: `${block.output.slice(0, head)}\n\n[... ${omitted} characters omitted ...]\n\n${block.output.slice(-tail)}`,
        }
      }),
    }
  })
}

/**
 * Splits a transcript at the point where the older half can be summarized.
 *
 * Keeps the most recent `keepRatio` of estimated tokens intact — recent turns
 * carry the working state — and hands the rest to the summarizer. The split
 * never lands between an assistant tool call and its results, which would
 * produce a transcript providers reject.
 */
export function splitForCompaction(
  messages: Message[],
  keepRatio = 0.3,
): { older: Message[]; recent: Message[] } {
  if (messages.length <= 4) return { older: [], recent: messages }

  const total = messages.reduce((sum, m) => sum + messageTokens(m), 0)
  const keepTarget = total * keepRatio

  let kept = 0
  let splitAt = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    kept += messageTokens(messages[i]!)
    if (kept >= keepTarget) {
      splitAt = i
      break
    }
  }

  // Do not orphan tool results from the assistant turn that requested them.
  while (splitAt < messages.length && messages[splitAt]!.role === 'tool') splitAt++
  // Always leave at least one exchange intact.
  splitAt = Math.min(splitAt, messages.length - 2)
  splitAt = Math.max(splitAt, 0)

  return { older: messages.slice(0, splitAt), recent: messages.slice(splitAt) }
}

/** Renders messages as plain text, for summarization prompts and logs. */
export function renderTranscript(messages: Message[], maxCharsPerBlock = 2000): string {
  const parts: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          parts.push(`${message.role.toUpperCase()}: ${clamp(block.text, maxCharsPerBlock)}`)
          break
        case 'tool_call':
          parts.push(
            `TOOL CALL ${block.name}(${clamp(JSON.stringify(block.input ?? {}), 400)})`,
          )
          break
        case 'tool_result':
          parts.push(
            `TOOL RESULT ${block.name}${block.isError ? ' [error]' : ''}: ${clamp(block.output, maxCharsPerBlock)}`,
          )
          break
        case 'thinking':
        case 'image':
          break
      }
    }
  }
  return parts.join('\n\n')
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`
}
