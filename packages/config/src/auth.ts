import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { jeanHome } from './defaults.ts'

/**
 * Saved provider credentials: `~/.jean/auth.json`.
 *
 * Keys given to `jean auth login` or `/connect` live here rather than in the
 * config file, which people share, commit, and paste into bug reports. The
 * file is readable by its owner only where the system has such a thing.
 *
 * A key is looked for in this order: the config (`providers.<id>.apiKey`),
 * this file, then the provider's environment variables — so an explicit
 * setting always wins, and an exported variable still works with no file.
 */

export interface SavedCredential {
  type: 'api'
  key: string
  /** ISO 8601. */
  savedAt: string
}

export function authPath(): string {
  return process.env.JEAN_AUTH_FILE ?? join(jeanHome(), 'auth.json')
}

/** Every saved credential, by provider id. A missing or broken file is empty. */
export function readAuth(): Record<string, SavedCredential> {
  const path = authPath()
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, SavedCredential>
    const out: Record<string, SavedCredential> = {}
    for (const [provider, entry] of Object.entries(parsed ?? {})) {
      if (entry && typeof entry.key === 'string' && entry.key.trim()) out[provider] = entry
    }
    return out
  } catch {
    return {}
  }
}

/** The saved key for a provider, if there is one. */
export function savedKey(provider: string): string | undefined {
  return readAuth()[provider]?.key.trim() || undefined
}

function write(entries: Record<string, SavedCredential>): string {
  const path = authPath()
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows keeps its own ACLs; the file is under the user's profile.
  }
  return path
}

/** Saves a key, replacing any earlier one for the provider. Returns the file. */
export function saveKey(provider: string, key: string): string {
  const trimmed = key.trim()
  if (!trimmed) throw new Error('the key is empty')
  const entries = readAuth()
  entries[provider] = { type: 'api', key: trimmed, savedAt: new Date().toISOString() }
  return write(entries)
}

/** Forgets a provider's key. False when none was saved. */
export function removeKey(provider: string): boolean {
  const entries = readAuth()
  if (!(provider in entries)) return false
  delete entries[provider]
  write(entries)
  return true
}
