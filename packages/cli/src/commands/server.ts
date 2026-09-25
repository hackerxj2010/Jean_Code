import { createInterface } from 'node:readline/promises'
import type { JeanConfig } from '@jean/config'
import type { LoopEvent, LoopResult } from '@jean/core'
import { Renderer } from '../render.ts'
import { color, errorLine, line, symbols } from '../ui.ts'

/**
 * Jean as a service, and clients that attach to it.
 *
 *   jean serve [http] [--port 4096] [--hostname 127.0.0.1]
 *        sessions over HTTP: several at once, each streamed as server-sent
 *        events, its permission questions sent to whoever is watching
 *   jean serve acp      the Agent Client Protocol on stdio, for editors (Zed…)
 *   jean serve mcp [--allow-writes]   Jean's tools to any MCP client
 *   jean attach [url] [--resume id]   a terminal on a running server
 *   jean -p "…" --attach url          one prompt, run by the server
 *
 * The HTTP server binds to this machine only unless `JEAN_SERVER_PASSWORD`
 * is set, and then asks for it (HTTP Basic, user `JEAN_SERVER_USERNAME`
 * or `jean`) on every request.
 */

type Flags = Record<string, string | boolean | number>

const DEFAULT_PORT = 4096

/** A session the server holds open. */
interface Live {
  id: string
  cwd: string
  orchestrator: import('@jean/agent').Orchestrator
  close: () => void
  busy: boolean
  listeners: Set<(event: ServerEvent) => void>
  permissions: Map<string, (allow: boolean) => void>
}

export type ServerEvent =
  | LoopEvent
  | { type: 'user'; text: string }
  | { type: 'permission'; id: string; tool: string; risk: string; summary: string; detail?: string }
  | { type: 'done'; result: LoopResult }

/** An orchestrator for `cwd`, configured as the CLI would configure it. */
async function openSession(
  cwd: string,
  options: {
    resume?: string
    onEvent?: (event: LoopEvent) => void
    confirm?: (request: { tool: string; risk: string; summary: string; detail?: string }) => Promise<boolean>
  },
) {
  const { loadConfig } = await import('@jean/config')
  const { Orchestrator } = await import('@jean/agent')
  const { EventStore, loadSession, newSessionId } = await import('@jean/core')
  const { chooseModel, defaultStreamRules, ModelClient } = await import('@jean/model')
  const { openMemory } = await import('@jean/memory')

  const loaded = loadConfig({ cwd })
  const config = chooseModel(loaded.config, loaded.modelChosen ?? true).config
  const store = options.resume ? loadSession(options.resume) : new EventStore()
  if (!store) throw new Error(`no session "${options.resume}"`)
  const memory = openMemory(config).backend
  const sessionId = options.resume ?? newSessionId()
  const orchestrator = new Orchestrator({
    config,
    client: new ModelClient({ config, streamRules: defaultStreamRules() }),
    cwd,
    sessionId,
    memory,
    store,
    onEvent: options.onEvent,
    confirm: options.confirm,
  })
  return {
    sessionId,
    orchestrator,
    close: () => {
      orchestrator.persist()
      orchestrator.end('server closed the session')
      memory.close()
    },
  }
}

// ---------------------------------------------------------------------------
// The HTTP server
// ---------------------------------------------------------------------------

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

