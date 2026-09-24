import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * The GitHub REST client (architecture §17.2).
 *
 * Spoken directly over `fetch` rather than shelling out to `gh`. That is not
 * only about dependencies: `gh` is absent on most machines, its output format
 * changes between versions, and parsing a CLI's prose to recover structured
 * data is a source of silent breakage. The API returns JSON that means the same
 * thing everywhere.
 *
 * `gh`'s stored credential is still used when present, because a user who has
 * already authenticated should not have to do it twice.
 */

const run = promisify(execFile)

export interface Repo {
  owner: string
  name: string
}

export interface ClientOptions {
  token?: string
  /** For GitHub Enterprise. */
  baseUrl?: string
  onError?: (message: string) => void
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly documentation?: string,
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

export class GitHubClient {
  private readonly baseUrl: string
  private token?: string
  private readonly options: ClientOptions

  constructor(options: ClientOptions = {}) {
    this.options = options
    this.token = options.token
    this.baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  }

  /**
   * Finds a token: explicit, then environment, then `gh`'s stored credential.
   *
   * Cached after the first success — shelling out to `gh` on every request
   * would add a process spawn to a hot path.
   */
  async resolveToken(): Promise<string | undefined> {
    if (this.token) return this.token

    this.token =
      process.env.GITHUB_TOKEN ??
      process.env.GH_TOKEN ??
      (await ghStoredToken())

    return this.token
  }

  get hasExplicitToken(): boolean {
    return Boolean(this.options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN)
  }

  /**
   * Sends a request.
   *
   * Unauthenticated requests work but are limited to 60 an hour, so a missing
   * token is reported as such rather than as a generic 403 — that distinction
   * is the difference between "add a token" and "something is broken".
   */
  async request<T>(
    path: string,
    init: { method?: string; body?: unknown; accept?: string } = {},
  ): Promise<T> {
    const token = await this.resolveToken()
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`

    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        accept: init.accept ?? 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'jean-code',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    })

    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as {
        message?: string
        documentation_url?: string
      }

      if (response.status === 401 || (response.status === 403 && !token)) {
        throw new GitHubError(
          token
            ? 'GitHub rejected the token. It may be expired or lack the needed scope.'
            : 'GitHub needs authentication. Set GITHUB_TOKEN, or sign in with `gh auth login`.',
          response.status,
        )
      }

      if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
        const reset = response.headers.get('x-ratelimit-reset')
        const when = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : 'shortly'
        throw new GitHubError(`GitHub rate limit exhausted; it resets at ${when}.`, 403)
      }

      throw new GitHubError(
        detail.message ?? `GitHub returned ${response.status}`,
        response.status,
        detail.documentation_url,
      )
    }

    // 204 has no body; parsing it would throw.
    if (response.status === 204) return undefined as T
    if (init.accept?.includes('diff') || init.accept?.includes('raw')) {
      return (await response.text()) as T
    }
    return (await response.json()) as T
  }

  /** Follows pagination up to `limit` items. */
  async paginate<T>(path: string, limit = 100): Promise<T[]> {
    const out: T[] = []
    let url: string | undefined = `${path}${path.includes('?') ? '&' : '?'}per_page=100`

    while (url && out.length < limit) {
      const token = await this.resolveToken()
      const response = await fetch(url.startsWith('http') ? url : `${this.baseUrl}${url}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'jean-code',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      })

      if (!response.ok) break
      const page = (await response.json()) as T[]
      out.push(...page)

      // The `Link` header is the only reliable pagination signal; guessing from
      // page size breaks on the last full page.
      url = parseNextLink(response.headers.get('link'))
    }

    return out.slice(0, limit)
  }
}

/** Reads `gh`'s stored credential, if the CLI is installed and signed in. */
async function ghStoredToken(): Promise<string | undefined> {
  try {
    const { stdout } = await run('gh', ['auth', 'token'], { timeout: 5000 })
    const token = stdout.trim()
    return token || undefined
  } catch {
    return undefined
  }
}

function parseNextLink(header: string | null): string | undefined {
  if (!header) return undefined
  for (const part of header.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim())
    if (match) return match[1]
  }
  return undefined
}

/**
 * Works out the repository from a git remote.
 *
 * Handles both URL forms git uses, because which one a clone has depends on how
 * it was made and neither is unusual.
 */
export async function detectRepo(cwd: string): Promise<Repo | undefined> {
  const remotes = ['origin', 'upstream']

  for (const remote of remotes) {
    try {
      const { stdout } = await run('git', ['remote', 'get-url', remote], { cwd, timeout: 5000 })
      const parsed = parseRemote(stdout.trim())
      if (parsed) return parsed
    } catch {
      continue
    }
  }
  return undefined
}

export function parseRemote(url: string): Repo | undefined {
  // git@github.com:owner/name.git
  const ssh = /^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/.exec(url)
  if (ssh) return { owner: ssh[1]!, name: ssh[2]! }

  // https://github.com/owner/name.git
  const https = /^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url)
  if (https) return { owner: https[1]!, name: https[2]! }

  return undefined
}
