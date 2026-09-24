/**
 * `@jean/hooks` — the policy layer around every tool call.
 *
 * Two mechanisms, both speaking Claude Code's formats so existing project
 * settings work unchanged:
 *
 * * **Permission rules** (`Bash(npm test:*)`, `Read(./.env)`) decide whether a
 *   call may run, may run after asking, or may not run at all.
 * * **Hooks** are shell commands at fixed points — before and after a tool, on
 *   a prompt, at stop, at session start — that can veto, rewrite, annotate,
 *   or keep the agent working.
 *
 * Project-level hooks run only in trusted projects; see `load.ts` for why.
 */
export {
  isTrusted,
  loadPolicy,
  trustProject,
  trustStorePath,
  untrustProject,
  type LoadedPolicy,
  type LoadPolicyOptions,
} from './load.ts'
export { claudeInput, claudeName, jeanName, namesOf, pathOf } from './names.ts'
export {
  commandMatches,
  parseRule,
  pathMatches,
  PermissionPolicy,
  type Decision,
  type Rule,
} from './permissions.ts'
export {
  HOOK_EVENTS,
  HookRunner,
  type HookCommand,
  type HookEvent,
  type HookMatcher,
  type HookOutcome,
  type HooksConfig,
  type RunnerOptions,
  type SourcedHook,
} from './runner.ts'
