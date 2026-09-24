import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { jeanHome, type ModelRole } from '@jean/config'
import { jeanName } from '@jean/hooks'
import { parseFrontMatter } from '@jean/skills'
import type { AgentDefinition } from './definitions.ts'

/**
 * Custom sub-agents, defined in Markdown.
 *
 * Claude Code's format and locations, so an existing `.claude/agents/` is
 * picked up as-is:
 *
 *     ---
 *     name: security-reviewer
 *     description: Reviews a diff for vulnerabilities. Use after any auth change.
 *     tools: Read, Grep, Glob, Bash
 *     model: opus
 *     ---
 *     You are a security reviewer. …
 *
 * `tools` narrows the surface (omitted means every tool the parent has), and
 * `model` is an alias — `sonnet`, `opus`, `haiku`, `inherit` — mapped onto
 * Jean's roles so the user's provider choices still apply, or a full model id.
 */

/** Claude Code model aliases onto the role that plays the same part here. */
const MODEL_ALIASES: Record<string, ModelRole> = {
  inherit: 'default',
  sonnet: 'default',
  opus: 'slow',
  haiku: 'smol',
}

export function discoverAgents(cwd: string, env: NodeJS.ProcessEnv = process.env): AgentDefinition[] {
  const home = env.HOME ?? env.USERPROFILE ?? homedir()
  const roots: [string, 'user' | 'project'][] = [
    [join(home, '.claude', 'agents'), 'user'],
    [join(jeanHome(env), 'agents'), 'user'],
    [join(cwd, '.claude', 'agents'), 'project'],
    [join(cwd, '.jean', 'agents'), 'project'],
  ]

  const found = new Map<string, AgentDefinition>()
  for (const [root, source] of roots) {
    if (!existsSync(root)) continue
    let entries: string[]
    try {
      entries = readdirSync(root).filter((f) => f.toLowerCase().endsWith('.md')).sort()
    } catch {
      continue
    }
    for (const entry of entries) {
      const agent = loadAgent(join(root, entry), source)
      if (agent) found.set(agent.name, agent)
    }
  }
  return [...found.values()]
}

export function loadAgent(path: string, source: 'user' | 'project'): AgentDefinition | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const { data, body } = parseFrontMatter(text)
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  const description = typeof data.description === 'string' ? data.description.trim() : ''
  // Both are required: the name is how it is spawned, the description is how
  // the parent decides to spawn it.
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name) || !description || !body.trim()) return undefined

  const rawTools = data.tools
  const toolList = Array.isArray(rawTools)
    ? rawTools
    : typeof rawTools === 'string' && rawTools.trim()
      ? rawTools.split(',').map((t) => t.trim()).filter(Boolean)
      : undefined

  const rawModel = typeof data.model === 'string' ? data.model.trim() : undefined
  const role = rawModel ? MODEL_ALIASES[rawModel.toLowerCase()] : undefined
  const model = rawModel && !role ? rawModel : undefined

  return {
    name,
    purpose: description.replace(/\s+/g, ' '),
    role: role ?? 'default',
    model,
    tools: toolList ? [...new Set(toolList.map(jeanName))] : '*',
    instructions: body.trim(),
    maxTurns: 60,
    source: `${source}: ${path}`,
  }
}
