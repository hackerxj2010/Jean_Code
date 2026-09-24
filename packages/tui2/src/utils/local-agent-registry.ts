import { existsSync } from 'fs'
import path from 'path'

import { discoverAgents } from '@jean/agent'

import { getProjectRoot } from '../project-files'
import { logger } from './logger'
import * as bundledAgentsModule from '../agents/bundled-agents.generated'

import type { AgentMode } from './constants'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

/**
 * The agents the `@` menu offers and the agent can spawn: the ones that ship
 * with Jean (`@jean/agent`), plus the user's and the project's own, from
 * `.jean/agents/*.md` and `.claude/agents/*.md` — the same set the
 * orchestrator's `spawn` tool accepts.
 */

export interface LocalAgentInfo {
  id: string
  displayName: string
  filePath: string
  /** True if this ships with Jean rather than being defined by the user. */
  isBundled?: boolean
}

/** Custom agents, by name, found at startup. */
let customAgents: Record<string, AgentDefinition> = {}
/** Where each custom agent is defined, for "open file" links. */
let customAgentPaths = new Map<string, string>()
let cachedList: LocalAgentInfo[] | null = null

/**
 * Loads the custom agents. Called once at startup; a failure leaves the
 * bundled ones, which is what the agent can spawn anyway.
 */
export async function initializeAgentRegistry(): Promise<void> {
  try {
    const found = discoverAgents(getProjectRoot() || process.cwd())
    customAgents = Object.fromEntries(
      found.map((agent) => [
        agent.name,
        {
          id: agent.name,
          displayName: agent.name,
          description: agent.purpose,
          toolNames: agent.tools === '*' ? undefined : agent.tools,
          instructionsPrompt: agent.instructions,
        },
      ]),
    )
    // `source` is `project:<path>` or `user:<path>`.
    customAgentPaths = new Map(
      found.filter((agent) => agent.source).map((agent) => [agent.name, agent.source!.slice(agent.source!.indexOf(':') + 1)]),
    )
  } catch (error) {
    logger.warn({ error }, '[agents] Could not read custom agents')
    customAgents = {}
    customAgentPaths = new Map()
  }
  cachedList = null
}

const getBundledAgents = (): Record<string, AgentDefinition> =>
  bundledAgentsModule.bundledAgents as Record<string, AgentDefinition>

/**
 * The agents for the `@` menu. Every mode is the main agent under different
 * settings, and the main agent can spawn every one of them, so the list does
 * not depend on the mode.
 */
export const loadLocalAgents = (_currentAgentMode?: AgentMode): LocalAgentInfo[] => {
  if (cachedList) return cachedList

  const byId = new Map<string, LocalAgentInfo>()
  for (const agent of bundledAgentsModule.getBundledAgentsAsLocalInfo()) byId.set(agent.id, agent)
  // A custom agent with a bundled name replaces it, as it does for `spawn`.
  for (const def of Object.values(customAgents)) {
    byId.set(def.id, { id: def.id, displayName: def.displayName || def.id, filePath: customAgentPaths.get(def.id) ?? '' })
  }

  cachedList = [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'en'))
  return cachedList
}

/** Full definitions: bundled, with custom agents overriding by name. */
export const loadAgentDefinitions = (): AgentDefinition[] => {
  const byId = new Map<string, AgentDefinition>()
  for (const def of Object.values(getBundledAgents())) byId.set(def.id, { ...def })
  for (const def of Object.values(customAgents)) byId.set(def.id, { ...def })
  return [...byId.values()]
}

/** The project's agent directory and what is in it, for error details. */
export const getLoadedAgentsData = (): {
  agents: LocalAgentInfo[]
  agentsDir: string
} | null => {
  const root = getProjectRoot() || process.cwd()
  const agentsDir = [path.join(root, '.jean', 'agents'), path.join(root, '.claude', 'agents')].find((dir) => existsSync(dir))
  const agents = loadLocalAgents()
  if (!agentsDir || agents.length === 0) return null
  return { agents, agentsDir }
}
