import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { jeanHome } from '@jean/config'

/**
 * `@jean/skills` — the skill engine (architecture §10.4).
 *
 * A skill is a `SKILL.md` file: YAML front matter describing when it applies,
 * and Markdown describing how to do the thing. Skills are loaded from the
 * project (`.jean/skills`) and from the user's home (`~/.jean/skills`), and the
 * matching ones are injected into the system prompt.
 *
 * The format is deliberately the agentskills.io one, so skills written for
 * other agents work here unchanged.
 */

export interface Skill {
  name: string
  /** One line. This is what the matcher reads, so it must say when to use it. */
  description: string
  /** Explicit trigger words, in addition to the description. */
  triggers: string[]
  /** The Markdown body: the instructions themselves. */
  body: string
  path: string
  source: 'project' | 'user' | 'builtin'
}

export interface FrontMatter {
  [key: string]: string | string[]
}

/**
 * Parses YAML front matter.
 *
 * Handles the subset skills actually use — `key: value`, quoted strings, inline
 * `[a, b]` lists, and `- item` block lists. A full YAML parser would be a
 * dependency and a much larger attack surface for a format this small.
 */
export function parseFrontMatter(text: string): { data: FrontMatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return { data: {}, body: text }

  const data: FrontMatter = {}
  const lines = match[1]!.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.trim() || line.trimStart().startsWith('#')) continue

    const colon = line.indexOf(':')
    if (colon < 0) continue

    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()

    // A block list: the following indented `- item` lines.
    if (value === '') {
      const items: string[] = []
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1]!)) {
        items.push(unquote(lines[++i]!.replace(/^\s*-\s+/, '').trim()))
      }
      if (items.length > 0) {
        data[key] = items
        continue
      }
    }

    // An inline list.
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((v) => unquote(v.trim()))
        .filter(Boolean)
      continue
    }

    data[key] = unquote(value)
  }

  return { data, body: match[2] ?? '' }
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * The `skills/` directory that ships with Jean Code.
 *
 * Resolved from this module's own location so it works from a source checkout,
 * a global install, or a bundle.
 */
export function builtinSkillsDir(): string {
  return join(import.meta.dir, '..', '..', '..', 'skills')
}

/** Reads one SKILL.md. */
export function loadSkill(path: string, source: Skill['source']): Skill | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }

  const { data, body } = parseFrontMatter(text)
  const name = asString(data.name) ?? basename(join(path, '..'))
  const description = asString(data.description) ?? ''
  if (!description) return undefined // a skill with no description can never match

  const triggers = Array.isArray(data.triggers)
    ? data.triggers
    : typeof data.triggers === 'string'
      ? data.triggers.split(',').map((t) => t.trim())
      : []

  return { name, description, triggers, body: body.trim(), path, source }
}

function asString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Discovers every skill available to a project.
 *
 * Project skills win over user skills of the same name: a repository's own way
 * of doing something is more specific than a personal default.
 */
/** Where skills are looked for, lowest precedence first. */
export function skillRoots(cwd: string): [string, Skill['source']][] {
  return [
    // Bundled skills ship with the repository. They sit lowest so a user or
    // project skill of the same name replaces them entirely.
    [builtinSkillsDir(), 'builtin'],
    [join(homedir(), '.claude', 'skills'), 'user'],
    [join(jeanHome(), 'skills'), 'user'],
    [join(cwd, '.jean', 'skills'), 'project'],
    // Skills written for Claude Code use the same format and directory shape.
    [join(cwd, '.claude', 'skills'), 'project'],
  ]
}

/**
 * A fingerprint of every SKILL.md: which exist and when each last changed.
 * A few `stat` calls — cheap enough to take before every turn, so a skill
 * written by hand in another window is there on the next prompt.
 */
export function skillsSignature(cwd: string): string {
  const parts: string[] = []
  for (const [root] of skillRoots(cwd)) {
    if (!existsSync(root)) continue
    for (const entry of safeReaddir(root)) {
      const file = join(root, entry, 'SKILL.md')
      try {
        parts.push(`${file}:${statSync(file).mtimeMs}`)
      } catch {
        // No SKILL.md in that directory: not a skill.
      }
    }
  }
  return parts.join('|')
}

