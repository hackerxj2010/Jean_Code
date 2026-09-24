/**
 * A standalone OpenAI-compatible model server for the end-to-end tests.
 *
 * It runs as its own process on purpose. The tests drive the CLI with
 * `spawnSync`, which blocks the calling process's event loop — an in-process
 * server would never get a chance to answer, and every run would deadlock.
 *
 * Control endpoints:
 *   POST /__script    — set the queue of turns to return, as JSON
 *   GET  /__requests  — the request bodies received since the last script
 *   POST /__reset     — clear both
 *
 * Prints `READY <port>` on stdout once listening.
 */
import { createServer } from 'node:http'

/** Turns to return, in order. Each is an OpenAI `message` object. */
let script = []
/** Request bodies received, for assertions. */
let requests = []

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Renders one scripted turn as a Server-Sent Events body. */
function streamBody(message) {
  const base = { id: 'chatcmpl-mock', model: 'mock-model', object: 'chat.completion.chunk' }
  const frames = []

  if (message.content) {
    // Deliberately chunked small so the adapter's SSE reassembly is exercised
    // rather than trivially satisfied by one whole-message frame.
    const text = message.content
    for (let i = 0; i < text.length; i += 7) {
      frames.push({ ...base, choices: [{ delta: { content: text.slice(i, i + 7) } }] })
    }
  }

  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    frames.push({
      ...base,
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index,
                id: call.id,
                type: 'function',
                function: { name: call.function.name, arguments: '' },
              },
            ],
          },
        },
      ],
    })
    const args = call.function.arguments
    for (let i = 0; i < args.length; i += 11) {
      frames.push({
        ...base,
        choices: [
          {
            delta: { tool_calls: [{ index, function: { arguments: args.slice(i, i + 11) } }] },
          },
        ],
      })
    }
  }

  frames.push({
    ...base,
    choices: [{ delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 30 },
  })

  return `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`
}

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    const url = req.url ?? '/'

    if (url === '/__script') {
      script = body ? JSON.parse(body) : []
      requests = []
      return json(res, 200, { ok: true, queued: script.length })
    }
    if (url === '/__requests') {
      return json(res, 200, requests)
    }
    if (url === '/__reset') {
      script = []
      requests = []
      return json(res, 200, { ok: true })
    }

    const parsed = body ? JSON.parse(body) : {}
    requests.push(parsed)

    const message = script.shift() ?? { role: 'assistant', content: 'No scripted turn left.' }

    if (parsed.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(streamBody(message))
      return
    }

    json(res, 200, {
      id: 'chatcmpl-mock',
      model: 'mock-model',
      choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    })
  })
})

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`READY ${server.address().port}\n`)
})
