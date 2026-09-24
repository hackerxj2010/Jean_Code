import { MEMORY_KINDS, recallForPrompt, retain, type MemoryBackend } from '@jean/memory'
import type { Tool } from '@jean/tools'

/**
 * Memory tools (architecture §10.1).
 *
 * `retain` and `recall` are exposed to the agent so it can carry facts across
 * sessions deliberately, rather than relying on whatever happens to survive
 * compaction.
 *
 * The prompt guidance here is doing real work: an agent that stores everything
 * produces a memory store that is worse than none, because recall then returns
 * noise. The bar is "expensive to rediscover", not "true".
 */

export function createMemoryTools(backend: MemoryBackend, project: string, sessionId: string): Tool[] {
  const retainTool: Tool<{ kind: string; text: string; global?: boolean }> = {
    name: 'retain',
    risk: 'write',
    description: [
      'Store something worth remembering in later sessions.',
      '',
      'Store a fact when it was expensive to work out and will still be true next week:',
      'a convention this project follows, a constraint the user stated, a non-obvious',
      'reason something is built the way it is, a correction the user made.',
      '',
      'Do not store: anything the code or git history already says, anything specific to',
      'the task at hand, or a summary of what you just did. A memory store full of those',
      'makes recall useless.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: MEMORY_KINDS,
          description:
            'preference (how the user likes to work), feedback (a correction they gave), project (a durable fact about this codebase), pattern (something learned from solving a hard problem), reference (a pointer to a resource).',
        },
        text: {
          type: 'string',
          description:
            'The fact, stated so it makes sense with no other context. Include why it matters.',
        },
        global: {
          type: 'boolean',
          description: 'True if this applies everywhere, not just this project. Default false.',
        },
      },
      required: ['kind', 'text'],
    },
    summarize: (args) => `remember: ${args.text.slice(0, 70)}`,

    async execute(args) {
      const text = args.text.trim()
      if (text.length < 10) {
        return { output: 'That is too short to be useful later. Write a complete sentence.', isError: true }
      }
      const memory = retain(backend, args.kind as never, text, {
        project: args.global ? undefined : project,
        source: sessionId,
      })
      return {
        output: `Stored as memory #${memory.id} (${memory.kind}${args.global ? ', global' : ''}).`,
        display: { kind: 'memory-retain', memory },
      }
    },
  }

  const recallTool: Tool<{ query: string; limit?: number }> = {
    name: 'recall',
    risk: 'read',
    description: [
      'Search memories from earlier sessions.',
      '',
      'Relevant memories are already in your system prompt. Use this when you need',
      'something more specific — whether a particular decision was made before, or what',
      'the user said about a topic that has just come up.',
      '',
      'Memories reflect what was true when they were written. Verify anything that names',
      'a file, a function, or a command before acting on it.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        limit: { type: 'integer', description: 'Maximum results. Default 8.' },
      },
      required: ['query'],
    },
    summarize: (args) => `recall "${args.query.slice(0, 60)}"`,

    async execute(args) {
      const found = recallForPrompt(backend, args.query, project, Math.min(args.limit ?? 8, 25))
      if (found.length === 0) {
        return { output: `Nothing stored about "${args.query}".` }
      }
      const rendered = found
        .map((m) => {
          const age = Math.round((Date.now() - m.updatedAt) / 86_400_000)
          const when = age === 0 ? 'today' : age === 1 ? 'yesterday' : `${age} days ago`
          return `#${m.id} [${m.kind}, ${when}] ${m.text}`
        })
        .join('\n')
      return {
        output: `${found.length} memor${found.length === 1 ? 'y' : 'ies'}:\n${rendered}`,
        display: { kind: 'memory-recall', memories: found },
      }
    },
  }

  const forgetTool: Tool<{ id: number }> = {
    name: 'forget',
    risk: 'write',
    description:
      'Delete a memory by id. Use this when a stored fact turns out to be wrong or has stopped being true — a stale memory is worse than a missing one.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'The memory id, as shown by `recall`.' } },
      required: ['id'],
    },
    summarize: (args) => `forget memory #${args.id}`,

    async execute(args) {
      const existing = backend.get(args.id)
      if (!existing) return { output: `No memory #${args.id}.`, isError: true }
      backend.forget(args.id)
      return { output: `Deleted memory #${args.id}: ${existing.text.slice(0, 100)}` }
    },
  }

  return [retainTool, recallTool, forgetTool]
}
