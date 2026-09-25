import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  configFromEnv,
  defaultConfig,
  maskSecret,
  redactSecrets,
  resolvePath,
  expandEnv,
  importForeignConfig,
  loadConfig,
  merge,
  parseDotenv,
  parseJsonc,
  splitModelRef,
  stripJsonComments,
  validate,
} from '../packages/config/src/index.ts'

/* jean-scan-ignore — the fixtures below are synthetic keys for redaction tests. */
const temps: string[] = []

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jean-config-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  while (temps.length > 0) {
    rmSync(temps.pop()!, { recursive: true, force: true })
  }
})

describe('JSONC parsing', () => {
  test('strips line and block comments', () => {
    const text = '{\n  // a comment\n  "a": 1, /* inline */\n  "b": 2\n}'
    expect(parseJsonc(text)).toEqual({ a: 1, b: 2 })
  })

  test('strips trailing commas', () => {
    expect(parseJsonc('{"a": 1, "b": [1, 2,],}')).toEqual({ a: 1, b: [1, 2] })
  })

  test('leaves comment-like text inside strings alone', () => {
    const text = '{"url": "https://example.com/x", "note": "a /* not a comment */ b"}'
    expect(parseJsonc(text)).toEqual({
      url: 'https://example.com/x',
      note: 'a /* not a comment */ b',
    })
  })

  test('does not mangle escaped quotes', () => {
    expect(stripJsonComments('{"a": "he said \\"hi\\" // not a comment"}')).toContain(
      '// not a comment',
    )
  })

  test('reports the file in a syntax error', () => {
    expect(() => parseJsonc('{ bad', 'my.json')).toThrow(/my\.json/)
  })
})

describe('validation', () => {
  test('accepts a valid config', () => {
    const { value, warnings } = validate({ permissionMode: 'ask', maxTurns: 10 })
    expect(value.permissionMode).toBe('ask')
    expect(value.maxTurns).toBe(10)
    expect(warnings).toHaveLength(0)
  })

  test('drops an invalid enum value and says so', () => {
    const { value, warnings } = validate({ permissionMode: 'yolo' })
    expect(value.permissionMode).toBeUndefined()
    expect(warnings[0]).toContain('permissionMode')
  })

  test('drops an out-of-range threshold', () => {
    expect(validate({ compactThreshold: 2 }).warnings[0]).toContain('compactThreshold')
    expect(validate({ compactThreshold: 0.9 }).value.compactThreshold).toBe(0.9)
  })

  test('names an unknown model role rather than ignoring it silently', () => {
    const { warnings } = validate({ agents: { editor: { model: 'x' } } })
    expect(warnings[0]).toContain('agents.editor')
  })

  test('reports unknown top-level settings', () => {
    expect(validate({ nonsense: true }).warnings[0]).toContain('nonsense')
  })

  test('accepts the documented top-level teammate settings', () => {
    // The architecture doc writes these at the top level; the resolved config
    // groups them under `teams`.
    const { value, warnings } = validate({
      teammateMode: 'tmux',
      defaultTeammateModel: 'anthropic/claude-sonnet-4.5',
    })
    expect(value.teams?.teammateMode).toBe('tmux')
    expect(value.teams?.defaultTeammateModel).toBe('anthropic/claude-sonnet-4.5')
    expect(warnings).toHaveLength(0)
  })

  test('never lets telemetry be enabled', () => {
    const { warnings } = validate({ telemetry: true })
    expect(warnings.some((w) => w.includes('telemetry'))).toBe(true)
  })

  test('rejects a non-object config', () => {
    expect(validate([]).warnings[0]).toContain('expected a JSON object')
  })
})

describe('merging', () => {
  test('merges objects key by key', () => {
    expect(merge({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } })
  })

  test('replaces arrays wholesale', () => {
    // A project config must be able to shorten a list, not only append to it.
    expect(merge({ a: [1, 2, 3] }, { a: [9] })).toEqual({ a: [9] })
  })

  test('ignores undefined patches', () => {
    expect(merge({ a: 1 }, undefined)).toEqual({ a: 1 })
  })
})

