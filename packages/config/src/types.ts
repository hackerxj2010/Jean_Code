/**
 * Configuration shapes for Jean Code.
 *
 * These mirror `~/.jean/config.json` (global) and `.jean.json` (project-local)
 * as specified in the architecture doc §24. Every field is optional at the file
 * level and filled from defaults at load time, so a config file can be as small
 * as `{}`.
 */

/** The ten model roles agents address instead of naming a model directly. */
export const MODEL_ROLES = [
  'default',
  'smol',
  'slow',
  'plan',
  'commit',
  'vision',
  'designer',
  'task',
  'advisor',
  'tiny',
] as const

export type ModelRole = (typeof MODEL_ROLES)[number]

/**
 * Operating modes (architecture §4).
 *
 * Two, not three. The earlier `focus`/`autonomous`/`swarm` split had
 * `autonomous` run a fixed plan-execute-verify pipeline through specialized
 * agents, which cost a full context load per stage to do what the main agent
 * was already capable of. `autonomous` is now the single-agent mode that
 * delegates when delegating actually saves context, and `swarm` is the one
 * that runs a team.
 */
export type Mode = 'autonomous' | 'swarm'

/**
 * Permission gating.
 * - `auto`   — act freely, confirm only destructive operations (default)
 * - `ask`    — confirm every write and every command
 * - `plan`   — read-only; no writes, no commands
 * - `full`   — no confirmations at all
 */
export type PermissionMode = 'auto' | 'ask' | 'plan' | 'full'

/** Reasoning depth requested from models that support it. */
export type Effort = 'fast' | 'normal' | 'high' | 'xhigh'

export type ExecutionBackend =
  | 'local'
  | 'docker'
  | 'ssh'
  | 'daytona'
  | 'modal'
  | 'singularity'

export interface AgentModelConfig {
  /** Model id, optionally `provider:model`. */
  model?: string
  maxTokens?: number
  temperature?: number
  /** Models tried in order if the primary fails. At most 3 are used. */
  fallbacks?: string[]
  effort?: Effort
}

export interface LspServerConfig {
  disabled?: boolean
  /** The binary, or the whole command line as an array. */
  command?: string | string[]
  args?: string[]
  /** File extensions this server handles, e.g. `['.ts', '.tsx']`. */
  extensions?: string[]
  /** Whole file names it handles, e.g. `['Dockerfile']`. */
  filenames?: string[]
  /** Files that mark a project root for it, e.g. `['package.json']`; `*.csproj` matches by suffix. */
  rootMarkers?: string[]
  env?: Record<string, string>
  /** Sent as `initializationOptions`, merged over the built-in ones. */
  initialization?: Record<string, unknown>
  /** Answered to `workspace/configuration`, merged over the built-in ones. */
  settings?: Record<string, unknown>
  /** Higher wins among servers of the same role. */
  priority?: number
  /** `linter` runs alongside the primary server and contributes diagnostics. */
  role?: 'primary' | 'linter'
  languageId?: string
}

/** A debug adapter in the `debuggers` section: an override, or a new one. */
export interface DebuggerConfig {
  disabled?: boolean
  command?: string | string[]
  args?: string[]
  /** `tcp` when the adapter listens on `{port}` in its command. */
  transport?: 'stdio' | 'tcp'
  extensions?: string[]
  /** The launch configuration every launch starts from. */
  defaults?: Record<string, unknown>
  childSessions?: boolean
}

export interface McpServerConfig {
  /** `http` is Streamable HTTP; `sse` the older transport. Omitted: inferred. */
  type?: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  /** Sent with every request to a remote server; `${VAR}` reads the environment. */
  headers?: Record<string, string>
  /** Only expose these tools to the agent. */
  allow?: string[]
  /** Never expose these tools, even if the server offers them. */
  deny?: string[]
}

export interface ShellConfig {
  path?: string
  args?: string[]
  /**
   * `system` runs commands in the system shell (bash, Git Bash), falling back
   * to the embedded `pi-shell` only when none can be started. `native` always
   * uses the embedded shell: the same behaviour on every platform, and no
   * dependency on Git Bash on Windows.
   */
  backend?: 'system' | 'native'
  /** Per-command wall clock cap in milliseconds. */
  timeoutMs?: number
}

export interface MemoryConfig {
  /** `native` is the `pi-mnemopi` log; it falls back to `sqlite` without the Rust core. */
  backend?: 'native' | 'sqlite' | 'jsonl' | 'none'
  path?: string
  /** Recall this many memories into the system prompt each session. */
  recallLimit?: number
}

export interface DockerSecurityConfig {
  readOnlyRoot?: boolean
  dropCapabilities?: boolean
  pidLimit?: number
  network?: boolean
}

export interface ExecutionConfig {
  backend?: ExecutionBackend
  docker?: {
    image?: string
    security?: DockerSecurityConfig
  }
  ssh?: { host?: string; user?: string; key?: string }
}

export interface AdvisorConfig {
  /** On by default in autonomous mode, off in focus mode. */
  enabled?: boolean
  model?: string
  /** Escalate to the user at this level or above. */
  escalateAt?: 'note' | 'concern' | 'blocker'
}

