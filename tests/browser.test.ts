import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Browser, CdpConnection, CdpError, findChrome } from '../packages/browser/src/index.ts'

/**
 * The protocol layer is driven against a real WebSocket server, because the
 * failures worth catching — correlation, timeouts, a socket closing mid-request
 * — only happen over a real socket.
 *
 * The browser tests need Chrome. Where it is absent the block is *skipped*,
 * so the runner reports it rather than counting it as passed; where Chrome is
 * present but will not start, they fail. They load a page served here, not a
 * site on the internet, so they do not depend on the network either.
 */

interface StubServer {
  url: string
  stop: () => void
  /** Messages the client sent. */
  received: Record<string, unknown>[]
}

/** A WebSocket server that answers a few CDP methods. */
function stubBrowser(): StubServer {
  const received: Record<string, unknown>[] = []

  const server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      if (srv.upgrade(request)) return undefined
      return new Response('expected a websocket upgrade', { status: 400 })
    },
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw)) as {
          id: number
          method: string
          params?: Record<string, unknown>
        }
        received.push(message)

        switch (message.method) {
          case 'Target.getTargets':
            ws.send(
              JSON.stringify({
                id: message.id,
                result: { targetInfos: [{ targetId: 'page-1', type: 'page' }] },
              }),
            )
            return

          case 'Target.attachToTarget':
            ws.send(JSON.stringify({ id: message.id, result: { sessionId: 'session-1' } }))
            return

          case 'Runtime.evaluate':
            ws.send(
              JSON.stringify({
                id: message.id,
                result: { result: { value: `evaluated:${String(message.params?.expression)}` } },
              }),
            )
            return

          case 'Throws':
            ws.send(
              JSON.stringify({
                id: message.id,
                error: { message: 'the browser refused', code: -32000 },
              }),
            )
            return

          case 'Silent':
            // Answers nothing, so the client's timeout is what ends it.
            return

          case 'Emit':
            ws.send(
              JSON.stringify({
                method: 'Runtime.consoleAPICalled',
                params: { type: 'error', args: [{ value: 'something broke' }] },
              }),
            )
            ws.send(JSON.stringify({ id: message.id, result: {} }))
            return

          default:
            ws.send(JSON.stringify({ id: message.id, result: {} }))
        }
      },
    },
  })

  return {
    url: `ws://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    received,
  }
}

describe('the CDP transport', () => {
  let server: StubServer

  beforeAll(() => {
    server = stubBrowser()
  })

  afterAll(() => {
    server.stop()
  })

  /** A connected client against the shared server. */
  async function connect(): Promise<CdpConnection> {
    const connection = new CdpConnection(server.url)
    await connection.connect()
    return connection
  }

  test('completes a request and returns its result', async () => {
    const connection = await connect()

    try {
      const result = await connection.send<{ result: { value: string } }>('Runtime.evaluate', {
        expression: '1 + 1',
      })
      expect(result.result.value).toBe('evaluated:1 + 1')
    } finally {
      connection.shutdown('done')
    }
  })

  test('keeps concurrent requests apart', async () => {
    const connection = await connect()

    try {
      const [a, b, c] = await Promise.all([
        connection.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'a' }),
        connection.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'b' }),
        connection.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'c' }),
      ])

      expect([a.result.value, b.result.value, c.result.value]).toEqual([
        'evaluated:a',
        'evaluated:b',
        'evaluated:c',
      ])
    } finally {
      connection.shutdown('done')
    }
  })

  test('surfaces a protocol error as a rejection', async () => {
    const connection = await connect()

    // Caught explicitly rather than with `expect().rejects`: that helper stops
    // this Bun version from delivering the server's reply to the WebSocket
    // callback at all, so the assertion waits out the full timeout instead of
    // seeing the error. The timeout test below is unaffected because its
    // rejection comes from a timer rather than from IO.
    let caught: Error | undefined
    try {
      await connection.send('Throws')
    } catch (err) {
      caught = err as Error
    } finally {
      connection.shutdown('done')
    }

    expect(caught).toBeDefined()
    expect(caught!.message).toContain('the browser refused')
  })

  test('times out rather than hanging on a silent browser', async () => {
    const connection = await connect()

    try {
      await expect(connection.send('Silent', {}, undefined, 300)).rejects.toThrow(/timed out/)
    } finally {
      connection.shutdown('done')
    }
  })

  test('delivers and buffers events', async () => {
    const connection = await connect()

    try {
      const seen: string[] = []
      connection.onEvent((event) => seen.push(event.method))
      await connection.send('Emit')
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(seen).toContain('Runtime.consoleAPICalled')
      // Buffered too, so a listener attached after navigation can still see the
      // errors navigation produced.
      expect(connection.buffered('Runtime.').length).toBeGreaterThan(0)
    } finally {
      connection.shutdown('done')
    }
  })

  test('rejects everything outstanding when the socket closes', async () => {
    const connection = await connect()
    const pending = connection.send('Silent', {}, undefined, 10_000)
    connection.shutdown('closed deliberately')

    await expect(pending).rejects.toThrow(/closed deliberately/)
    expect(connection.isClosed).toBe(true)
  })

  test('reports a connection that cannot be made', async () => {
    // Port 1 is never a CDP endpoint.
    const connection = new CdpConnection('ws://127.0.0.1:1')
    await expect(connection.connect(1000)).rejects.toThrow(CdpError)
  })

  test('refuses to send once closed', async () => {
    const connection = new CdpConnection('ws://127.0.0.1:1')
    connection.shutdown('never opened')
    await expect(connection.send('Anything')).rejects.toThrow(/closed/)
  })
})

describe('Chrome detection', () => {
  test('either finds a browser or says it did not', () => {
    const path = findChrome()
    // Never throws: an absent browser is an ordinary outcome, not an error.
    expect(path === undefined || typeof path === 'string').toBe(true)
  })
})

/**
 * Live tests. One browser is shared: launching Chrome costs about a second, and
 * paying that per test would make the suite unpleasant to run.
 */
const chromeAvailable = Boolean(findChrome())

/** The page every live test drives, served locally. */
const FIXTURE_HTML =
  '<!doctype html><html><head><title>Example Domain</title></head>' +
  '<body><h1>Example Domain</h1><p>A page served by the test.</p></body></html>'

describe.skipIf(!chromeAvailable)('driving a real browser', () => {
  let shared: Browser | undefined
  let startError: unknown
  let server: ReturnType<typeof Bun.serve> | undefined
  let origin = ''

  // Launching happens once, here, rather than inside the first test. A cold
  // Chrome start on Windows can take several seconds, and charging that to
  // whichever test ran first made the suite fail depending on ordering.
  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(FIXTURE_HTML, { headers: { 'content-type': 'text/html' } }),
    })
    origin = `http://127.0.0.1:${server.port}`
    const browser = new Browser({ headless: true })
    try {
      await browser.start()
      // Assigned only once the start succeeded: caching a half-started browser
      // makes every later test fail with "the browser is not started" instead
      // of reporting the launch failure.
      shared = browser
    } catch (error) {
      startError = error
      await browser.stop().catch(() => {})
    }
  }, 60_000)

  /** The shared browser. Chrome was found, so failing to start is a failure. */
  function page(): Browser {
    if (!shared) throw new Error(`Chrome was found but did not start: ${String(startError)}`)
    return shared
  }

  afterAll(async () => {
    await shared?.stop()
    server?.stop(true)
  }, 30_000)

  test('navigates and reads the page', async () => {
    const browser = page()

    await browser.goto(`${origin}/`)
    expect(await browser.title()).toBe('Example Domain')
    expect(await browser.url()).toContain('127.0.0.1')
    expect(await browser.text()).toContain('Example Domain')
  }, 30_000)

  test('evaluates in the page', async () => {
    const browser = page()

    expect(await browser.evaluate<number>('1 + 1')).toBe(2)
    expect(await browser.evaluate<string>('document.querySelector("h1").textContent')).toBe(
      'Example Domain',
    )
  }, 30_000)

  test('reports an expression that throws', async () => {
    const browser = page()

    await expect(browser.evaluate('throw new Error("deliberate")')).rejects.toThrow(/deliberate/)
  }, 30_000)

  test('records network requests', async () => {
    const browser = page()

    browser.clearLogs()
    await browser.goto(`${origin}/`)
    expect(browser.networkRequests().length).toBeGreaterThan(0)
  }, 30_000)

  test('captures console output', async () => {
    const browser = page()

    browser.clearLogs()
    await browser.evaluate('console.error("a deliberate error")')
    await new Promise((resolve) => setTimeout(resolve, 200))

    // The console is what turns "the page looks wrong" into a specific failure.
    expect(browser.consoleMessages('error').some((m) => m.text.includes('deliberate'))).toBe(true)
  }, 30_000)

  test('reports a missing selector rather than silently doing nothing', async () => {
    const browser = page()

    await expect(browser.click('#does-not-exist')).rejects.toThrow(/no element matches/)
    await expect(browser.waitForSelector('#never-appears', 500)).rejects.toThrow(/did not appear/)
  }, 30_000)

  test('takes a screenshot', async () => {
    const browser = page()

    const data = await browser.screenshot()
    // A PNG in base64 always begins with the same header bytes.
    expect(data.startsWith('iVBOR')).toBe(true)
  })
})
