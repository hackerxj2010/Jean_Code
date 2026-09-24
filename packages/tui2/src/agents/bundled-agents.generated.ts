/**
 * The sub-agents that ship with Jean Code.
 *
 * In the tool this was ported from, this file was generated at build time from
 * a directory of agent markdown. Jean's agents are code — the catalog lives in
 * `@jean/agent` — so this reads that catalog directly and needs no build step.
 * The filename is kept because the module is imported by that name.
 */

import { AGENTS } from '@jean/agent'

import type { LocalAgentInfo } from '../utils/local-agent-registry'

/** Every bundled agent, keyed by id. */
export const bundledAgents: Record<string, unknown> = Object.fromEntries(
  AGENTS.map((agent) => [
    agent.name,
    {
      id: agent.name,
      displayName: agent.name,
      description: agent.purpose,
      model: agent.role,
      toolNames: agent.tools === '*' ? undefined : agent.tools,
      instructionsPrompt: agent.instructions,
      maxSteps: agent.maxTurns,
      spawnableAgents: agent.canSpawn === true ? AGENTS.map((a) => a.name) : [],
    },
  ]),
)

export function getBundledAgentsAsLocalInfo(): LocalAgentInfo[] {
  return AGENTS.map((agent) => ({
    id: agent.name,
    displayName: agent.name,
    // These have no file on disk. The picker shows the path, so naming the
    // package is more useful than an empty string or an invented path that
    // would 404 if someone tried to open it.
    filePath: '@jean/agent',
    isBundled: true,
  }))
}

export function getBundledAgentIds(): string[] {
  return AGENTS.map((agent) => agent.name)
}

export function isBundledAgent(agentId: string): boolean {
  return AGENTS.some((agent) => agent.name === agentId)
}
