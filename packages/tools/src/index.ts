/**
 * `@jean/tools` — the tool harness.
 *
 * Everything the agent can do to the world is a tool, and every tool call goes
 * through the `Registry`. That single choke point is what makes permission
 * gating, argument validation, and audit one implementation rather than a
 * convention each tool is trusted to follow.
 *
 * The file, search, and shell tools here are the TypeScript path to the Rust
 * core in `crates/`. They implement the same behaviour so the CLI runs before
 * anything is compiled; the native path is the fast path, not the only one.
 */
import { fileTools } from './file.ts'
import { searchTools } from './search.ts'
import { shellTools } from './shell.ts'
import { todoTool } from './todo.ts'
import type { Tool } from './types.ts'
import { transcribeTool } from './voice.ts'

export * from './types.ts'
export { registerReadSource, type ReadSource } from './file.ts'
export { Registry, validateArgs, RISK_ORDER } from './registry.ts'
export type { CallRecord, RegistryOptions } from './registry.ts'
export {
  applyUnifiedDiff,
  displayPath,
  editTool,
  fileTools,
  gutter,
  readTool,
  isSecretFile,
  resolveInWorkspace,
  writeTool,
  type EditArgs,
  type Replacement,
} from './file.ts'
export { replaceText, ReplaceError, similarity, type ReplaceResult, type Strategy } from './replace.ts'
export {
  compilePattern,
  globToRegExp,
  globTool,
  grepTool,
  IgnoreSet,
  searchTools,
  walk,
} from './search.ts'
export type { WalkEntry, WalkOptions } from './search.ts'
export {
  bashOutputTool,
  bashTool,
  classifyCommand,
  defaultShell,
  findWindowsBash,
  clipOutput,
  isSpilledOutput,
  OutputBuffer,
  outputSpillDir,
  shellTools,
  toNativePath,
} from './shell.ts'
export { todoTool } from './todo.ts'
export { transcribeTool, transcriptionEndpoint } from './voice.ts'
export * as hashline from './hashline.ts'

/** Every built-in tool, in the order they are advertised to the model. */
export function builtinTools(): Tool[] {
  return [...fileTools, ...searchTools, ...shellTools, todoTool, transcribeTool]
}

export {
  checkpointRoot,
  CheckpointStore,
  createCheckpointTool,
  type Checkpoint,
} from './checkpoint.ts'

export { createAskTool, type AskHandler, type AskRequest } from './ask.ts'
