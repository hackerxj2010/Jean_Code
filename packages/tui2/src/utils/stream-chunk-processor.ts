import { appendTextToAgentBlock, appendTextToRootStream } from './block-operations'

import type { StreamChunkEvent } from './sdk-event-handlers'
import type { ContentBlock } from '../types/chat'

export type ChunkDestination =
  | { type: 'root'; textType: 'text' | 'reasoning' }
  | { type: 'agent'; agentId: string; textType: 'text' | 'reasoning' }

export const destinationFromTextEvent = (
  event: { agentId?: string },
): ChunkDestination => {
  if (event.agentId) {
    return { type: 'agent', agentId: event.agentId, textType: 'text' }
  }
  return { type: 'root', textType: 'text' }
}

export const destinationFromChunkEvent = (
  event: StreamChunkEvent,
): ChunkDestination | null => {
  if (typeof event === 'string') {
    return { type: 'root', textType: 'text' }
  }

  if (event.type === 'subagent_chunk') {
    return { type: 'agent', agentId: event.agentId, textType: 'text' }
  }

  if (event.type === 'reasoning_chunk') {
    // Reasoning with no agent is the main agent's, as is any at the top level.
    if (event.ancestorRunIds.length === 0 || !event.agentId) {
      return { type: 'root', textType: 'reasoning' }
    }
    return { type: 'agent', agentId: event.agentId, textType: 'reasoning' }
  }

  return null
}

export const processTextChunk = (
  blocks: ContentBlock[],
  destination: ChunkDestination,
  text: string,
): ContentBlock[] => {
  if (!text) {
    return blocks
  }

  if (destination.type === 'agent') {
    return appendTextToAgentBlock(blocks, destination.agentId, text, destination.textType)
  }

  return appendTextToRootStream(blocks, {
    type: destination.textType,
    text,
  })
}