describe('environment expansion', () => {
  test('expands ${VAR} anywhere in the tree', () => {
    const missing: string[] = []
    const out = expandEnv({ a: { b: '${FOO}' }, c: ['${FOO}'] }, { FOO: 'bar' }, missing)
    expect(out).toEqual({ a: { b: 'bar' }, c: ['bar'] })
    expect(missing).toHaveLength(0)
  })

  test('reports an unset variable rather than leaving the literal', () => {
    const missing: string[] = []
    const out = expandEnv({ key: '${NOPE}' }, {}, missing)
    expect(out).toEqual({ key: '' })
    expect(missing).toEqual(['NOPE'])
  })
})

describe('model references', () => {
  test('splits an explicit provider prefix', () => {
    expect(splitModelRef('anthropic:claude-sonnet-4.5')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4.5',
    })
  })

  test('leaves an OpenRouter vendor path intact', () => {
    // `anthropic/claude-sonnet-4.5` is a model id, not a provider prefix.
    expect(splitModelRef('anthropic/claude-sonnet-4.5')).toEqual({
      modelId: 'anthropic/claude-sonnet-4.5',
    })
  })

  test('handles a provider prefix in front of a vendor path', () => {
    expect(splitModelRef('openrouter:anthropic/claude-sonnet-4.5')).toEqual({
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4.5',
    })
  })
})

describe('dotenv parsing', () => {
  test('handles quotes, exports, and comments', () => {
    const parsed = parseDotenv(
      ['# comment', 'export A=1', 'B="two words"', "C='single'", 'D=bare # trailing', ''].join('\n'),
    )
    expect(parsed).toEqual({ A: '1', B: 'two words', C: 'single', D: 'bare' })
  })
})

describe('environment config', () => {
  test('maps JEAN_* variables', () => {
    const { config } = configFromEnv({
      JEAN_PERMISSION_MODE: 'plan',
      JEAN_EFFORT: 'high',
      JEAN_DEBUG: '1',
    } as NodeJS.ProcessEnv)
    expect(config.permissionMode).toBe('plan')
    expect(config.effort).toBe('high')
    expect(config.debug).toBe(true)
  })

  test('warns about an invalid value instead of applying it', () => {
    const { config, warnings } = configFromEnv({ JEAN_EFFORT: 'turbo' } as NodeJS.ProcessEnv)
    expect(config.effort).toBeUndefined()
    expect(warnings[0]).toContain('JEAN_EFFORT')
  })
})

describe('importing other agents’ config', () => {
  test('finds Claude Code and Cursor rules and MCP servers', () => {
    const dir = workspace()
    mkdirSync(join(dir, '.claude'), { recursive: true })
    mkdirSync(join(dir, '.cursor'), { recursive: true })
    writeFileSync(join(dir, 'CLAUDE.md'), '# project rules\n')
    writeFileSync(join(dir, '.cursorrules'), 'cursor rules\n')
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'server'] } } }),
    )

    const imported = importForeignConfig(dir)
    expect(imported.sources).toContain('Claude Code')
    expect(imported.sources).toContain('Cursor')
    expect(imported.instructionFiles.some((f) => f.endsWith('CLAUDE.md'))).toBe(true)
    expect(imported.config.mcpServers?.fs).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
    })
  })

  test('reads a Cursor rules directory', () => {
    const dir = workspace()
    mkdirSync(join(dir, '.cursor', 'rules'), { recursive: true })
    writeFileSync(join(dir, '.cursor', 'rules', 'style.mdc'), 'be consistent\n')

    const imported = importForeignConfig(dir)
    expect(imported.instructionFiles.some((f) => f.endsWith('style.mdc'))).toBe(true)
  })

  test('ignores an MCP entry with neither a command nor a URL', () => {
    const dir = workspace()
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { broken: {} } }))
    expect(importForeignConfig(dir).config.mcpServers).toBeUndefined()
  })

  test('survives an unparseable foreign config', () => {
    const dir = workspace()
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.mcp.json'), 'not json at all')
    expect(() => importForeignConfig(dir)).not.toThrow()
  })

  test('finds nothing in an empty directory', () => {
    expect(importForeignConfig(workspace()).sources).toHaveLength(0)
  })
})