export interface TeamsConfig {
  /** `auto` picks in-process vs split panes by terminal capability. */
  teammateMode?: 'auto' | 'in-process' | 'tmux' | 'iterm2'
  defaultTeammateModel?: string
  maxTeammates?: number
}

export interface ProviderConfig {
  /** Overrides the provider's default base URL. */
  baseUrl?: string
  /** Literal key, or `${ENV_VAR}` to read from the environment. */
  apiKey?: string
  headers?: Record<string, string>
  /**
   * The wire format: `chat` (Chat Completions, the default for a provider
   * of your own), `responses` (OpenAI Responses), `anthropic`, or `google`.
   */
  api?: 'chat' | 'responses' | 'anthropic' | 'google'
  /** Display name, for a provider of your own. */
  name?: string
  /** Env vars holding the key, for a provider of your own. */
  keyEnv?: string[]
  /** Only these model ids are offered in the pickers. */
  whitelist?: string[]
  /** These model ids are never offered in the pickers. */
  blacklist?: string[]
  /**
   * Models of a provider of your own — or extra ones of a known provider —
   * with what the catalog would otherwise say about them.
   */
  models?: Record<string, { name?: string; context?: number; output?: number; api?: 'chat' | 'responses' | 'anthropic' | 'google' }>
}

/** The fully-resolved config the rest of the system reads. */
/** How the interface looks. */
export interface UiConfig {
  /** One of the bundled theme names. */
  theme: string
  /** Show the banner at startup. */
  banner: boolean
}

export interface JeanConfig {
  mode: Mode
  ui: UiConfig
  model: {
    provider: string
    modelId: string
    apiKey?: string
    baseUrl?: string
  }
  /** Per-role model settings. `default` is always present after resolution. */
  agents: Partial<Record<ModelRole, AgentModelConfig>> & {
    default: AgentModelConfig
  }
  providers: Record<string, ProviderConfig>
  permissionMode: PermissionMode
  autoCompact: boolean
  /**
   * Hold the machine awake while the agent works (`pi-sys`), so a long
   * unattended run is not cut off by the laptop going to sleep. Default true.
   */
  keepAwake?: boolean
  compactThreshold: number
  /** Hard cap on agent turns before the loop stops and reports. */
  maxTurns: number
  effort: Effort
  shell: ShellConfig
  lsp: Record<string, LspServerConfig>
  /** Debug adapters: overrides of the bundled ones, or new ones. */
  debuggers?: Record<string, DebuggerConfig>
  /**
   * Language servers and debug adapters Jean installs itself when one is
   * missing. `autoInstall` defaults to true; `JEAN_DISABLE_LSP_DOWNLOAD=1`
   * turns it off regardless.
   */
  languageTools?: { autoInstall?: boolean; dir?: string }
  /**
   * Plugins (`~/.jean/plugins`, `.jean/plugins`) to run, by name — found is
   * not enabled. `hotReload` (default true) reloads one when its files
   * change, so a plugin being written is tried without a restart.
   */
  plugins?: { enabled?: string[]; hotReload?: boolean }
  /**
   * Chat platforms `jean gateway start` connects: `telegram`, `discord`,
   * `slack`, `email`, `matrix`, `signal`, `whatsapp`, `sms` — each keyed by
   * name with that adapter's settings (tokens, and the `allowedAccounts`
   * that may talk to it). Kept as plain objects here; `@jean/gateway`
   * defines their shapes.
   */
  gateway?: Record<string, Record<string, unknown>>
  mcpServers: Record<string, McpServerConfig>
  memory: MemoryConfig
  execution: ExecutionConfig
  advisor: AdvisorConfig
  teams: TeamsConfig
  /** Extra instruction files loaded into the system prompt. */
  instructionFiles: string[]
  /** Commands that always require confirmation, regardless of mode. */
  confirmPatterns: string[]
  /** Commands that are never run, in any mode. */
  denyPatterns: string[]
  /**
   * Hooks and permission rules, in Claude Code's format. Present on the merged
   * config for completeness, but `@jean/hooks` reads them per file, because
   * applying project trust needs to know which file each one came from.
   */
  hooks?: Record<string, unknown>
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] }
  telemetry: false
  debug: boolean
}

/**
 * A config file on disk: every field optional, deep-merged into defaults.
 * `telemetry` is present but pinned to `false` — it can be written, it just
 * cannot be turned on.
 */
export type PartialConfig = DeepPartial<JeanConfig>

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[]
    ? U[]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K]
}

/** Where a resolved setting came from — surfaced by `jean doctor`. */
export interface ConfigSource {
  path: string
  kind: 'defaults' | 'global' | 'project' | 'imported' | 'env' | 'flags'
}

export interface LoadedConfig {
  config: JeanConfig
  sources: ConfigSource[]
  /** Non-fatal problems: unknown keys, unreadable files, bad values. */
  warnings: string[]
  /** A flag, file, or variable named the model; false when it is the default. */
  modelChosen?: boolean
}