/** The request handler: exported so tests can drive it without a socket. */
export function createServer(options: { cwd: string; version?: string }) {
  const live = new Map<string, Live>()
  const password = process.env.JEAN_SERVER_PASSWORD
  const username = process.env.JEAN_SERVER_USERNAME ?? 'jean'

  const broadcast = (session: Live, event: ServerEvent) => {
    for (const listener of session.listeners) listener(event)
  }

  const json = (body: unknown, status = 200) => Response.json(body, { status })
  const problem = (status: number, message: string) => json({ error: message }, status)

  async function start(cwd: string, resume?: string, model?: string): Promise<Live> {
    if (resume && live.has(resume)) return live.get(resume)!
    let record!: Live
    const opened = await openSession(cwd, {
      resume,
      onEvent: (event) => broadcast(record, event),
      // A question about a tool goes to whoever is watching the session; with
      // no one watching, or no answer in ten minutes, the answer is no.
      confirm: (request) =>
        new Promise<boolean>((resolve) => {
          if (record.listeners.size === 0) return resolve(false)
          const id = `perm_${Math.random().toString(36).slice(2, 10)}`
          const timer = setTimeout(() => {
            record.permissions.delete(id)
            resolve(false)
          }, 10 * 60_000)
          record.permissions.set(id, (allow) => {
            clearTimeout(timer)
            record.permissions.delete(id)
            resolve(allow)
          })
          broadcast(record, { type: 'permission', id, tool: request.tool, risk: request.risk, summary: request.summary, detail: request.detail })
        }),
    })
    record = {
      id: opened.sessionId,
      cwd,
      orchestrator: opened.orchestrator,
      close: opened.close,
      busy: false,
      listeners: new Set(),
      permissions: new Map(),
    }
    if (model) record.orchestrator.setModel(model)
    live.set(record.id, record)
    return record
  }

  function describe(session: Live) {
    const { provider, modelId } = session.orchestrator.config.model
    const usage = session.orchestrator.store.usage()
    return { id: session.id, cwd: session.cwd, live: true, busy: session.busy, model: `${provider}:${modelId}`, events: session.orchestrator.store.length, usage }
  }

  /** A stream of the session's events for as long as `until` runs, or the client stays. */
  function stream(session: Live, request: Request, until?: () => Promise<void>): Response {
    const encoder = new TextEncoder()
    let listener: ((event: ServerEvent) => void) | undefined
    let ping: ReturnType<typeof setInterval> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const close = () => {
          if (listener) session.listeners.delete(listener)
          if (ping) clearInterval(ping)
          try {
            controller.close()
          } catch {
            // Already closed by the client.
          }
        }
        listener = (event) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
          } catch {
            close()
          }
        }
        session.listeners.add(listener)
        // A comment every few seconds keeps proxies and idle timers from
        // closing a stream while the model is thinking.
        ping = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': ping\n\n'))
          } catch {
            close()
          }
        }, 10_000)
        request.signal.addEventListener('abort', close)
        if (until) void until().finally(close)
      },
      cancel() {
        if (listener) session.listeners.delete(listener)
        if (ping) clearInterval(ping)
      },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } })
  }

  async function handle(request: Request): Promise<Response> {
    if (password) {
      const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      if (request.headers.get('authorization') !== expected) {
        return new Response('unauthorized', { status: 401, headers: { 'www-authenticate': 'Basic realm="jean"' } })
      }
    }
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)
    const method = request.method
    const body = async () =>
      request.headers.get('content-type')?.includes('json') ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {}

    if (method === 'GET' && url.pathname === '/health') return json({ ok: true, name: 'jean', version: options.version ?? '0.1.0', sessions: live.size })

    if (parts[0] === 'providers' && method === 'GET') {
      const { loadConfig } = await import('@jean/config')
      const { connectedProviders } = await import('@jean/model')
      return json(connectedProviders(loadConfig({ cwd: options.cwd }).config.providers))
    }

    if (parts[0] !== 'sessions') return problem(404, 'not found')

    // /sessions
    if (parts.length === 1) {
      if (method === 'GET') {
        const { listSessions } = await import('@jean/core')
        const saved = listSessions(url.searchParams.get('cwd') ?? undefined, 50).map((meta) => ({ ...meta, live: live.has(meta.id) }))
        return json({ live: [...live.values()].map(describe), saved })
      }
      if (method === 'POST') {
        const input = await body()
        try {
          const session = await start(
            typeof input.cwd === 'string' ? input.cwd : options.cwd,
            typeof input.resume === 'string' ? input.resume : undefined,
            typeof input.model === 'string' ? input.model : undefined,
          )
          return json(describe(session), 201)
        } catch (error) {
          return problem(400, error instanceof Error ? error.message : String(error))
        }
      }
      return problem(405, 'method not allowed')
    }

    const session = live.get(parts[1]!)
    if (!session) return problem(404, `no live session "${parts[1]}" — POST /sessions with {"resume": "${parts[1]}"} to open it`)
    const action = parts[2]

    if (!action) {
      if (method === 'GET') return json(describe(session))
      if (method === 'DELETE') {
        session.orchestrator.interrupt()
        session.close()
        live.delete(session.id)
        return json({ closed: session.id })
      }
    }
    if (action === 'messages' && method === 'GET') return json(session.orchestrator.store.all())
    if (action === 'events' && method === 'GET') return stream(session, request)
    if (action === 'abort' && method === 'POST') {
      session.orchestrator.interrupt()
      return json({ aborted: session.busy })
    }
    if (action === 'model' && method === 'POST') {
      const input = await body()
      if (typeof input.model !== 'string') return problem(400, 'expected {"model": "provider:model"}')
      const chosen = session.orchestrator.setModel(input.model)
      return json({ model: `${chosen.provider}:${chosen.modelId}` })
    }
    if (action === 'permissions' && method === 'POST' && parts[3]) {
      const answer = session.permissions.get(parts[3])
      if (!answer) return problem(404, 'no such question, or it was already answered')
      const input = await body()
      answer(input.allow === true)
      return json({ answered: parts[3] })
    }
    if (action === 'prompt' && method === 'POST') {
      const input = await body()
      const text = typeof input.text === 'string' ? input.text.trim() : ''
      if (!text) return problem(400, 'expected {"text": "…"}')
      if (session.busy) return problem(409, 'the session is already working; watch GET …/events, or POST …/abort')
      session.busy = true
      return stream(session, request, async () => {
        broadcast(session, { type: 'user', text })
        let result: LoopResult
        try {
          result = await session.orchestrator.send(text)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          broadcast(session, { type: 'error', message, fatal: true })
          result = { text: '', turns: 0, stopReason: 'error', toolCalls: 0, files: [], error: message }
        } finally {
          session.busy = false
        }
        session.orchestrator.persist()
        broadcast(session, { type: 'done', result })
      })
    }
    return problem(404, 'not found')
  }

  return {
    handle,
    live,
    closeAll() {
      for (const session of live.values()) {
        session.orchestrator.interrupt()
        session.close()
      }
      live.clear()
    },
  }
}