describe('model as a string', () => {
  test('`model` as "provider:model" is read as the model, not dropped', () => {
    const { value, warnings } = validate({ model: 'openrouter:minimax/minimax-m3:free' })
    expect(value.model).toEqual({ provider: 'openrouter', modelId: 'minimax/minimax-m3:free' })
    expect(warnings).toHaveLength(0)
  })

  test('`model` as a bare id keeps the configured provider', () => {
    expect(validate({ model: 'claude-sonnet-5' }).value.model).toEqual({ modelId: 'claude-sonnet-5' })
  })

  test('`model` of the wrong type is still refused', () => {
    const { value, warnings } = validate({ model: 42 })
    expect(value.model).toBeUndefined()
    expect(warnings[0]).toContain('model')
  })

  test('what `jean config set model …` writes loads back as that model', () => {
    const dir = workspace()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ model: 'groq:llama-4-scout' }))
    const { config, warnings } = loadConfig({ cwd: dir, skipImport: true, env: { JEAN_HOME: dir } })
    expect(warnings.filter((w) => w.includes('model'))).toEqual([])
    expect(config.model.provider).toBe('groq')
    expect(config.model.modelId).toBe('llama-4-scout')
  })
})

describe('loading', () => {
  test('project config overrides the defaults', () => {
    const dir = workspace()
    writeFileSync(join(dir, '.jean.json'), JSON.stringify({ permissionMode: 'ask', maxTurns: 3 }))

    const { config } = loadConfig({ cwd: dir, skipImport: true, env: { JEAN_HOME: dir } })
    expect(config.permissionMode).toBe('ask')
    expect(config.maxTurns).toBe(3)
    // Untouched settings keep their defaults.
    expect(config.autoCompact).toBe(defaultConfig().autoCompact)
  })

  test('flags override the project config', () => {
    const dir = workspace()
    writeFileSync(join(dir, '.jean.json'), JSON.stringify({ permissionMode: 'ask' }))

    const { config } = loadConfig({
      cwd: dir,
      skipImport: true,
      env: { JEAN_HOME: dir },
      flags: { permissionMode: 'plan' },
    })
    expect(config.permissionMode).toBe('plan')
  })

  test('reports which sources contributed', () => {
    const dir = workspace()
    writeFileSync(join(dir, '.jean.json'), '{}')
    const { sources } = loadConfig({ cwd: dir, skipImport: true, env: { JEAN_HOME: dir } })
    expect(sources.map((s) => s.kind)).toContain('project')
  })

  test('reads .env without letting it shadow an exported variable', () => {
    const dir = workspace()
    writeFileSync(join(dir, '.env'), 'OPENROUTER_API_KEY=from-dotenv\n')

    const fromDotenv = loadConfig({ cwd: dir, skipImport: true, env: { JEAN_HOME: dir } })
    expect(fromDotenv.config.model.apiKey).toBe('from-dotenv')

    const exported = loadConfig({
      cwd: dir,
      skipImport: true,
      env: { OPENROUTER_API_KEY: 'exported', JEAN_HOME: dir },
    })
    expect(exported.config.model.apiKey).toBe('exported')
  })

  test('every role resolves to a runnable model', () => {
    const dir = workspace()
    const { config } = loadConfig({ cwd: dir, skipImport: true, env: { JEAN_HOME: dir } })
    for (const [role, agent] of Object.entries(config.agents)) {
      expect(agent.model, `role ${role} has no model`).toBeTruthy()
    }
  })

  test('a broken config file warns instead of throwing', () => {
    const dir = workspace()
    writeFileSync(join(dir, '.jean.json'), '{ this is not json')
    const { config, warnings } = loadConfig({ cwd: dir, skipImport: true, env: { JEAN_HOME: dir } })
    expect(warnings.length).toBeGreaterThan(0)
    expect(config.permissionMode).toBe('auto')
  })

  test('an explicit --config suppresses the project file', () => {
    const dir = workspace()
    // A stray .jean.json must not silently win over a config the user named:
    // pinning a configuration for a test or CI run is what the flag is for.
    writeFileSync(join(dir, '.jean.json'), JSON.stringify({ permissionMode: 'full' }))
    writeFileSync(join(dir, 'pinned.json'), JSON.stringify({ permissionMode: 'ask' }))

    const { config, sources } = loadConfig({
      cwd: dir,
      configPath: 'pinned.json',
      skipImport: true,
      env: { JEAN_HOME: dir },
    })
    expect(config.permissionMode).toBe('ask')
    expect(sources.map((s) => s.kind)).not.toContain('project')
  })

  test('warns when --config names a file that is not there', () => {
    const dir = workspace()
    const { warnings } = loadConfig({
      cwd: dir,
      configPath: 'missing.json',
      skipImport: true,
      env: { JEAN_HOME: dir },
    })
    expect(warnings.some((w) => w.includes('missing.json'))).toBe(true)
  })

  test('telemetry is always false', () => {
    const dir = workspace()
    writeFileSync(join(dir, '.jean.json'), JSON.stringify({ telemetry: true }))
    expect(loadConfig({ cwd: dir, skipImport: true, env: { JEAN_HOME: dir } }).config.telemetry).toBe(false)
  })
})

