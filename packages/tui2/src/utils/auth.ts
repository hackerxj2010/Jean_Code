/**
 * Credentials.
 *
 * Jean has no account and no login flow. It talks to a provider with an API key
 * the user exported or put in `.env`, and that key *is* the credential. So the
 * questions the interface asks — "are we authenticated", "who is this" — have
 * local answers, and this file gives them.
 *
 * The key never leaves this process and is never rendered: `getAuthTokenDetails`
 * returns a masked form, because the details panel it feeds ends up in
 * screenshots and pasted transcripts.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export interface User {
  id: string
  name: string
  /** Which provider the key reaches. */
  provider: string
}

/**
 * The provider keys checked, in order.
 *
 * OpenRouter first because one key there reaches every model, which is the
 * setup this project recommends.
 */
const KEYS: { env: string; provider: string }[] = [
  { env: 'OPENROUTER_API_KEY', provider: 'openrouter' },
  { env: 'ANTHROPIC_API_KEY', provider: 'anthropic' },
  { env: 'OPENAI_API_KEY', provider: 'openai' },
  { env: 'GOOGLE_API_KEY', provider: 'google' },
  { env: 'GROQ_API_KEY', provider: 'groq' },
  { env: 'DEEPSEEK_API_KEY', provider: 'deepseek' },
  { env: 'MISTRAL_API_KEY', provider: 'mistral' },
  { env: 'XAI_API_KEY', provider: 'xai' },
]

/** The active API key, or null when none is configured. */
export function getAuthToken(): string | null {
  for (const { env } of KEYS) {
    const value = process.env[env]
    if (value !== undefined && value.trim() !== '') return value.trim()
  }
  return null
}

/**
 * Who the session is running as, for the details panel.
 *
 * The key is masked. Enough survives to tell two keys apart — which is the only
 * thing anyone actually needs from seeing it — without putting a working
 * credential on screen.
 */
export function getAuthTokenDetails(): {
  authenticated: boolean
  provider?: string
  masked?: string
  source?: string
} {
  for (const { env, provider } of KEYS) {
    const value = process.env[env]
    if (value === undefined || value.trim() === '') continue

    return {
      authenticated: true,
      provider,
      masked: mask(value.trim()),
      source: env,
    }
  }

  return { authenticated: false }
}

/** Masks a credential, keeping enough to recognise which one it is. */
function mask(value: string): string {
  const length = value.length
  if (length <= 12) return '*'.repeat(length)
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

/** Where Jean keeps its own state. */
export function getConfigDir(): string {
  const override = process.env.JEAN_CONFIG_DIR
  if (override !== undefined && override.trim() !== '') return override

  // XDG on Unix, the roaming profile on Windows — the conventions users'
  // backup and sync tools already understand.
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg !== undefined && xdg.trim() !== '') return join(xdg, 'jean')

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData !== undefined && appData.trim() !== '') return join(appData, 'jean')
  }

  return join(homedir(), '.config', 'jean')
}

/** The current user, derived from the key rather than from a service. */
export function getCurrentUser(): User | null {
  const details = getAuthTokenDetails()
  if (!details.authenticated) return null

  return {
    id: details.masked ?? 'local',
    name: 'local',
    provider: details.provider ?? 'unknown',
  }
}
