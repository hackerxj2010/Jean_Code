/**
 * `@jean/agent` — the orchestrator and the specialized agents.
 *
 * The `Orchestrator` owns a session: its event store, its tool registry, its
 * mode. Sub-agents run their own loops with their own context and their own
 * tool surface, and contribute only their final report upward — which is what
 * keeps the parent's context clean while it delegates.
 */
export { Orchestrator } from './orchestrator/index.ts'
export { discoverAgents, loadAgent } from './agents/custom.ts'
export type { OrchestratorOptions, SendOptions } from './orchestrator/index.ts'
export {
  describeKeywords,
  detectKeywords,
  MAGIC_KEYWORDS,
} from './orchestrator/keywords.ts'
export type { KeywordEffect } from './orchestrator/keywords.ts'
export {
  AGENTS,
  agentNames,
  describeAgents,
  findAgent,
} from './agents/definitions.ts'
export type { AgentDefinition } from './agents/definitions.ts'
export {
  createSpawnTool,
  fanOut,
  MAX_DEPTH,
  rosterOf,
  spawnSubagent,
} from './subagent.ts'
export type { SpawnOptions, SubagentResult } from './subagent.ts'
export { createMemoryTools } from './memory-tools.ts'
export { runArena } from './arena.ts'
export type { ArenaEntry, ArenaOptions, ArenaResult } from './arena.ts'
