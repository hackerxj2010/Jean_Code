import type { Tool, ToolResult } from './types.ts'
import { ToolError } from './types.ts'

/**
 * The task list.
 *
 * A shared, visible plan is the cheapest way to stop a long task from drifting:
 * the agent commits to steps before doing them, and both the user and the
 * agent's own next turn can see what is left. In swarm mode the same list
 * backs `@jean/teams`, where teammates claim items from it.
 */

export const todoTool: Tool<{
  action: 'set' | 'complete' | 'start' | 'list'
  items?: string[]
  id?: string
}> = {
  name: 'todo',
  risk: 'read',
  // Each call rewrites the shared list; two in one batch must land in order.
  concurrency: 'serial',
  description: [
    'Track a multi-step task.',
    '',
    '`set` replaces the list with new items, `start` marks one in progress,',
    '`complete` marks one done, `list` shows the current state.',
    '',
    'Use this for work with three or more distinct steps. Mark exactly one item',
    'in progress at a time, and complete it before starting the next.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['set', 'complete', 'start', 'list'] },
      items: {
        type: 'array',
        // Spelling out the element type matters: without it models default to
        // the object-shaped todo lists other agents use, and every step
        // stringifies to "[object Object]".
        items: { type: 'string' },
        description: 'For `set`: the full list of steps, as plain strings.',
      },
      id: { type: 'string', description: 'For `start`/`complete`: the item id.' },
    },
    required: ['action'],
  },
  summarize: (args) =>
    args.action === 'set' ? `plan ${args.items?.length ?? 0} steps` : `todo ${args.action}`,

  async execute(args, context): Promise<ToolResult> {
    const todos = context.session.todos

    switch (args.action) {
      case 'set': {
        if (!args.items?.length) throw new ToolError('`set` needs a non-empty `items` array.')
        todos.length = 0
        for (const [i, item] of args.items.entries()) {
          const text = itemText(item)
          if (text) todos.push({ id: String(i + 1), text, status: 'pending' })
        }
        if (todos.length === 0) {
          throw new ToolError(
            '`items` contained no readable step text.',
            'Pass plain strings: ["read the config", "add the flag", "run the tests"].',
          )
        }
        break
      }
      case 'start':
      case 'complete': {
        if (!args.id) throw new ToolError(`\`${args.action}\` needs an \`id\`.`)
        const item = todos.find((t) => t.id === args.id)
        if (!item) {
          throw new ToolError(
            `No task with id "${args.id}".`,
            todos.length > 0
              ? `Current ids: ${todos.map((t) => t.id).join(', ')}.`
              : 'The list is empty — call `set` first.',
          )
        }
        item.status = args.action === 'start' ? 'in_progress' : 'completed'
        break
      }
      case 'list':
        break
    }

    if (todos.length === 0) return { output: 'The task list is empty.' }

    const rendered = todos
      .map((t) => `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]'} ${t.id}. ${t.text}`)
      .join('\n')
    const remaining = todos.filter((t) => t.status !== 'completed').length

    return {
      output: `${rendered}\n\n${remaining} of ${todos.length} remaining.`,
      display: { kind: 'todo', items: [...todos] },
    }
  },
}

/**
 * Extracts step text from whatever shape the model sent.
 *
 * The schema asks for plain strings, but models trained on other agents'
 * task-list tools reach for the object form (`{content, status}`,
 * `{task, done}`, `{title}`) often enough that rejecting it outright would
 * cost a wasted turn for no benefit. Reading the obvious text field is
 * strictly better than storing "[object Object]".
 */
function itemText(item: unknown, depth = 0): string | undefined {
  if (typeof item === 'string') return item.trim() || undefined
  if (item === null || typeof item !== 'object') return undefined
  // Guards against a self-referential structure; two levels covers every shape
  // observed in practice.
  if (depth > 2) return undefined

  // An item wrapped in an array — models do this when they nest a malformed
  // call inside the field that should hold the text.
  if (Array.isArray(item)) {
    for (const element of item) {
      const found = itemText(element, depth + 1)
      if (found) return found
    }
    return undefined
  }

  const record = item as Record<string, unknown>
  for (const key of TEXT_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    // `{item: ["the actual text", ...]}` shows up in the wild too.
    if (Array.isArray(value)) {
      const found = itemText(value, depth + 1)
      if (found) return found
    }
  }
  return undefined
}

/**
 * Field names models use for a step's text, in priority order.
 *
 * Gathered from what models actually send, not from a spec: `item` in
 * particular is what MiniMax reaches for, and omitting it costs a wasted turn
 * every time a plan is made.
 */
const TEXT_KEYS = [
  'text',
  'content',
  'item',
  'task',
  'title',
  'description',
  'step',
  'label',
  'name',
]
