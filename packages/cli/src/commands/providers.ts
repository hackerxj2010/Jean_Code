import { maskSecret, readAuth, removeKey, saveKey, savedKey, type JeanConfig } from '@jean/config'
import {
  catalogAge,
  hasCredentials,
  listProviders,
  liveCatalog,
  modelsOf,
  providerEntry,
  providerLabel,
  refreshCatalog,
  type ModelInfo,
  type ProviderEntry,
} from '@jean/model'
import { color, errorLine, line, symbols } from '../ui.ts'

/**
 * `jean models`, `jean providers`, and `jean auth` — choosing where the
 * models come from.
 *
 *   jean providers [--all]             the providers, and which have a key
 *   jean models [provider] [text]      their models: context, price, abilities
 *        --all   every provider's       --free   only the free ones
 *        --refresh   fetch the catalog now
 *   jean auth login [provider]         save a key (asked for, never echoed)
 *   jean auth list                     saved keys and keys from the environment
 *   jean auth logout <provider>        forget a saved key
 */

type Flags = Record<string, string | boolean | number>

function window(tokens: number): string {
  return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1000)}K`
}

function price(model: ModelInfo): string {
  if (model.free) return 'free'
  if (model.inputCost === undefined) return ''
  return `$${model.inputCost}/$${model.outputCost}`
}

function abilities(model: ModelInfo): string {
  return [
    model.supportsThinking ? 'reasoning' : '',
    model.supportsVision ? 'vision' : '',
    model.supportsTools ? '' : 'no-tools',
    model.status ?? '',
  ]
    .filter(Boolean)
    .join(' ')
}

function catalogLine(): string {
  const age = catalogAge()
  if (age === undefined) return 'Catalog: the bundled one (run `jean models --refresh` for every provider models.dev lists).'
  const hours = Math.round(age / 3_600_000)
  const providers = Object.keys(liveCatalog()?.providers ?? {}).length
  return `Catalog: models.dev, ${providers} providers, fetched ${hours < 1 ? 'less than an hour' : `${hours}h`} ago.`
}

async function refresh(flags: Flags): Promise<boolean> {
  if (flags.refresh !== true) return true
  try {
    const catalog = await refreshCatalog()
    line(color.dim(`  Fetched ${Object.keys(catalog.providers).length} providers from ${catalog.source}.`))
    return true
  } catch (error) {
    errorLine(color.red(`${symbols.cross} Could not fetch the catalog: ${error instanceof Error ? error.message : String(error)}`))
    return false
  }
}

/** `jean providers` */
export async function runProvidersCommand(config: JeanConfig, flags: Flags): Promise<number> {
  if (!(await refresh(flags))) return 1
  const all = listProviders(config.providers)
  const shown =
    flags.all === true
      ? all
      : all.filter((entry) => entry.builtin || entry.custom || (!entry.local && hasCredentials(entry.id, config.providers)))

  line()
  for (const entry of shown) {
    const ready = hasCredentials(entry.id, config.providers)
    const dot = entry.api === undefined ? color.dim('×') : entry.local ? color.cyan('◇') : ready ? color.green('●') : color.dim('○')
    const how = entry.local ? 'local' : entry.keyEnv[0] ?? (entry.custom ? 'custom' : '')
    const source = !ready || entry.local ? '' : config.providers[entry.id]?.apiKey ? 'config' : savedKey(entry.id) ? 'saved' : 'env'
    const models = entry.models > 0 ? `${entry.models} models` : ''
    line(
      `  ${dot} ${color.cyan(entry.id.padEnd(22))} ${entry.label.slice(0, 28).padEnd(28)} ${color.dim(models.padEnd(11))} ${color.dim(how.padEnd(26))} ${source ? color.green(source) : ''}`,
    )
  }
  line()
  if (flags.all !== true) line(color.dim(`  ${all.length - shown.length} more with --all. ● has a key  ○ needs one  ◇ local  × needs its own sign-in`))
  line(color.dim(`  ${catalogLine()}`))
  line(color.dim('  Add a key: jean auth login <provider>. Pick a model: jean models <provider>, or /models in a session.'))
  line()
  return 0
}

/** `jean models` */
export async function runModelsCommand(positional: string[], config: JeanConfig, flags: Flags): Promise<number> {
  if (!(await refresh(flags))) return 1
  const providers = listProviders(config.providers)
  const named = positional[0] ? providers.find((entry) => entry.id === positional[0]) : undefined
  const search = (named ? positional.slice(1) : positional).join(' ').toLowerCase()

  let chosen: ProviderEntry[]
  if (named) chosen = [named]
  else if (flags.all === true) chosen = providers
  else {
    chosen = providers.filter((entry) => !entry.local && hasCredentials(entry.id, config.providers))
    // Nothing connected yet: OpenRouter's list shows what one key reaches.
    if (chosen.length === 0) chosen = providers.filter((entry) => entry.id === 'openrouter')
  }

  let total = 0
  line()
  for (const entry of chosen) {
    const whitelist = config.providers[entry.id]?.whitelist
    const blacklist = config.providers[entry.id]?.blacklist
    const models = modelsOf(entry.id)
      .filter((model) => (flags.free === true ? model.free : true))
      .filter((model) => !whitelist?.length || whitelist.includes(model.id))
      .filter((model) => !blacklist?.includes(model.id))
      .filter((model) => !search || `${model.id} ${model.label}`.toLowerCase().includes(search))
      .sort(
        (a, b) =>
          Number(a.status === 'deprecated') - Number(b.status === 'deprecated') ||
          (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '') ||
          a.id.localeCompare(b.id),
      )
    if (models.length === 0) continue
    total += models.length
    const ready = hasCredentials(entry.id, config.providers)
    line(`${color.bold(entry.label)} ${color.dim(`(${entry.id})`)} ${ready ? color.green('● key') : color.dim('○ no key')}`)
    for (const model of models) {
      const ref = `${entry.id}:${model.id}`
      const detail = flags.verbose === true ? `  ${model.releaseDate ?? ''} ${model.api ?? ''}` : ''
      line(
        `  ${color.cyan(ref.padEnd(46))} ${window(model.contextWindow).padStart(6)}  ${color.dim(price(model).padEnd(14))} ${color.dim(abilities(model))}${color.dim(detail)}`,
      )
    }
    line()
  }
  if (total === 0) line(color.dim(named ? `  No models listed for ${named.id}${search ? ` matching "${search}"` : ''}.` : '  No models match.'))
  line(color.dim(`  ${catalogLine()}`))
  line(color.dim('  Use one: jean -m provider:model, `jean config set model.modelId provider:model`, or /models in a session.'))
  line()
  return 0
}

/**
 * Reads a secret from the terminal without echoing it; from stdin when it
 * is piped (`echo $KEY | jean auth login opencode`).
 */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0]?.trim() ?? ''
  }
  process.stderr.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  return new Promise((resolve, reject) => {
    let value = ''
    const done = (error?: Error) => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write('\n')
      if (error) reject(error)
      else resolve(value.trim())
    }
    const onData = (chunk: string) => {
      // A terminal in bracketed-paste mode wraps pasted text in markers.
      for (const ch of chunk.replace(/\x1b\[20[01]~/g, '')) {
        if (ch === '\r' || ch === '\n') return done()
        if (ch === '\u0003') return done(new Error('cancelled'))
        if (ch === '\u007f' || ch === '\b') {
          if (value) {
            value = value.slice(0, -1)
            process.stderr.write('\b \b')
          }
        } else if (ch >= ' ') {
          value += ch
          process.stderr.write('•')
        }
      }
    }
    stdin.on('data', onData)
  })
}

/**
 * Asks the provider whether it knows the key: its model list, which every
 * OpenAI-compatible API serves and which costs nothing. `undefined` when it
 * could not tell.
 */
async function checkKey(entry: ProviderEntry, key: string): Promise<boolean | undefined> {
  if (!entry.baseUrl || entry.local) return undefined
  const headers: Record<string, string> =
    entry.api === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : entry.api === 'google'
        ? { 'x-goog-api-key': key }
        : { authorization: `Bearer ${key}` }
  try {
    const response = await fetch(`${entry.baseUrl.replace(/\/+$/, '')}/models`, { headers, signal: AbortSignal.timeout(8000) })
    if (response.status === 401 || response.status === 403) return false
    return response.ok ? true : undefined
  } catch {
    return undefined
  }
}

/** `jean auth` */
export async function runAuthCommand(positional: string[], config: JeanConfig): Promise<number> {
  const [action = 'list', name] = positional

  if (action === 'list' || action === 'ls') {
    const saved = readAuth()
    line()
    const ids = Object.keys(saved)
    if (ids.length === 0) line(color.dim('  No saved keys.'))
    for (const id of ids) {
      line(`  ${color.green('●')} ${color.cyan(id.padEnd(22))} ${providerLabel(id).padEnd(26)} ${color.dim(maskSecret(saved[id]!.key))}  ${color.dim(saved[id]!.savedAt.slice(0, 10))}`)
    }
    const fromEnv = listProviders(config.providers).filter(
      (entry) => !entry.local && !saved[entry.id] && entry.keyEnv.some((variable) => process.env[variable]?.trim()),
    )
    if (fromEnv.length > 0) {
      line()
      line(color.dim('  From the environment:'))
      for (const entry of fromEnv) {
        const variable = entry.keyEnv.find((name) => process.env[name]?.trim())!
        line(`  ${color.green('●')} ${color.cyan(entry.id.padEnd(22))} ${entry.label.padEnd(26)} ${color.dim(variable)}`)
      }
    }
    line()
    return 0
  }

  if (action === 'logout' || action === 'remove') {
    if (!name) {
      errorLine('Usage: jean auth logout <provider>')
      return 2
    }
    line(removeKey(name) ? `${symbols.check} Forgot the key for ${providerLabel(name)}.` : color.dim(`No key was saved for ${name}.`))
    return 0
  }

  if (action !== 'login' && action !== 'add') {
    errorLine(`Unknown action "${action}". Use login, list, or logout.`)
    return 2
  }

  if (!name) {
    line()
    line('Which provider? Most used:')
    for (const entry of listProviders(config.providers).filter((item) => item.builtin && !item.local)) {
      line(`  ${color.cyan(entry.id.padEnd(14))} ${entry.label}${entry.doc ? color.dim(`  — keys at ${entry.doc}`) : ''}`)
    }
    line()
    line(color.dim('  jean auth login <provider>   (`jean providers --all` lists every one)'))
    line()
    return 2
  }

  const entry = providerEntry(name, config.providers)
  if (!entry) {
    errorLine(`${symbols.cross} Unknown provider "${name}". \`jean providers --all\` lists them.`)
    return 1
  }
  if (entry.local) {
    line(`${providerLabel(name)} runs locally and needs no key. Start it, then pick one of its models.`)
    return 0
  }
  if (entry.api === undefined) {
    errorLine(`${symbols.cross} ${entry.label} needs its own sign-in, which Jean does not speak yet.`)
    return 1
  }

  if (entry.doc) line(color.dim(`  Keys for ${entry.label} are made at ${entry.doc}`))
  let key: string
  try {
    key = await readSecret(`  ${entry.label} API key: `)
  } catch {
    errorLine(color.dim('  Cancelled.'))
    return 1
  }
  if (!key) {
    errorLine(`${symbols.cross} No key given.`)
    return 1
  }

  const accepted = await checkKey(entry, key)
  if (accepted === false) {
    errorLine(`${symbols.cross} ${entry.label} rejected that key; nothing was saved.`)
    return 1
  }
  const path = saveKey(name, key)
  line(`${symbols.check} ${entry.label} key saved in ${color.dim(path)}${accepted ? color.green(' (checked)') : ''}.`)
  line(color.dim(`  Its models: jean models ${name}`))
  return 0
}
