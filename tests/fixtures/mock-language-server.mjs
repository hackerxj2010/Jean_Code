/**
 * A minimal server speaking real LSP framing, for the transport tests.
 *
 * Deliberately a separate process: the bug worth catching is a message body
 * split across stream chunks, which only happens over a real pipe.
 */

let buffer = Buffer.alloc(0)

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function handle(message) {
  const { id, method, params } = message

  switch (method) {
    case 'echo':
      send({ jsonrpc: '2.0', id, result: { value: params?.value } })
      break

    case 'fail':
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: 'deliberate failure' },
      })
      break

    case 'emitNotification':
      send({ jsonrpc: '2.0', method: 'test/notify', params: { text: params?.text } })
      send({ jsonrpc: '2.0', id, result: null })
      break

    case 'never':
      // Answer nothing at all, so the client's timeout is what ends it.
      break

    case '$/cancelRequest':
      break

    default:
      if (id !== undefined) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `no handler for ${method}` },
        })
      }
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
      handle(JSON.parse(body))
    } catch {
      // A malformed message is ignored, as a real server would.
    }
  }
})
