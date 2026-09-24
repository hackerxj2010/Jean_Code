import { defaultConfig, type JeanConfig } from '../../packages/config/src/index.ts'
import {
  createSessionState as makeSessionState,
  type ToolContext,
} from '../../packages/tools/src/index.ts'

/**
 * Shared test scaffolding.
 *
 * A `ToolContext` needs a config, a session, and a working directory; building
 * one inline in every test obscures what the test is actually about.
 */

export { CheckpointStore, createAskTool } from '../../packages/tools/src/index.ts'

export function defaultConfigForTest(overrides: Partial<JeanConfig> = {}): JeanConfig {
  return { ...defaultConfig(), ...overrides }
}

/** A tool context rooted at `cwd`. */
export function createSessionState(
  cwd: string,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    cwd,
    config: defaultConfigForTest(),
    session: makeSessionState(cwd),
    ...overrides,
  }
}
