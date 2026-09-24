import type { JeanConfig } from '@jean/config'
import { listSessions } from '@jean/core'
import { openMemory } from '@jean/memory'
import { allModels, providerLabel, providerNames } from '@jean/model'
import { discoverPlugins } from '@jean/plugins'
import { describeSkills, discoverSkills } from '@jean/skills'
import { color, errorLine, line, symbols } from '../ui.ts'

/**
 * The informational commands: `models`, `memory`, `skills`, `plugins`,
 * `sessions`.
 *
 * Kept out of the entry point so they load only when asked for — the entry
 * point is on the path of every invocation, including `jean --version`.
 */

export function runModelsCommand(): number {
  line()
  line(color.bold('Providers'))
  for (const name of providerNames()) {
    line(`  ${color.cyan(name.padEnd(16))} ${providerLabel(name)}`)
  }
  line()
  line(color.bold('Catalog'))
  for (const model of allModels()) {
    const window = `${Math.round(model.contextWindow / 1000)}k`.padStart(6)
    const price = model.inputCost !== undefined ? `$${model.inputCost}/$${model.outputCost}` : ''
    const flags = [
      model.supportsThinking ? 'thinking' : '',
      model.supportsVision ? 'vision' : '',
    ]
      .filter(Boolean)
      .join(' ')
    line(`  ${color.cyan(model.id.padEnd(34))} ${window}  ${color.dim(`${price.padEnd(14)} ${flags}`)}`)
  }
  line()
  line(color.dim('  Any model id your provider serves works, listed or not.'))
  line()
  return 0
}

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

export function runPluginsCommand(cwd: string): number {
  const plugins = discoverPlugins(cwd)
  line()
  if (plugins.length === 0) {
    line(color.dim('  No plugins installed.'))
  } else {
    for (const plugin of plugins) {
      line(`  ${color.cyan(plugin.manifest.name.padEnd(22))} ${plugin.manifest.version} [${plugin.source}]`)
      if (plugin.manifest.description) line(color.dim(`    ${plugin.manifest.description}`))
    }
    line()
    line(
      color.yellow(
        `  ${symbols.warn} Plugin activation is not implemented yet — these are discovered but not loaded.`,
      ),
    )
  }
  line()
  return 0
}

export function runSessionsCommand(cwd: string): number {
  const sessions = listSessions(cwd, 20)
  if (sessions.length === 0) {
    line(color.dim('  No sessions in this directory yet.'))
    return 0
  }
  line()
  for (const session of sessions) {
    line(`  ${color.cyan(session.id)} ${color.dim(new Date(session.updatedAt).toLocaleString())}`)
    line(`    ${session.title}`)
  }
  line()
  line(color.dim('  Resume with `jean resume <id>`.'))
  line()
  return 0
}
