import { ProviderError } from '../types.ts'

/**
 * Shared HTTP plumbing for provider adapters: retries with jittered backoff,
 * SSE parsing, and error classification.
 *
 * Every provider in this package speaks its wire protocol over `fetch`. There
 * are no vendor SDKs, which keeps the runtime dependency-free and means adding
 * a provider is one small file rather than a new package.
 */

export interface HttpOptions {
  headers?: Record<string, string>
  signal?: AbortSignal
  maxRetries?: number
  /** Provider name, used in error messages. */
  provider: string
}

const DEFAULT_MAX_RETRIES = 2

/** Status codes worth retrying: rate limits and transient server failures. */
function isRetryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

/**
 * POSTs JSON and returns the parsed response, retrying transient failures.
 *
 * Honours `Retry-After` when the provider sends it; otherwise backs off
 * exponentially with jitter so parallel sub-agents do not resynchronize into a
 * thundering herd after a shared 429.
 */
export async function postJson<T>(
  url: string,
  body: unknown,
  options: HttpOptions,
): Promise<T> {
  const response = await request(url, body, options, false)
  return (await response.json()) as T
}

/** POSTs JSON and returns the raw streaming response. */
export async function postStream(
  url: string,
  body: unknown,
  options: HttpOptions,
): Promise<Response> {
  return request(url, body, options, true)
}

async function request(
  url: string,
  body: unknown,
  options: HttpOptions,
  stream: boolean,
): Promise<Response> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  let lastError: ProviderError | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options.signal?.aborted) {
      throw new ProviderError('request aborted', options.provider, undefined, false)
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: stream ? 'text/event-stream' : 'application/json',
          ...options.headers,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      })
    } catch (err) {
      // Network-level failure: DNS, TLS, connection reset, or an abort.
      if (options.signal?.aborted) {
        throw new ProviderError('request aborted', options.provider, undefined, false)
      }
      lastError = new ProviderError(
        `network error contacting ${options.provider}: ${err instanceof Error ? err.message : String(err)}`,
        options.provider,
        undefined,
        true,
      )
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt))
        continue
      }
      throw lastError
    }

    if (response.ok) return response

    const text = await response.text().catch(() => '')
    const retryable = isRetryable(response.status)
    lastError = new ProviderError(
      describeFailure(options.provider, response.status, text),
      options.provider,
      response.status,
      retryable,
    )

    if (!retryable || attempt === maxRetries) throw lastError

    const retryAfter = response.headers.get('retry-after')
    const waitMs = retryAfter ? parseRetryAfter(retryAfter) : backoffMs(attempt)
    await sleep(waitMs)
  }

  throw lastError ?? new ProviderError('request failed', options.provider)
}

/**
 * Turns a provider's error payload into something a developer can act on.
 * Most providers nest the useful sentence under `error.message`.
 */
function describeFailure(provider: string, status: number, body: string): string {
  let detail = body.slice(0, 500)
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const error = parsed.error
    if (typeof error === 'string') detail = error
    else if (error && typeof error === 'object' && 'message' in error) {
      detail = String((error as Record<string, unknown>).message)
    } else if (typeof parsed.message === 'string') detail = parsed.message
  } catch {
    // Not JSON; the raw body is the best we have.
  }

  // A 403 is not always a bad key: the key can be valid but barred from this
  // model, plan, or client (a free tier reserved for the provider's own app).
  const hint =
    status === 401
      ? ' — check the API key for this provider'
      : status === 403
        ? ' — the provider refused this request; check the key, and that your plan allows this model from third-party clients'
        : status === 404
        ? ' — check the model id exists on this provider'
        : status === 429
          ? ' — rate limited'
          : ''

  return `${provider} returned ${status}${hint}: ${detail}`
}

function parseRetryAfter(value: string): number {
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 30_000)
  return 1000
}

function backoffMs(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 8000)
  return base + Math.random() * base * 0.25
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Parses a Server-Sent Events body into `data:` payloads.
 *
 * Handles the two things that bite naive implementations: events split across
 * chunk boundaries, and multi-line `data:` fields that must be joined with a
 * newline before parsing.
 */
export async function* parseSSE(response: Response): AsyncGenerator<string, void, void> {
  const body = response.body
  if (!body) return

  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Events are separated by a blank line; \r\n\r\n appears in the wild too.
      let boundary = findBoundary(buffer)
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)

        const data = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')

        if (data) yield data
        boundary = findBoundary(buffer)
      }
    }

    // Some providers close without a trailing blank line.
    const tail = buffer
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}

function findBoundary(buffer: string): { index: number; length: number } | -1 {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return -1
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 }
  return { index: lf, length: 2 }
}

/** Reads `${VAR}`-free key material, trimming stray whitespace from copy/paste. */
export function cleanKey(key: string | undefined): string | undefined {
  const trimmed = key?.trim()
  return trimmed ? trimmed : undefined
}
