import type { Tool, ToolResult } from './types.ts'
import { ToolError } from './types.ts'

/**
 * Asking the user a question.
 *
 * The narrow but important case: a decision the agent cannot make from the
 * repository, where guessing wrong means doing substantial work in the wrong
 * direction. "Which database?" before scaffolding twenty files is worth one
 * question; "shall I proceed?" before every edit is not, and an agent that asks
 * constantly is worse than one that decides.
 *
 * The tool description carries that judgment, because the model is the one
 * deciding when to call it.
 */

export interface AskRequest {
  question: string
  options?: { label: string; description?: string }[]
  /** True when several options may be chosen. */
  multiple?: boolean
}

export type AskHandler = (request: AskRequest) => Promise<string | undefined>

/**
 * Builds the ask tool.
 *
 * Without a handler the tool refuses rather than blocking: a non-interactive
 * run has nobody to answer, and waiting forever is the worst outcome.
 */
export function createAskTool(handler?: AskHandler): Tool<{
  question: string
  options?: string[]
  multiple?: boolean
}> {
  return {
    name: 'ask',
    risk: 'read',
    // Two questions at once would put two prompts in front of the user.
    concurrency: 'serial',
    description: [
      'Ask the user a question when you genuinely cannot proceed without their answer.',
      '',
      'Use this only when different answers lead to materially different work —',
      'which framework to scaffold with, which of two incompatible interpretations',
      'of an ambiguous request is meant. Offer concrete options when you can.',
      '',
      'Do not use it to confirm work you were already asked to do, to check in on',
      'progress, or to ask permission for something the permission system already',
      'gates. An agent that asks constantly is more work to use than one that',
      'makes the reasonable call and says what it assumed.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, in full.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Concrete choices, when the answer is one of a known set.',
        },
        multiple: { type: 'boolean', description: 'Several options may be selected.' },
      },
      required: ['question'],
    },
    summarize: (args) => `ask: ${args.question.slice(0, 60)}`,

    async execute(args): Promise<ToolResult> {
      if (!handler) {
        throw new ToolError(
          'There is nobody to answer: this session is non-interactive.',
          'Decide the question yourself, state the assumption you made, and continue.',
        )
      }

      const answer = await handler({
        question: args.question,
        options: args.options?.map((label) => ({ label })),
        multiple: args.multiple,
      })

      if (answer === undefined) {
        return {
          output: 'The user did not answer. Make the reasonable choice, say what you assumed, and continue.',
        }
      }

      return { output: `The user answered: ${answer}`, display: { kind: 'ask', answer } }
    },
  }
}