export function discoverSkills(cwd: string): Skill[] {
  const found = new Map<string, Skill>()

  for (const [root, source] of skillRoots(cwd)) {
    if (!existsSync(root)) continue
    for (const entry of safeReaddir(root)) {
      const dir = join(root, entry)
      if (!isDirectory(dir)) continue
      const skill = loadSkill(join(dir, 'SKILL.md'), source)
      if (skill) found.set(skill.name, skill)
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Picks the skills relevant to a prompt.
 *
 * Scored on trigger words first, then description terms. The bar is
 * deliberately high: injecting an irrelevant skill spends context and pulls the
 * agent toward the wrong procedure, which is worse than injecting nothing.
 */
export function matchSkills(skills: Skill[], prompt: string, limit = 3): Skill[] {
  const text = prompt.toLowerCase()

  const scored = skills
    .map((skill) => {
      let score = 0
      for (const trigger of skill.triggers) {
        if (trigger && text.includes(trigger.toLowerCase())) score += 3
      }
      const terms = skill.description
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 4)
      const hits = terms.filter((t) => text.includes(t)).length
      if (terms.length > 0) score += (hits / terms.length) * 2
      if (text.includes(skill.name.toLowerCase().replace(/-/g, ' '))) score += 3
      return { skill, score }
    })
    .filter((s) => s.score >= 1.5)

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((s) => s.skill)
}

/** Renders matched skills as a system-prompt section. */
export function renderSkills(skills: Skill[]): string | undefined {
  if (skills.length === 0) return undefined
  return [
    '## Applicable skills',
    '',
    'Procedures for this kind of work, from this project or your own library.',
    '',
    ...skills.map((skill) => `### ${skill.name}\n\n${skill.body}`),
  ].join('\n')
}

/** A catalogue line per skill, for `jean skills`. */
export function describeSkills(skills: Skill[]): string {
  if (skills.length === 0) {
    return `No skills found. Add one at .jean/skills/<name>/SKILL.md with YAML front matter (name, description) and Markdown instructions.`
  }
  return skills
    .map((s) => `  ${s.name.padEnd(24)} [${s.source}] ${s.description.slice(0, 80)}`)
    .join('\n')
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Skills as tools: loaded on demand, and written by the agent itself.

/**
 * Minimal structural tool shape, so this package does not depend on
 * `@jean/tools` — the registry accepts anything with these fields.
 */
export interface SkillTool<Args> {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  risk: 'read' | 'write'
  concurrency?: 'parallel' | 'serial'
  summarize?: (args: Args) => string
  execute: (args: Args) => Promise<{ output: string; isError?: boolean; touched?: string[] }>
}

/**
 * The two skill tools.
 *
 * `skill` is progressive disclosure: the model sees every skill's name and
 * one-line description, and loads a body only when it decides one applies.
 * The model is far better at judging relevance than a keyword matcher, and
 * the bodies cost nothing until used.
 *
 * `skill_save` is the other half of "grows smarter every day": when the agent
 * works out a non-obvious procedure — how this repo's release works, the
 * incantation that makes the flaky test deterministic — it writes it down, and
 * every later session finds it through `skill`.
 */
export function createSkillTools(options: {
  cwd: string
  skills: () => Skill[]
  /** Called after a save so the caller can refresh its list. */
  onSaved?: (skill: Skill) => void
}): SkillTool<any>[] {
  const load: SkillTool<{ name: string }> = {
    name: 'skill',
    risk: 'read',
    get description() {
      const list = options
        .skills()
        .map((s) => `- ${s.name}: ${s.description}`)
        .join('\n')
      return [
        'Load a skill: a written procedure for a kind of task, from this project or the user\'s library.',
        'When a task matches a skill below, load it before starting and follow it.',
        '',
        list ? `Available skills:\n${list}` : 'No skills are installed yet.',
      ].join('\n')
    },
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The skill to load.' } },
      required: ['name'],
    },
    summarize: (args) => `skill ${args.name}`,
    async execute(args) {
      const skill = options.skills().find((s) => s.name === args.name)
      if (!skill) {
        const names = options.skills().map((s) => s.name).join(', ')
        return { output: `No skill named "${args.name}".${names ? ` Available: ${names}.` : ''}`, isError: true }
      }
      return {
        output: `# Skill: ${skill.name}\n(${skill.source}; supporting files, if any, are in ${dirname(skill.path)})\n\n${skill.body}`,
      }
    },
  }

  const save: SkillTool<{
    name: string
    description: string
    instructions: string
    triggers?: string[]
    scope?: 'user' | 'project'
    replace?: boolean
  }> = {
    name: 'skill_save',
    risk: 'write',
    concurrency: 'serial',
    description: [
      'Save a procedure you worked out as a skill, so future sessions can reuse it.',
      '',
      'Save one when you solved something non-obvious that will come up again: a build or',
      'release sequence, how to run this repo\'s tests reliably, a workaround for a tool.',
      'Do not save one-off facts (use `retain` for those) or anything obvious from the code.',
      '',
      'Write the instructions as steps another agent can follow cold, with exact commands.',
      '`scope: "project"` stores it in the repository (.jean/skills) for the whole team;',
      '`"user"` (the default) stores it in your personal library.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'kebab-case, e.g. "release-to-npm".' },
        description: {
          type: 'string',
          description: 'One line saying when to use it — this is what future sessions see.',
        },
        instructions: { type: 'string', description: 'The procedure, in Markdown.' },
        triggers: { type: 'array', items: { type: 'string' }, description: 'Words that should bring it to mind.' },
        scope: { type: 'string', enum: ['user', 'project'] },
        replace: { type: 'boolean', description: 'Overwrite an existing skill of this name.' },
      },
      required: ['name', 'description', 'instructions'],
    },
    summarize: (args) => `save skill ${args.name}`,
    async execute(args) {
      const name = String(args.name).trim().toLowerCase()
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) {
        return { output: 'Skill names are kebab-case: lowercase letters, digits, and hyphens.', isError: true }
      }
      const description = String(args.description).replace(/\s+/g, ' ').trim()
      if (description.length < 10) {
        return { output: 'Give the skill a description that says when to use it.', isError: true }
      }
      const root = args.scope === 'project' ? join(options.cwd, '.jean', 'skills') : join(jeanHome(), 'skills')
      const path = join(root, name, 'SKILL.md')
      if (existsSync(path) && !args.replace) {
        return {
          output: `A skill named "${name}" already exists at ${path}. Load it with \`skill\` and pass replace: true to update it.`,
          isError: true,
        }
      }
      const triggers = (args.triggers ?? []).map((t) => String(t).trim()).filter(Boolean)
      const text = [
        '---',
        `name: ${name}`,
        `description: ${JSON.stringify(description)}`,
        ...(triggers.length > 0 ? [`triggers: [${triggers.map((t) => JSON.stringify(t)).join(', ')}]`] : []),
        `created: ${new Date().toISOString().slice(0, 10)}`,
        '---',
        '',
        String(args.instructions).trim(),
        '',
      ].join('\n')
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text, 'utf8')
      const skill = loadSkill(path, args.scope === 'project' ? 'project' : 'user')
      if (skill) options.onSaved?.(skill)
      return { output: `Saved skill "${name}" to ${path}.`, touched: [path] }
    },
  }

  return [load, save]
}
