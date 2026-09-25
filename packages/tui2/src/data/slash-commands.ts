import { getModeSettings } from '../utils/agent-selection'
import { AGENT_MODES } from '../utils/constants'

import type { SkillsMap } from '@codebuff/common/types/skill'

export interface SlashCommand {
  id: string
  label: string
  description: string
  aliases?: string[]
  /**
   * If true, this command can be invoked without a leading slash when the
   * input matches the command id exactly (no arguments).
   */
  implicitCommand?: boolean
  /**
   * If set, selecting this command inserts this text into the input field
   * instead of executing a command. Useful for agent shortcuts.
   */
  insertText?: string
}

const MODE_COMMANDS: SlashCommand[] = AGENT_MODES.map((mode) => ({
  id: `mode:${mode.toLowerCase()}`,
  label: `mode:${mode.toLowerCase()}`,
  description: getModeSettings(mode).description,
  aliases: [`model:${mode.toLowerCase()}`],
}))

/** Every command the registry handles, as the `/` menu lists them. */
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'help',
    label: 'help',
    description: 'Display keyboard shortcuts and tips',
    aliases: ['h', '?'],
    implicitCommand: true,
  },
  {
    id: 'connect',
    label: 'connect',
    description: 'Connect a provider: OpenCode Zen, Anthropic, OpenAI, Google, and 200+ more',
    aliases: ['providers'],
  },
  {
    id: 'models',
    label: 'models',
    description: 'Pick a model: favorites, recent, every connected provider — or /models provider:model',
    aliases: ['model', 'switch-model', 'use-model'],
  },
  {
    id: 'init',
    label: 'init',
    description: 'Create JEAN.md, the notes the agent reads every session',
    implicitCommand: true,
  },
  {
    id: 'interview',
    label: 'interview',
    description: 'The agent asks questions to turn a request into a spec',
  },
  {
    id: 'plan',
    label: 'plan',
    description: 'Plan an implementation without changing code',
  },
  {
    id: 'review',
    label: 'review',
    description: 'Review changes: the diff, its problems, a second opinion',
  },
  {
    id: 'new',
    label: 'new',
    description: 'Clear the conversation history and start a new chat',
    aliases: ['n', 'clear', 'c', 'reset'],
    implicitCommand: true,
  },
  {
    id: 'history',
    label: 'history',
    description: 'Browse and resume past conversations',
    aliases: ['chats', 'sessions', 'resume', 'continue'],
  },
  {
    id: 'bash',
    label: 'bash',
    description: 'Enter bash mode ("!" at beginning enters bash mode)',
    aliases: ['!'],
  },
  {
    id: 'image',
    label: 'image',
    description: 'Attach an image file (or Ctrl+V to paste from clipboard)',
    aliases: ['img', 'attach'],
  },
  ...MODE_COMMANDS,
  {
    id: 'theme',
    label: 'theme',
    description: 'Pick a theme: dark, light, dark-blue, dark-red, monokai',
  },
  {
    id: 'theme:toggle',
    label: 'theme:toggle',
    description: 'Toggle between light and dark mode',
  },
  // Jean's session verbs (handled in commands/jean.ts).
  { id: 'goal', label: 'goal', description: 'Keep working until a command passes, e.g. /goal npm test' },
  { id: 'rewind', label: 'rewind', description: 'Undo the last turn: restore files, forget the exchange' },
  { id: 'undo', label: 'undo', description: 'Same as /rewind 1' },
  { id: 'redo', label: 'redo', description: 'Take back the last /undo: files and conversation' },
  { id: 'compact', label: 'compact', description: 'Summarize the conversation so far and continue', aliases: ['summarize'] },
  { id: 'export', label: 'export', description: 'Save this session as Markdown and JSON — /export sanitize to share it' },
  { id: 'stats', label: 'stats', description: "This session's tokens and cost", aliases: ['cost', 'usage'] },
  { id: 'effort', label: 'effort', description: 'Reasoning effort: cycle, or /effort fast|normal|high|xhigh', aliases: ['variant'] },
  { id: 'arena', label: 'arena', description: 'Run several attempts in parallel and keep the best' },
  { id: 'hooks', label: 'hooks', description: 'Show active hooks and permission rules' },
  { id: 'mcp', label: 'mcp', description: 'Show connected MCP servers' },
  { id: 'lsp', label: 'lsp', description: 'Language servers: running, available, and what each has been saying' },
  { id: 'debug', label: 'debug', description: 'Debug sessions and the adapters available' },
  { id: 'agents', label: 'agents', description: 'List the sub-agents the agent can spawn' },
  { id: 'commands', label: 'commands', description: 'List custom commands (.jean/commands, .claude/commands)' },
  { id: 'trust', label: 'trust', description: 'Trust this project: enable its hooks and MCP servers' },
  {
    id: 'exit',
    label: 'exit',
    description: 'Quit',
    aliases: ['quit', 'q'],
    implicitCommand: true,
  },
]

export const SLASHLESS_COMMAND_IDS = new Set(
  SLASH_COMMANDS.filter((cmd) => cmd.implicitCommand).map((cmd) =>
    cmd.id.toLowerCase(),
  ),
)

/** Maximum description length for skill commands in the slash menu */
const SKILL_MENU_DESCRIPTION_MAX_LENGTH = 50

function truncateDescription(description: string): string {
  if (description.length <= SKILL_MENU_DESCRIPTION_MAX_LENGTH) {
    return description
  }
  return description.slice(0, SKILL_MENU_DESCRIPTION_MAX_LENGTH - 1) + '…'
}

/**
 * Returns SLASH_COMMANDS merged with skill commands.
 * Skills become slash commands that users can invoke directly.
 */
export function getSlashCommandsWithSkills(skills: SkillsMap): SlashCommand[] {
  const skillCommands: SlashCommand[] = Object.values(skills).map((skill) => ({
    id: `skill:${skill.name}`,
    label: `skill:${skill.name}`,
    description: truncateDescription(skill.description),
  }))

  return [...SLASH_COMMANDS, ...skillCommands]
}
