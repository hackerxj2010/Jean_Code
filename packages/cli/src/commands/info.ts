import { setSetting, type JeanConfig } from '@jean/config'
import { openMemory } from '@jean/memory'
import { discoverPlugins } from '@jean/plugins'
import { describeSkills, discoverSkills } from '@jean/skills'
import { color, errorLine, line, symbols } from '../ui.ts'

/**
 * The informational commands: `memory`, `skills`, `plugins`.
 * (`models` and `providers` live in `providers.ts`, `sessions` in `sessions.ts`.)
 *
 * Kept out of the entry point so they load only when asked for — the entry
 * point is on the path of every invocation, including `jean --version`.
 */

export function runMemoryCommand(positional: string[], config: JeanConfig, cwd: string): number {
  const { backend, warning } = openMemory(config)
  if (warning) errorLine(color.yellow(`${symbols.warn} ${warning}`))

  const [action, ...rest] = positional

  try {
    if (action === 'forget') {
      const id = Number(rest[0])
      if (!Number.isInteger(id)) {
        errorLine('Usage: jean memory forget <id>')
        return 2
      }
      const existing = backend.get(id)
      if (!existing) {
        errorLine(color.red(`No memory #${id}.`))
        return 1
      }
      backend.forget(id)
      line(`${color.green(symbols.check)} Deleted #${id}: ${existing.text.slice(0, 80)}`)
      return 0
    }

    const memories =
      action === 'search' && rest.length > 0
        ? backend.recall(rest.join(' '), { limit: 25 })
        : backend.recent({ limit: 25, project: action === 'all' ? undefined : cwd })

    if (memories.length === 0) {
      line(color.dim('  Nothing stored yet. The agent stores facts as it learns them.'))
      return 0
    }

    line()
    for (const memory of memories) {
      const when = new Date(memory.updatedAt).toISOString().slice(0, 10)
      line(`  ${color.cyan(`#${memory.id}`)} ${color.dim(`[${memory.kind}] ${when}`)}`)
      line(`    ${memory.text}`)
    }
    line()
    line(color.dim(`  ${backend.count()} total. Delete one with \`jean memory forget <id>\`.`))
    line()
    return 0
  } finally {
    backend.close()
  }
}

export function runSkillsCommand(cwd: string): number {
  const skills = discoverSkills(cwd)
  line()
  line(describeSkills(skills))
  line()
  if (skills.length > 0) {
    line(color.dim('  The agent sees every skill and loads the ones a task needs; it can also save new ones.'))
    line()
  }
  return 0
}

/**
 * `jean plugins` lists what is installed and which are enabled;
 * `jean plugins enable <name>` and `disable <name>` change the user's list.
 * Enabling is by name, never by presence: a plugin is code that runs inside
 * Jean, and dropping a directory into `~/.jean/plugins` must not be enough.
 */
export function runPluginsCommand(positional: string[], config: JeanConfig, cwd: string): number {
  const action = positional[0] ?? 'list'
  const enabled = new Set(config.plugins?.enabled ?? [])
  const plugins = discoverPlugins(cwd)

  if (action === 'enable' || action === 'disable') {
    const name = positional[1]
    if (!name) {
      errorLine(`Usage: jean plugins ${action} <name>`)
      return 2
    }
    if (action === 'enable' && !plugins.some((plugin) => plugin.manifest.name === name)) {
      errorLine(`No plugin named "${name}" in ~/.jean/plugins or .jean/plugins.`)
      return 1
    }
    if (action === 'enable') enabled.add(name)
    else enabled.delete(name)
    const path = setSetting('plugins.enabled', [...enabled].sort(), 'global', cwd)
    line(`${color.green(symbols.check)} ${name} ${action}d ${color.dim(`(${path})`)}`)
    if (action === 'enable') line(color.dim('  It loads in the next session, and reloads itself whenever its files change.'))
    return 0
  }
  if (action !== 'list') {
    errorLine(`Unknown action "${action}". Use list, enable <name>, or disable <name>.`)
    return 2
  }

  line()
  if (plugins.length === 0) {
    line(color.dim('  No plugins installed. A plugin is a directory with a jean-plugin.json, in ~/.jean/plugins or .jean/plugins.'))
  } else {
    for (const plugin of plugins) {
      const on = enabled.has(plugin.manifest.name)
      line(`  ${on ? color.green('●') : color.dim('○')} ${color.cyan(plugin.manifest.name.padEnd(22))} ${plugin.manifest.version} [${plugin.source}]${on ? '' : color.dim('  disabled')}`)
      if (plugin.manifest.description) line(color.dim(`    ${plugin.manifest.description}`))
    }
    line()
    line(color.dim(`  \`jean plugins enable <name>\` runs one. Hot reload is ${config.plugins?.hotReload === false ? 'off' : 'on'} (plugins.hotReload).`))
  }
  line()
  return 0
}

