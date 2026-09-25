import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { jeanHome, setSetting, type JeanConfig } from '@jean/config'
import { color, errorLine, line, symbols } from '../ui.ts'

/**
 * Managing what a session is made of, from the command line.
 *
 *   jean agents                                  the agents `spawn` can start
 *   jean agents create <name> "<description>" [--global]
 *   jean mcp                                     configured MCP servers
 *   jean mcp add <name> -- <command…>   or   jean mcp add <name> <url>   [--global]
 *   jean mcp remove <name> [--global]
 *   jean pr <number> [-p "…"]                    check out a pull request, then work on it
 *   jean upgrade [--check]                       bring this checkout of Jean up to date
 */

type Flags = Record<string, string | boolean | number>

/** `jean agents` */
export async function runAgentsCommand(positional: string[], cwd: string, flags: Flags): Promise<number> {
  const [action, name, ...rest] = positional
  const { discoverAgents, rosterOf } = await import('@jean/agent')

  if (action === 'create' || action === 'new') {
    if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      errorLine('Usage: jean agents create <name> "<what it does, and when to use it>" [--global]   (name: lowercase letters, digits, dashes)')
      return 2
    }
    const dir = flags.global === true ? join(jeanHome(), 'agents') : join(cwd, '.jean', 'agents')
    const path = join(dir, `${name}.md`)
    if (existsSync(path)) {
      errorLine(color.red(`${symbols.cross} ${path} already exists.`))
      return 1
    }
    const description = rest.join(' ').trim() || `Describe what ${name} does and when the agent should use it.`
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path,
      [
        '---',
        `name: ${name}`,
        `description: ${description}`,
        'tools: Read, Grep, Glob',
        'model: inherit',
        '---',
        '',
        `You are ${name}. ${description}`,
        '',
        'Say how to work: what to look at first, what to check, and what the report must contain —',
        'the agent sees only this and the task it is given, never the conversation.',
        '',
        '(`tools`: omit it for every tool the parent has. `model`: inherit, sonnet, opus, haiku, or a',
        'full id such as opencode:claude-sonnet-5.)',
        '',
      ].join('\n'),
    )
    line(`${symbols.check} Created ${color.cyan(path)}. The agent can \`spawn\` it from the next prompt.`)
    return 0
  }

  const roster = rosterOf(discoverAgents(cwd))
  line()
  for (const agent of roster) {
    const source = agent.source ? color.dim(` [${agent.source.split(':')[0]}]`) : ''
    line(`  ${color.cyan(agent.name.padEnd(18))} ${agent.purpose.slice(0, 90)}${source}`)
  }
  line()
  line(color.dim('  Add one: jean agents create <name> "<description>" — a Markdown file in .jean/agents (.claude/agents works too).'))
  line()
  return 0
}

/** `jean mcp` */
export function runMcpCommand(positional: string[], config: JeanConfig, cwd: string, flags: Flags): number {
  const [action, name, ...rest] = positional
  const scope = flags.global === true ? 'global' : 'project'

  if (action === 'add') {
    if (!name || rest.length === 0) {
      errorLine('Usage: jean mcp add <name> -- <command> [args…]   or   jean mcp add <name> https://…/mcp   [--global]')
      return 2
    }
    const target = rest[0]!
    const server = /^https?:\/\//.test(target) ? { type: 'http', url: target } : { command: target, args: rest.slice(1) }
    const path = setSetting(`mcpServers.${name}`, server, scope, cwd)
    line(`${symbols.check} Added MCP server ${color.cyan(name)} to ${color.dim(path)}.`)
    if (scope === 'project') line(color.dim('  A project’s servers run only once it is trusted (`jean trust`).'))
    return 0
  }

  if (action === 'remove' || action === 'rm') {
    if (!name) {
      errorLine('Usage: jean mcp remove <name> [--global]')
      return 2
    }
    if (!config.mcpServers[name]) {
      errorLine(color.red(`${symbols.cross} No MCP server named "${name}".`))
      return 1
    }
    const path = setSetting(`mcpServers.${name}`, undefined, scope, cwd)
    line(`${symbols.check} Removed ${color.cyan(name)} from ${color.dim(path)}.`)
    return 0
  }

  const servers = Object.entries(config.mcpServers)
  line()
  if (servers.length === 0) line(color.dim('  No MCP servers configured.'))
  for (const [id, server] of servers) {
    const how = server.url ? `${server.type ?? 'http'} ${server.url}` : `stdio ${[server.command, ...(server.args ?? [])].join(' ')}`
    line(`  ${color.cyan(id.padEnd(20))} ${color.dim(how)}`)
  }
  line()
  line(color.dim('  jean mcp add <name> -- <command…> (or a URL) · jean mcp remove <name> · /mcp in a session shows what connected'))
  line()
  return 0
}

