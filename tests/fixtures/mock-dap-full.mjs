/**
 * A debug adapter for a made-up line-by-line language, speaking real DAP —
 * over stdio, or over TCP with `--port N` — so every part of `crates/pi-dap`
 * can be driven end to end without installing a real debugger.
 *
 * A program is a text file, executed one line per step:
 *
 *   print TEXT     writes TEXT to stdout
 *   crash          raises an exception
 *   anything else  does nothing
 *
 * It behaves as the real adapters it stands in for do where it matters:
 *
 * - `launch` is answered only after `configurationDone`, as debugpy does, so
 *   a client that waits for it first deadlocks here too.
 * - With `--children`, the first connection is a launcher: it asks the client
 *   to `startDebugging` a child, and the program runs in the child — the way
 *   js-debug runs every Node program.
 * - `console: "integratedTerminal"` makes it ask the client to
 *   `runInTerminal`.
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'

const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : undefined
const children = args.includes('--children')

function connection(write, close) {
  let seq = 1
  let buffer = Buffer.alloc(0)
  const waiting = new Map()

  const send = (message) => {
    const body = Buffer.from(JSON.stringify({ seq: seq++, ...message }), 'utf8')
    write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
  }
  const respond = (request, body, success = true, message) =>
    send({ type: 'response', request_seq: request.seq, success, command: request.command, body, message })
  const event = (name, body) => send({ type: 'event', event: name, body })
  const reverse = (command, argumentsBody) => {
    const id = seq
    send({ type: 'request', command, arguments: argumentsBody })
    return new Promise((resolve) => waiting.set(id, resolve))
  }

  // Program state.
  let config = null
  let pendingLaunch = null
  let lines = []
  let current = 0
  let counter = 0
  const breakpoints = new Map() // line -> {condition, hitCondition, logMessage}
  let exceptionFilters = ['uncaught']
  let finished = false

  const locals = () => ({ line: current, counter })

  const evaluate = (expression) => {
    const scope = locals()
    if (expression === 'data.a') return 1
    if (expression in scope) return scope[expression]
    try {
      return Function(...Object.keys(scope), `return (${expression})`)(...Object.values(scope))
    } catch {
      throw new Error(`name '${expression}' is not defined`)
    }
  }

  const stop = (reason, extra = {}) => event('stopped', { reason, threadId: 1, allThreadsStopped: true, ...extra })

  const finish = (code) => {
    if (finished) return
    finished = true
    event('exited', { exitCode: code })
    event('terminated', {})
  }

  // Runs from the line after `current` until a stop or the end.
  const run = (single) => {
    setTimeout(() => {
      while (current < lines.length) {
        current++
        counter++
        const text = lines[current - 1].trim()
        const bp = breakpoints.get(current)
        if (text.startsWith('print ')) event('output', { category: 'stdout', output: `${text.slice(6)}\n` })
        if (text === 'crash') {
          if (exceptionFilters.length > 0) return stop('exception', { description: 'Exception: crash', text: 'crash' })
          event('output', { category: 'stderr', output: 'Traceback: crash\n' })
          return finish(1)
        }
        if (bp) {
          if (bp.logMessage) {
            event('output', { category: 'console', output: `${bp.logMessage.replace(/\{(\w+)\}/g, (_, name) => String(evaluate(name)))}\n` })
          } else if (!bp.condition || evaluate(bp.condition)) {
            return stop('breakpoint', { hitBreakpointIds: [current] })
          }
        }
        if (single) return stop('step')
      }
      finish(0)
    }, 10)
  }

  const startProgram = async () => {
    lines = readFileSync(config.program, 'utf8').split(/\r?\n/).filter((line, i, all) => i < all.length - 1 || line !== '')
    if (config.console === 'integratedTerminal') {
      await reverse('runInTerminal', { kind: 'integrated', cwd: config.cwd, args: ['node', '-e', "console.log('from terminal')"] })
    }
    if (config.stopOnEntry) {
      current = 1
      counter = 1
      stop('entry')
    } else {
      run(false)
    }
  }

  const handle = async (request) => {
    const a = request.arguments ?? {}
    switch (request.command) {
      case 'initialize':
        respond(request, {
          supportsConfigurationDoneRequest: true,
          supportsConditionalBreakpoints: true,
          supportsHitConditionalBreakpoints: true,
          supportsLogPoints: true,
          supportsSetVariable: true,
          supportsTerminateRequest: true,
          supportsFunctionBreakpoints: true,
          exceptionBreakpointFilters: [
            { filter: 'raised', label: 'Raised Exceptions', default: false },
            { filter: 'uncaught', label: 'Uncaught Exceptions', default: true },
          ],
        })
        return
      case 'launch':
      case 'attach':
        config = a
        if (children && !a.__child) {
          // The launcher: the program runs in a child session.
          respond(request, {})
          event('initialized', {})
          await reverse('startDebugging', { request: 'launch', configuration: { ...a, __child: true } })
          return
        }
        pendingLaunch = request
        // Ready for configuration only once launch has arrived, as debugpy.
        event('initialized', {})
        return
      case 'setBreakpoints':
        breakpoints.clear()
        for (const bp of a.breakpoints ?? []) breakpoints.set(bp.line, bp)
        respond(request, { breakpoints: (a.breakpoints ?? []).map((bp, i) => ({ id: i + 1, verified: bp.line !== 999, line: bp.line })) })
        return
      case 'setFunctionBreakpoints':
        respond(request, { breakpoints: (a.breakpoints ?? []).map((_, i) => ({ id: 100 + i, verified: true })) })
        return
      case 'setExceptionBreakpoints':
        exceptionFilters = a.filters ?? []
        respond(request, {})
        return
      case 'configurationDone':
        respond(request, {})
        if (pendingLaunch) {
          respond(pendingLaunch, {})
          pendingLaunch = null
          startProgram()
        }
        return
      case 'threads':
        respond(request, { threads: [{ id: 1, name: 'main' }] })
        return
      case 'stackTrace':
        respond(request, {
          stackFrames: [
            { id: 100, name: `line_${current}`, line: current, column: 1, source: { path: config.program } },
            { id: 101, name: 'main', line: 1, column: 1, source: { path: config.program } },
          ],
          totalFrames: 2,
        })
        return
      case 'scopes':
        respond(request, {
          scopes: [
            { name: 'Locals', variablesReference: 1, expensive: false },
            { name: 'Globals', variablesReference: 2, expensive: true },
          ],
        })
        return
      case 'variables':
        if (a.variablesReference === 1) {
          respond(request, {
            variables: [
              { name: 'line', value: String(current), type: 'int', variablesReference: 0 },
              { name: 'counter', value: String(counter), type: 'int', variablesReference: 0 },
              { name: 'data', value: '{a: 1, b: [1, 2]}', type: 'dict', variablesReference: 3 },
            ],
          })
        } else if (a.variablesReference === 3) {
          respond(request, {
            variables: [
              { name: 'a', value: '1', type: 'int', variablesReference: 0 },
              { name: 'b', value: '[1, 2]', type: 'list', variablesReference: 4 },
            ],
          })
        } else if (a.variablesReference === 4) {
          respond(request, { variables: [{ name: '0', value: '1', variablesReference: 0 }, { name: '1', value: '2', variablesReference: 0 }] })
        } else {
          respond(request, { variables: [] })
        }
        return
      case 'evaluate':
        try {
          const value = evaluate(a.expression)
          respond(request, { result: String(value), type: typeof value, variablesReference: 0 })
        } catch (error) {
          respond(request, undefined, false, error.message)
        }
        return
      case 'setVariable':
        if (a.name === 'counter') counter = Number(a.value)
        respond(request, { value: a.value })
        return
      case 'continue':
        respond(request, { allThreadsContinued: true })
        run(false)
        return
      case 'next':
      case 'stepIn':
      case 'stepOut':
        respond(request, {})
        run(true)
        return
      case 'pause':
        respond(request, {})
        stop('pause')
        return
      case 'terminate':
      case 'disconnect':
        respond(request, {})
        event('terminated', {})
        setTimeout(close, 20)
        return
      default:
        respond(request, undefined, false, `unsupported: ${request.command}`)
    }
  }

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const match = /content-length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      const start = headerEnd + 4
      if (buffer.length < start + length) return
      const body = buffer.subarray(start, start + length).toString('utf8')
      buffer = buffer.subarray(start + length)
      let message
      try {
        message = JSON.parse(body)
      } catch {
        continue
      }
      if (message.type === 'response') {
        waiting.get(message.request_seq)?.(message.body)
        waiting.delete(message.request_seq)
      } else if (message.type === 'request') {
        handle(message).catch((error) => respond(message, undefined, false, String(error?.message ?? error)))
      }
    }
  }
}

if (port) {
  let open = 0
  const server = createServer((socket) => {
    open++
    const receive = connection(
      (data) => socket.write(data),
      () => socket.end(),
    )
    socket.on('data', receive)
    socket.on('close', () => {
      open--
      // Like a real adapter server: gone once its last session is.
      if (open === 0) setTimeout(() => open === 0 && process.exit(0), 200)
    })
  })
  server.listen(port, '127.0.0.1')
} else {
  const receive = connection(
    (data) => process.stdout.write(data),
    () => process.exit(0),
  )
  process.stdin.on('data', receive)
}