describe('secret redaction', () => {
  test('masks a key while leaving it identifiable', () => {
    expect(maskSecret('sk-or-v1-abcdefghijklmnop1234')).toBe('sk-or-v1...1234')
    // Too short to mask safely: reveal nothing.
    expect(maskSecret('short')).toBe('***')
  })

  test('redacts secrets anywhere in the config tree', () => {
    const redacted = redactSecrets({
      model: { provider: 'openrouter', apiKey: 'sk-or-v1-supersecretvalue123' },
      providers: { anthropic: { apiKey: 'sk-ant-anothersecretvalue' } },
      list: [{ token: 'tok-abcdefghijklmnop' }],
      modelId: 'anthropic/claude-sonnet-4.5',
    })
    expect(JSON.stringify(redacted)).not.toContain('supersecret')
    expect(JSON.stringify(redacted)).not.toContain('anothersecret')
    expect(JSON.stringify(redacted)).not.toContain('abcdefghijklmnop')
    // Non-secret values are untouched.
    expect(redacted.modelId).toBe('anthropic/claude-sonnet-4.5')
    expect(redacted.model.provider).toBe('openrouter')
  })

  test('leaves a config with no secrets unchanged', () => {
    const input = { a: 1, b: 'two', c: { d: [1, 2] } }
    expect(redactSecrets(input)).toEqual(input)
  })
})

describe('path resolution', () => {
  test('expands a leading ~ to the home directory', () => {
    const resolved = resolvePath('~/.jean/memory.db')
    // The literal tilde must not survive: using it as a path creates a
    // directory actually named "~" wherever the process happens to be.
    expect(resolved.startsWith('~')).toBe(false)
    expect(resolved).toContain('.jean')
    expect(isAbsolute(resolved)).toBe(true)
  })

  test('leaves an absolute path alone and resolves a relative one', () => {
    // Built with `join` rather than a literal, so the test carries no
    // platform-specific separators of its own.
    const absolute = join(tmpdir(), 'jean-resolve-check.db')
    expect(resolvePath(absolute)).toBe(absolute)
    expect(isAbsolute(resolvePath('data/x.db', process.cwd()))).toBe(true)
  })
})
