/**
 * `@jean/core` — the agent loop and its state.
 *
 * The `EventStore` is the single source of truth: every turn, tool call, and
 * compaction is an append-only event, and the transcript sent to the model is
 * derived from it. Rewind is a truncation, resume is a replay, and the TUI is
 * a subscriber — none of them keep their own copy of the conversation.
 */
export { EventStore } from './eventstore.ts'
export type { EventListener, JeanEvent } from './eventstore.ts'
export {
  measureContext,
  measureContextExact,
  messageTokens,
  renderTranscript,
  splitForCompaction,
  trimToolResults,
} from './context.ts'
export type { ContextStatus } from './context.ts'
export {
  archiveRoot,
  compact,
  createArchiveTool,
  deterministicSummary,
  IDLE_COMPACTION_MS,
  shouldCompactOnIdle,
} from './compaction.ts'
export type { CompactionResult } from './compaction.ts'
export { Freshness } from './freshness.ts'
export { FileHistory, type RedoResult, type RewindResult } from './history.ts'
export {
  MAX_PARALLEL_CALLS,
  mapLimit,
  partition,
  RepeatTracker,
  runLoop,
  stableStringify,
  textOf,
} from './loop.ts'
export type {
  AfterToolDecision,
  BeforeToolDecision,
  LoopEvent,
  LoopHooks,
  LoopOptions,
  LoopResult,
  ToolCallRef,
} from './loop.ts'
export {
  buildSubagentPrompt,
  buildSystemPrompt,
  loadInstructionFiles,
  repositorySnapshot,
} from './prompt.ts'
export type { InstructionFile, PromptParts } from './prompt.ts'
export {
  deleteSession,
  exportSession,
  forkSession,
  importSession,
  latestSession,
  listSessions,
  loadSession,
  newSessionId,
  renameSession,
  sanitizeEvents,
  saveSession,
  sessionMarkdown,
  sessionPath,
} from './session.ts'
export type { SessionExport, SessionMeta } from './session.ts'
