import { createServer, type IncomingMessage as HttpRequest, type Server } from 'node:http'

/**
 * The HTTP endpoint the push-only platforms deliver to.
 *
 * WhatsApp and Twilio have no long polling: they POST each message to a URL
 * the user gives them. That URL has to reach this machine — through a tunnel
 * such as `cloudflared` or `ngrok`, or a reverse proxy — and it is public,
 * which is why every adapter that uses it verifies the platform's signature
 * before believing a single field of the request.
 *
 * Adapters on the same port share one server, each at its own path.
 */

export interface WebhookRequest {
  method: string
  /** Path and query, as the server saw them. */
  url: string
  headers: Record<string, string>
  body: string
}

export interface WebhookResponse {
  status: number
  body?: string
  contentType?: string
}

type Handler = (request: WebhookRequest) => Promise<WebhookResponse> | WebhookResponse

interface Listening {
  server: Server
  routes: Map<string, Handler>
  ready: Promise<void>
}

const servers = new Map<number, Listening>()

/** The largest request body read; platform payloads are a few kilobytes. */
const MAX_BODY = 1024 * 1024

function read(request: HttpRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/**
 * Serves `handler` at `path` on `port` (0 picks a free one). Resolves with
 * the port and a function that stops serving the path — and the server, when
 * it was the last route on it.
 */
export async function listen(port: number, path: string, handler: Handler): Promise<{ port: number; stop: () => Promise<void> }> {
  let listening = port === 0 ? undefined : servers.get(port)
  if (!listening) {
    const routes = new Map<string, Handler>()
    const server = createServer(async (request, response) => {
      const url = request.url ?? '/'
      const route = routes.get(url.split('?')[0] ?? '/')
      if (!route) {
        response.writeHead(404).end()
        return
      }
      try {
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(request.headers)) {
          if (value !== undefined) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
        }
        const reply = await route({ method: request.method ?? 'GET', url, headers, body: await read(request) })
        response.writeHead(reply.status, { 'content-type': reply.contentType ?? 'text/plain; charset=utf-8' }).end(reply.body ?? '')
      } catch {
        response.writeHead(500).end()
      }
    })
    const ready = new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, () => resolve())
    })
    listening = { server, routes, ready }
    await ready
    const actual = (server.address() as { port: number }).port
    servers.set(actual, listening)
    port = actual
  } else {
    await listening.ready
  }
  if (listening.routes.has(path)) throw new Error(`${path} on port ${port} is already served`)
  listening.routes.set(path, handler)
  const owner = listening
  const bound = port
  return {
    port: bound,
    stop: async () => {
      owner.routes.delete(path)
      if (owner.routes.size === 0) {
        servers.delete(bound)
        await new Promise<void>((resolve) => owner.server.close(() => resolve()))
      }
    },
  }
}