/** `jean serve` */
export async function runServeCommand(positional: string[], cwd: string, flags: Flags): Promise<number> {
  const kind = positional[0] ?? 'http'

  if (kind === 'mcp') return serveMcpOverStdio(cwd, flags['allow-writes'] === true)
  if (kind === 'acp') return serveAcpOverStdio()
  if (kind !== 'http') {
    errorLine(`Unknown server "${kind}". Use http (the default), acp, or mcp.`)
    return 2
  }

  const hostname = typeof flags.hostname === 'string' ? flags.hostname : '127.0.0.1'
  const port = typeof flags.port === 'number' ? flags.port : DEFAULT_PORT
  if (!isLoopback(hostname) && !process.env.JEAN_SERVER_PASSWORD) {
    errorLine(color.red(`${symbols.cross} Serving on ${hostname} lets other machines run commands here. Set JEAN_SERVER_PASSWORD first.`))
    return 1
  }

  const server = createServer({ cwd })
  const bun = Bun.serve({ hostname, port, idleTimeout: 0, fetch: server.handle })
  line(`${symbols.check} Jean is serving on ${color.cyan(`http://${hostname}:${bun.port}`)} ${color.dim(`(${cwd})`)}`)
  line(color.dim(`  jean attach http://${hostname}:${bun.port}   — a terminal on it; Ctrl+C stops the server.`))
  if (process.env.JEAN_SERVER_PASSWORD) line(color.dim(`  Every request needs the password (user ${process.env.JEAN_SERVER_USERNAME ?? 'jean'}).`))

  await new Promise<void>((resolve) => {
    const stop = () => {
      server.closeAll()
      bun.stop(true)
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}

/** `jean serve mcp`: the agent's tools, read-only unless asked otherwise. */
async function serveMcpOverStdio(cwd: string, allowWrites: boolean): Promise<number> {
  const { serveMcp } = await import('@jean/mcp')
  const { createSessionState } = await import('@jean/tools')
  const opened = await openSession(cwd, {})
  const context = { cwd, config: opened.orchestrator.config, session: createSessionState(cwd) }
  const tools = opened.orchestrator.registry.names().flatMap((name) => {
    const tool = opened.orchestrator.registry.get(name)
    if (!tool) return []
    return [
      {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
        risk: tool.risk === 'read' ? ('read' as const) : tool.risk === 'write' ? ('write' as const) : ('execute' as const),
        execute: async (args: Record<string, unknown>) => (await tool.execute(args, context)).output,
      },
    ]
  })
  // stdout is the protocol: everything else goes to stderr.
  const shown = allowWrites ? tools.length : tools.filter((tool) => tool.risk === 'read').length
  errorLine(color.dim(`jean mcp server: ${shown} tools${allowWrites ? '' : ' (read-only; --allow-writes for all)'}`))
  const { stop } = serveMcp({ input: process.stdin, output: process.stdout, tools, allowMutations: allowWrites, onError: (message) => errorLine(message) })
  await new Promise<void>((resolve) => process.stdin.once('end', resolve))
  stop()
  opened.close()
  return 0
}

/** `jean serve acp`: sessions for an editor that speaks the Agent Client Protocol. */
async function serveAcpOverStdio(): Promise<number> {
  const { serve } = await import('@jean/acp')
  const opened: { close: () => void }[] = []
  const { stop } = serve({
    input: process.stdin,
    output: process.stdout,
    name: 'jean-code',
    onError: (message) => errorLine(message),
    createSession: async (cwd) => {
      let sink: ((chunk: string) => void) | undefined
      const session = await openSession(cwd, {
        onEvent: (event) => {
          if (event.type === 'text') sink?.(event.delta)
        },
      })
      opened.push(session)
      return {
        prompt: async (text, onChunk) => {
          sink = onChunk
          try {
            const result = await session.orchestrator.send(text)
            session.orchestrator.persist()
            return result.text
          } finally {
            sink = undefined
          }
        },
        cancel: () => session.orchestrator.interrupt(),
        touchedFiles: () => session.orchestrator.store.touchedFiles(),
      }
    },
  })
  await new Promise<void>((resolve) => process.stdin.once('end', resolve))
  stop()
  for (const session of opened) session.close()
  return 0
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  const password = process.env.JEAN_SERVER_PASSWORD
  if (!password) return {}
  const username = process.env.JEAN_SERVER_USERNAME ?? 'jean'
  return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }
}

async function call(base: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

/** Events of one response stream, parsed. */
export async function* serverEvents(response: Response): AsyncGenerator<ServerEvent> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = frame
        .split('\n')
        .filter((row) => row.startsWith('data:'))
        .map((row) => row.slice(5).trimStart())
        .join('\n')
      if (data) {
        try {
          yield JSON.parse(data) as ServerEvent
        } catch {
          // Not an event.
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}

/** Sends one prompt and renders what comes back; answers permission questions. */
async function runPrompt(
  base: string,
  session: string,
  text: string,
  ask: (question: string) => Promise<string>,
): Promise<LoopResult | undefined> {
  const response = await call(base, `/sessions/${session}/prompt`, { method: 'POST', body: { text } })
  if (!response.ok) {
    errorLine(color.red(`${symbols.cross} ${((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`}`))
    return undefined
  }
  const renderer = new Renderer({ showDiffs: true })
  let result: LoopResult | undefined
  for await (const event of serverEvents(response)) {
    if (event.type === 'user') continue
    if (event.type === 'permission') {
      renderer.finish()
      line(color.yellow(`  ? ${event.tool}: ${event.summary}`))
      if (event.detail) line(color.dim(`    ${event.detail.split('\n').slice(0, 12).join('\n    ')}`))
      const answer = (await ask('    Allow? [y/N] ')).trim().toLowerCase()
      await call(base, `/sessions/${session}/permissions/${event.id}`, { method: 'POST', body: { allow: answer === 'y' || answer === 'yes' } })
      continue
    }
    if (event.type === 'done') {
      result = event.result
      break
    }
    renderer.handle(event)
  }
  renderer.finish()
  return result
}

/** `jean attach` — and `-p … --attach url`, when `prompt` is given. */
export async function runAttachCommand(positional: string[], flags: Flags, prompt?: string): Promise<number> {
  const target = (typeof flags.attach === 'string' ? flags.attach : positional[0]) ?? process.env.JEAN_SERVER_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`
  const base = target.replace(/\/+$/, '')

  const health = await call(base, '/health').catch(() => undefined)
  if (!health?.ok) {
    errorLine(color.red(`${symbols.cross} No Jean server at ${base}${health ? ` (HTTP ${health.status})` : ''}. Start one with \`jean serve\`.`))
    return 1
  }

  const resume = typeof flags.resume === 'string' && flags.resume !== 'true' ? flags.resume : undefined
  const opened = await call(base, '/sessions', {
    method: 'POST',
    body: { cwd: process.cwd(), resume, model: typeof flags.model === 'string' ? flags.model : undefined },
  })
  const session = (await opened.json()) as { id?: string; model?: string; error?: string }
  if (!opened.ok || !session.id) {
    errorLine(color.red(`${symbols.cross} ${session.error ?? `HTTP ${opened.status}`}`))
    return 1
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
  try {
    if (prompt) {
      const result = await runPrompt(base, session.id, prompt, (question) => rl.question(question))
      return result && result.stopReason !== 'error' ? 0 : 1
    }

    line(`${symbols.check} Attached to ${color.cyan(session.id)} on ${base} ${color.dim(`(${session.model})`)}`)
    line(color.dim('  /model provider:model · /abort · /exit — the session stays on the server; `jean attach --resume <id>` rejoins it.'))
    for (;;) {
      let input: string
      try {
        input = (await rl.question(color.cyan('› '))).trim()
      } catch {
        break
      }
      if (!input) continue
      if (input === '/exit' || input === '/quit') break
      if (input === '/abort') {
        await call(base, `/sessions/${session.id}/abort`, { method: 'POST' })
        continue
      }
      if (input.startsWith('/model ')) {
        const changed = await call(base, `/sessions/${session.id}/model`, { method: 'POST', body: { model: input.slice(7).trim() } })
        const answer = (await changed.json()) as { model?: string; error?: string }
        line(answer.model ? `${symbols.check} Model: ${color.cyan(answer.model)}` : color.red(answer.error ?? 'failed'))
        continue
      }
      await runPrompt(base, session.id, input, (question) => rl.question(question))
    }
    return 0
  } finally {
    rl.close()
  }
}
