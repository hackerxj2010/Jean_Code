/**
 * A minimal debug adapter speaking real DAP framing, for the protocol tests.
 *
 * Implements just enough of the lifecycle to exercise the session: initialize,
 * launch, breakpoints, a stopped event, a stack with variables, and terminate.
 */

let buffer = Buffer.alloc(0)
let seq = 1

function send(message) {
  const body = Buffer.from(JSON.stringify({ seq: seq++, ...message }), 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function respond(request, body, success = true, message) {
  send({
    type: 'response',
    request_seq: request.seq,
    success,
    command: request.command,
    body,
    message,
  })
}

function event(name, body) {
  send({ type: 'event', event: name, body })
}

const breakpoints = new Map()

function handle(request) {
  switch (request.command) {
    case 'initialize':
      respond(request, {
        supportsConfigurationDoneRequest: true,
        supportsExceptionInfoRequest: true,
        supportsTerminateRequest: true,
        supportsCompletionsRequest: true,
        supportsModulesRequest: true,
      })
      // The adapter signals it is ready for breakpoints only after this.
      event('initialized', {})
      break

    case 'launch':
      respond(request, {})
      break

    case 'attach':
      respond(request, {})
      break

    case 'setBreakpoints': {
      const path = request.arguments?.source?.path ?? ''
      const lines = request.arguments?.breakpoints?.map((b) => b.line) ?? []
      breakpoints.set(path, lines)
      respond(request, {
        // Line 999 is treated as unverifiable, so the client can be tested
        // against a breakpoint that will never fire.
        breakpoints: lines.map((line, i) => ({
          id: i + 1,
          verified: line !== 999,
          line,
          message: line === 999 ? 'no executable code on this line' : undefined,
        })),
      })
      break
    }

    case 'setFunctionBreakpoints':
      respond(request, {
        breakpoints: (request.arguments?.breakpoints ?? []).map((_unused, i) => ({
          id: 100 + i,
          verified: true,
        })),
      })
      break

    case 'setExceptionBreakpoints':
      respond(request, {})
      break

    case 'configurationDone':
      respond(request, {})
      break

    case 'continue':
      respond(request, { allThreadsContinued: true })
      // Immediately hit a breakpoint, so tests do not have to wait.
      setTimeout(() => event('stopped', { reason: 'breakpoint', threadId: 1 }), 20)
      break

    case 'next':
    case 'stepIn':
    case 'stepOut':
      respond(request, {})
      setTimeout(() => event('stopped', { reason: 'step', threadId: 1 }), 20)
      break

    case 'pause':
      respond(request, {})
      setTimeout(() => event('stopped', { reason: 'pause', threadId: 1 }), 20)
      break

    case 'threads':
      respond(request, { threads: [{ id: 1, name: 'main' }] })
      break

    case 'stackTrace':
      respond(request, {
        stackFrames: [
          { id: 1000, name: 'compute', line: 42, column: 3, source: { path: '/app/main.py' } },
          { id: 1001, name: 'main', line: 10, column: 1, source: { path: '/app/main.py' } },
        ],
        totalFrames: 2,
      })
      break

    case 'scopes':
      respond(request, {
        scopes: [
          { name: 'Locals', variablesReference: 2000, expensive: false },
          { name: 'Globals', variablesReference: 2001, expensive: true },
        ],
      })
      break

    case 'variables':
      if (request.arguments?.variablesReference === 2000) {
        respond(request, {
          variables: [
            { name: 'total', value: '0', type: 'int', variablesReference: 0 },
            { name: 'items', value: '[1, 2, 3]', type: 'list', variablesReference: 2002 },
          ],
        })
      } else {
        respond(request, { variables: [] })
      }
      break

    case 'evaluate':
      respond(request, {
        result: `evaluated(${request.arguments?.expression})`,
        type: 'str',
        variablesReference: 0,
      })
      break

    case 'setVariable':
      respond(request, { value: request.arguments?.value })
      break

    case 'exceptionInfo':
      respond(request, {
        exceptionId: 'ZeroDivisionError',
        description: 'division by zero',
        details: { stackTrace: 'line 42' },
      })
      break

    case 'completions':
      respond(request, { targets: [{ label: 'total' }, { label: 'items' }] })
      break

    case 'modules':
      respond(request, { modules: [{ id: 1, name: 'main', path: '/app/main.py' }] })
      break

    case 'terminate':
    case 'disconnect':
      respond(request, {})
      event('terminated', {})
      break

    case 'failing':
      respond(request, undefined, false, 'deliberate adapter failure')
      break

    case 'never':
      break

    default:
      respond(request, undefined, false, `unsupported: ${request.command}`)
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])

  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return

    const header = buffer.subarray(0, headerEnd).toString('ascii')
    const match = /content-length:\s*(\d+)/i.exec(header)
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }

    const length = Number(match[1])
    const start = headerEnd + 4
    if (buffer.length < start + length) return

    const body = buffer.subarray(start, start + length).toString('utf8')
    buffer = buffer.subarray(start + length)

    try {
      const message = JSON.parse(body)
      if (message.type === 'request') handle(message)
    } catch {
      // A malformed message is ignored, as a real adapter would.
    }
  }
})
