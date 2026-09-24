import { homedir } from 'node:os'
import { join } from 'node:path'
import type { JeanConfig } from './types.ts'

/**
 * `~/.jean` — global config, sessions, memory database.
 *
 * Takes the environment as a parameter rather than reading `process.env`
 * directly: `loadConfig` accepts an environment override, and a home directory
 * that ignored it would quietly pull in the real machine's config.
 */
export function jeanHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.JEAN_HOME ?? join(homedir(), '.jean')
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(jeanHome(env), 'config.json')
}

/**
 * Baseline configuration.
 *
 * The default model is deliberately an OpenRouter id: it is the one provider
 * that reaches every other one with a single key, which keeps first-run setup
 * to `export OPENROUTER_API_KEY=...`. Any role can be repointed at a direct
 * provider in `~/.jean/config.json`.
 */
export function defaultConfig(): JeanConfig {
  return {
    mode: 'autonomous',
    ui: { theme: 'acid', banner: true },
    model: {
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-5',
    },
    // Output budgets are ceilings, not spend: a model is billed for what it
    // writes, not what it was allowed to. Too low a ceiling is the expensive
    // mistake — a large file write is cut off mid-call and has to be redone.
    agents: {
      default: { maxTokens: 32_000, temperature: 0 },
      smol: { model: 'anthropic/claude-haiku-4.5', maxTokens: 8192 },
      slow: { model: 'anthropic/claude-opus-5.5', maxTokens: 32_000 },
      plan: { maxTokens: 16_384 },
      commit: { model: 'anthropic/claude-haiku-4.5', maxTokens: 1024 },
      vision: { model: 'anthropic/claude-sonnet-5', maxTokens: 8192 },
      designer: { maxTokens: 32_000 },
      task: { model: 'anthropic/claude-haiku-4.5', maxTokens: 8192 },
      advisor: { model: 'anthropic/claude-opus-5.5', maxTokens: 4096 },
      tiny: { model: 'anthropic/claude-haiku-4.5', maxTokens: 1024 },
    },
    providers: {},
    permissionMode: 'auto',
    autoCompact: true,
    compactThreshold: 0.95,
    // Long enough for real multi-step work: a debugging session or a feature
    // across a dozen files routinely takes a hundred tool turns. Repeat
    // detection, not the turn cap, is what stops an agent going in circles.
    maxTurns: 200,
    effort: 'normal',
    shell: { timeoutMs: 120_000 },
    lsp: {},
    mcpServers: {},
    memory: {
      backend: 'native',
      path: join(jeanHome(), 'memory.db'),
      recallLimit: 12,
    },
    execution: {
      backend: 'local',
      docker: {
        image: 'node:20-slim',
        security: {
          readOnlyRoot: true,
          dropCapabilities: true,
          pidLimit: 100,
          network: true,
        },
      },
    },
    advisor: { enabled: false, escalateAt: 'blocker' },
    teams: { teammateMode: 'auto', maxTeammates: 5 },
    instructionFiles: ['JEAN.md', 'AGENTS.md', 'CLAUDE.md'],
    // Destructive shapes that always stop for confirmation, even in `auto`.
    confirmPatterns: [
      'rm -rf',
      'rm -fr',
      'git reset --hard',
      'git clean -fd',
      'git push --force',
      'git push -f',
      'DROP TABLE',
      'DROP DATABASE',
      'TRUNCATE',
      'mkfs',
      'dd if=',
      'chmod -R 777',
      'shutdown',
      'reboot',
    ],
    // Never run, in any mode. These have no legitimate agent use.
    denyPatterns: [
      'rm -rf /',
      'rm -rf ~',
      'rm -rf /*',
      ':(){ :|:& };:',
      'mkfs.',
      '> /dev/sda',
      'chmod -R 000 /',
    ],
    telemetry: false,
    debug: false,
  }
}