/**
 * `jean pr <number>`: checks the pull request out with `gh`, so the session
 * that follows works on its branch. Returns a one-line description of it,
 * or `undefined` when the checkout failed.
 */
export async function checkoutPullRequest(positional: string[], cwd: string): Promise<string | undefined> {
  const number = positional[0]
  if (!number || !/^\d+$/.test(number)) {
    errorLine('Usage: jean pr <number> [-p "what to do with it"]')
    return undefined
  }
  const run = (args: string[]) => Bun.spawnSync(['gh', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  let checkout: ReturnType<typeof run>
  try {
    checkout = run(['pr', 'checkout', number])
  } catch {
    errorLine(color.red(`${symbols.cross} \`jean pr\` needs the GitHub CLI (gh): https://cli.github.com`))
    return undefined
  }
  if (checkout.exitCode !== 0) {
    errorLine(color.red(`${symbols.cross} gh pr checkout ${number}: ${checkout.stderr.toString().trim()}`))
    return undefined
  }
  const view = run(['pr', 'view', number, '--json', 'title,headRefName,url'])
  let summary = `pull request #${number}`
  try {
    const pr = JSON.parse(view.stdout.toString()) as { title?: string; headRefName?: string; url?: string }
    summary = `#${number} “${pr.title ?? ''}” (${pr.headRefName ?? 'its branch'})`
    line(`${symbols.check} Checked out ${summary}${pr.url ? color.dim(` — ${pr.url}`) : ''}`)
  } catch {
    line(`${symbols.check} Checked out ${summary}.`)
  }
  line(color.dim(`  Its description, files, and review comments: ask for pr://${number}.`))
  return summary
}

/** Where the installers are served from. */
const INSTALLER_URL = 'https://raw.githubusercontent.com/hackerxj2010/Jean_Code/main'

/**
 * `jean upgrade`: the checkout Jean runs from, brought up to date — a
 * fast-forward pull, then its dependencies and native core rebuilt.
 *
 * It never touches a checkout with uncommitted changes: that is someone
 * working on Jean, and their work comes before an update.
 */
export async function runUpgradeCommand(flags: Flags): Promise<number> {
  // A compiled release has no checkout to pull: it was installed from npm or
  // a release download, and is updated the same way.
  if (/[$]bunfs|~BUN/.test(import.meta.dir)) {
    const fromNpm = /[\\/]node_modules[\\/]/.test(process.execPath)
    line(
      fromNpm
        ? `Installed with npm. Update with:\n  npm install -g jean-code@latest`
        : process.platform === 'win32'
          ? `Update by running the installer again:\n  irm ${INSTALLER_URL}/install.ps1 | iex`
          : `Update by running the installer again:\n  curl -fsSL ${INSTALLER_URL}/install.sh | sh`,
    )
    return 0
  }

  const root = join(import.meta.dir, '..', '..', '..', '..')
  const git = (args: string[]) => Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' })

  if (!existsSync(join(root, '.git'))) {
    errorLine(color.red(`${symbols.cross} ${root} is not a git checkout. Reinstall with install.sh (or install.ps1) to get one that updates.`))
    return 1
  }
  const dirty = git(['status', '--porcelain']).stdout.toString().trim()
  if (dirty) {
    errorLine(color.red(`${symbols.cross} ${root} has uncommitted changes; commit or stash them first. Nothing was changed.`))
    return 1
  }
  if (git(['rev-parse', '--abbrev-ref', '@{u}']).exitCode !== 0) {
    errorLine(color.red(`${symbols.cross} The checkout's branch follows no remote branch, so there is nothing to pull from.`))
    return 1
  }

  const fetched = git(['fetch', '--quiet'])
  if (fetched.exitCode !== 0) {
    errorLine(color.red(`${symbols.cross} git fetch: ${fetched.stderr.toString().trim()}`))
    return 1
  }
  const behind = Number(git(['rev-list', '--count', 'HEAD..@{u}']).stdout.toString().trim() || '0')
  if (behind === 0) {
    line(`${symbols.check} Jean is up to date.`)
    return 0
  }
  line(`  ${behind} new commit${behind === 1 ? '' : 's'} upstream.`)
  if (flags.check === true) return 0

  const pulled = git(['pull', '--ff-only', '--quiet'])
  if (pulled.exitCode !== 0) {
    errorLine(color.red(`${symbols.cross} git pull --ff-only: ${pulled.stderr.toString().trim()}`))
    return 1
  }
  line(`${symbols.check} Pulled. Installing dependencies…`)
  const installed = Bun.spawnSync(['bun', 'install'], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
  if (installed.exitCode !== 0) return installed.exitCode ?? 1
  const { runNativeCommand } = await import('./native.ts')
  return runNativeCommand(['build'])
}
