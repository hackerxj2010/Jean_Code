import { existsSync } from 'node:fs'
import { platform, release } from 'node:os'
import {
  configuredProviders,
  globalConfigPath,
  jeanHome,
  supportedFormats,
  type LoadedConfig,
} from '@jean/config'
import { loadInstructionFiles } from '@jean/core'
import { createProvider, modelInfo, providerLabel, providerNames } from '@jean/model'
import { openMemory } from '@jean/memory'
import { nativeStatus } from '@jean/native'
import { color, line, symbols } from '../ui.ts'
import { languageToolsSummary } from './languages.ts'
import { CRATE_ROLES } from './native.ts'

/**
 * `jean doctor` — diagnose why something is not working.
 *
 * Ordered by how often each thing is the actual problem: credentials first,
 * then which config files won, then whether the model id is real, then
 * everything else. The point is that the first thing on screen is usually the
 * answer.
 */

export async function runDoctor(loaded: LoadedConfig, cwd: string): Promise<number> {
  const { config, sources, warnings } = loaded
  let problems = 0

  const ok = (text: string) => line(`  ${color.green(symbols.check)} ${text}`)
  const bad = (text: string) => {
    problems++
    line(`  ${color.red(symbols.cross)} ${text}`)
  }
  const warn = (text: string) => line(`  ${color.yellow(symbols.warn)} ${text}`)
  const info = (text: string) => line(color.dim(`    ${text}`))

  line()
  line(color.bold('Jean Code doctor'))
  line(color.dim(`  ${platform()} ${release()} · node ${process.version}`))
  line()

  // 1. Credentials — the overwhelmingly common failure.
  line(color.bold('Providers'))
  const available = configuredProviders()
  if (available.length === 0) {
    bad('No provider credentials found in the environment.')
    info('Set OPENROUTER_API_KEY to reach every provider with one key:')
    info('  export OPENROUTER_API_KEY=sk-or-...')
    info('Or set a provider-specific key: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY.')
  } else {
    ok(`Credentials found for: ${available.map(providerLabel).join(', ')}`)
  }

  const active = config.model.provider
  if (!providerNames().includes(active)) {
    bad(`Configured provider "${active}" is not one Jean Code knows.`)
    info(`Known providers: ${providerNames().join(', ')}`)
  } else {
    try {
      const provider = createProvider(active, {
        apiKey: config.model.apiKey,
        baseUrl: config.model.baseUrl,
      })
      if (provider.isConfigured()) ok(`Active provider ${providerLabel(active)} has a key.`)
      else bad(`Active provider ${providerLabel(active)} has no key — requests will fail.`)
    } catch (err) {
      bad(`Could not build provider ${active}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  line()

  // 2. Model.
  line(color.bold('Model'))
  const info_ = modelInfo(config.model.modelId, active)
  ok(`${config.model.modelId} — ${(info_.contextWindow / 1000).toFixed(0)}k context, ${info_.maxOutput.toLocaleString()} max output`)
  if (info_.label === info_.id) {
    warn('This model is not in the bundled catalog, so context limits are assumed.')
    info('That is fine — it just means auto-compaction uses conservative defaults.')
  }
  line()

  // 3. Configuration precedence.
  line(color.bold('Configuration'))
  for (const source of sources) {
    line(color.dim(`  ${source.kind.padEnd(10)} ${source.path}`))
  }
  if (!existsSync(globalConfigPath())) {
    info(`No global config yet. \`jean config set <key> <value>\` creates ${globalConfigPath()}.`)
  }
  for (const warning of warnings) warn(warning)
  line()

  // 4. Project context.
  line(color.bold('Project'))
  const instructions = loadInstructionFiles(cwd, config)
  if (instructions.length > 0) {
    ok(`${instructions.length} instruction file${instructions.length === 1 ? '' : 's'} loaded`)
    for (const file of instructions) info(file.path)
  } else {
    info('No instruction files. A JEAN.md or AGENTS.md in the project root is loaded automatically.')
  }
  info(`Config formats read on first run: ${supportedFormats().join(', ')}`)
  line()

  // 5. Memory.
  line(color.bold('Memory'))
  try {
    const { backend, warning } = openMemory(config)
    if (warning) warn(warning)
    else ok(`${backend.name} backend, ${backend.count()} memories stored`)
    backend.close()
  } catch (err) {
    bad(`Memory unavailable: ${err instanceof Error ? err.message : String(err)}`)
  }
  line()

  // 6. The Rust core. Everything has a TypeScript fallback, so a missing
  // build is a warning rather than a failure — but a build that answers with
  // fewer methods than this code calls is a problem, since those features are
  // silently running their fallback.
  line(color.bold('Rust core'))
  const native = await nativeStatus()
  if (native.disabled) warn('Disabled by JEAN_NATIVE=0: every feature runs its TypeScript fallback.')
  else if (!native.binary) {
    warn('Not built: search, edits, shell parsing, isolation, and memory run their slower fallbacks.')
    info('Build it with `jean native build` (needs cargo).')
  } else if (!native.available) bad(`${native.binary} did not answer a ping.`)
  else if (native.missing.length > 0) {
    bad(`The build is out of date: it does not answer ${native.missing.join(', ')}.`)
    info('Rebuild with `jean native build`.')
  } else {
    ok(`pi-natives ${native.version ?? ''}: ${native.methods.length} methods, ${CRATE_ROLES.length} crates wired`)
    info(native.binary)
    if (native.stale) warn('The Rust sources are newer than this build. `jean native build` picks the changes up.')
  }
  line()

  // 7. Language servers and debuggers — what the lsp_* and debug_* tools,
  // and the diagnostics after every edit, can use in this project.
  line(color.bold('Language tools'))
  const languages = native.available ? await languageToolsSummary(config, cwd).catch(() => undefined) : undefined
  if (!languages) {
    warn('The language-server and debugger engines need the Rust core; only the basic LSP tools work without it.')
  } else {
    ok(`Language servers: ${languages.servers}`)
    ok(`Debug adapters: ${languages.debuggers}`)
    info(`Installed into ${languages.toolsDir}. \`jean lsp\` and \`jean debug\` list them.`)
    if (!languages.autoInstall) warn('Automatic installs are off (languageTools.autoInstall or JEAN_DISABLE_LSP_DOWNLOAD).')
  }
  line()

  // 8. Storage.
  line(color.bold('Storage'))
  ok(`Home: ${jeanHome()}`)
  ok('Telemetry: off — Jean Code sends nothing anywhere except to the model provider you configured.')
  line()

  if (problems === 0) {
    line(color.green(`${symbols.check} No problems found.`))
  } else {
    line(color.red(`${symbols.cross} ${problems} problem${problems === 1 ? '' : 's'} found.`))
  }
  line()

  return problems === 0 ? 0 : 1
}
