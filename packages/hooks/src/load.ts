import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { jeanHome, parseJsonc } from '@jean/config'
import { parseRule, PermissionPolicy, type Decision, type Rule } from './permissions.ts'
import { HOOK_EVENTS, type HookEvent, type SourcedHook } from './runner.ts'

/**
 * Where hooks and permission rules come from, and which of them to believe.
 *
 * Layers, lowest to highest: Claude Code's user settings, Jean's global
 * config, then — for the project — `.claude/settings.json`,
 * `.claude/settings.local.json`, and `.jean.json`. Rules accumulate across
 * layers rather than replacing each other, as they do in Claude Code: a
 * project adding one deny rule should not erase the user's.
 *
 * **Trust.** A hook is a shell command, and a repository can ship one. If a
 * freshly cloned repo's hooks ran automatically, opening it with Jean would
 * run code its author chose. So project hooks — and project *allow* rules,
 * which widen what runs unasked — apply only in projects the user has trusted
 * with `jean trust`. Project deny and ask rules always apply: they can only
 * make Jean more careful.
 */

export interface LoadedPolicy {
  policy: PermissionPolicy
  hooks: Partial<Record<HookEvent, SourcedHook[]>>
  /** Files that contributed, for `jean doctor`. */
  sources: string[]
  /** What was skipped because the project is not trusted. */
  ignored: string[]
  warnings: string[]
}

interface Layer {
  path: string
  /** Project layers are subject to trust. */
  project: boolean
}

export interface LoadPolicyOptions {
  cwd: string
  /** Read Claude Code's settings files too. Default true. */
  importClaude?: boolean
  /** Override the trust decision (tests, `--trust`). */
  trusted?: boolean
  env?: NodeJS.ProcessEnv
}

export function loadPolicy(options: LoadPolicyOptions): LoadedPolicy {
  const env = options.env ?? process.env
  const cwd = resolve(options.cwd)
  const trusted = options.trusted ?? isTrusted(cwd, env)
  const importClaude = options.importClaude !== false
  const home = env.HOME ?? env.USERPROFILE ?? homedir()

  const layers: Layer[] = [
    ...(importClaude ? [{ path: join(home, '.claude', 'settings.json'), project: false }] : []),
    { path: join(jeanHome(env), 'config.json'), project: false },
    ...(importClaude
      ? [
          { path: join(cwd, '.claude', 'settings.json'), project: true },
          { path: join(cwd, '.claude', 'settings.local.json'), project: true },
        ]
      : []),
    { path: join(cwd, '.jean.json'), project: true },
  ]

  const rules: Rule[] = []
  const hooks: Partial<Record<HookEvent, SourcedHook[]>> = {}
  const sources: string[] = []
  const ignored: string[] = []
  const warnings: string[] = []

  for (const layer of layers) {
    if (!existsSync(layer.path)) continue
    let parsed: unknown
    try {
      parsed = parseJsonc(readFileSync(layer.path, 'utf8'), layer.path)
    } catch (err) {
      warnings.push(`${layer.path}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const root = parsed as Record<string, unknown>
    let used = false

    const permissions = root.permissions
    if (permissions && typeof permissions === 'object' && !Array.isArray(permissions)) {
      for (const decision of ['deny', 'ask', 'allow'] as Decision[]) {
        const list = (permissions as Record<string, unknown>)[decision]
        if (!Array.isArray(list)) continue
        for (const raw of list) {
          if (typeof raw !== 'string') continue
          if (layer.project && decision === 'allow' && !trusted) {
            ignored.push(`allow rule \`${raw}\` from ${layer.path}`)
            continue
          }
          const rule = parseRule(raw, decision, layer.path)
          if (rule) {
            rules.push(rule)
            used = true
          } else {
            warnings.push(`${layer.path}: \`${raw}\` is not a permission rule`)
          }
        }
      }
    }

    const hookConfig = root.hooks
    if (hookConfig && typeof hookConfig === 'object' && !Array.isArray(hookConfig)) {
      for (const [event, entries] of Object.entries(hookConfig as Record<string, unknown>)) {
        if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
          warnings.push(`${layer.path}: unknown hook event \`${event}\``)
          continue
        }
        for (const hook of readHooks(entries, layer.path)) {
          if (layer.project && !trusted) {
            ignored.push(`${event} hook \`${hook.command}\` from ${layer.path}`)
            continue
          }
          ;(hooks[event as HookEvent] ??= []).push(hook)
          used = true
        }
      }
    }

    if (used) sources.push(layer.path)
  }

  return { policy: new PermissionPolicy(rules), hooks, sources, ignored, warnings }
}

function readHooks(entries: unknown, source: string): SourcedHook[] {
  if (!Array.isArray(entries)) return []
  const out: SourcedHook[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const { matcher, hooks } = entry as { matcher?: unknown; hooks?: unknown }
    if (!Array.isArray(hooks)) continue
    for (const hook of hooks) {
      if (!hook || typeof hook !== 'object') continue
      const h = hook as Record<string, unknown>
      if (h.type !== undefined && h.type !== 'command') continue
      if (typeof h.command !== 'string' || h.command.trim() === '') continue
      out.push({
        type: 'command',
        command: h.command,
        timeout: typeof h.timeout === 'number' && h.timeout > 0 ? h.timeout : undefined,
        matcher: typeof matcher === 'string' ? matcher : undefined,
        source,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The trust store: which project roots may run their own hooks.

export function trustStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(jeanHome(env), 'trust.json')
}

function readTrusted(env: NodeJS.ProcessEnv): string[] {
  try {
    const raw = JSON.parse(readFileSync(trustStorePath(env), 'utf8')) as { projects?: unknown }
    return Array.isArray(raw.projects) ? raw.projects.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

function key(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** True when `cwd` or a directory above it has been trusted. */
export function isTrusted(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.JEAN_TRUST_PROJECT === '1') return true
  const target = key(cwd)
  return readTrusted(env).some((root) => {
    const k = key(root)
    return target === k || target.startsWith(`${k}/`) || target.startsWith(`${k}\\`)
  })
}

export function trustProject(cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const projects = readTrusted(env)
  if (projects.some((p) => key(p) === key(cwd))) return
  projects.push(resolve(cwd))
  writeTrusted(projects, env)
}

export function untrustProject(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const projects = readTrusted(env)
  const kept = projects.filter((p) => key(p) !== key(cwd))
  if (kept.length === projects.length) return false
  writeTrusted(kept, env)
  return true
}

function writeTrusted(projects: string[], env: NodeJS.ProcessEnv): void {
  const path = trustStorePath(env)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ projects }, null, 2)}\n`, 'utf8')
}
