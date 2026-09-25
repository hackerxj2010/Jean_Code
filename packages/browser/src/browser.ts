import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpConnection, CdpError } from './cdp.ts'

/**
 * Browser lifecycle (architecture §18).
 *
 * Launches a headless Chrome and drives it over CDP. Chrome is found rather
 * than downloaded: an agent should not silently pull 150MB onto someone's disk,
 * and any machine doing web development already has a browser.
 */

export interface ConsoleMessage {
  level: string
  text: string
  url?: string
  line?: number
}

export interface NetworkRequest {
  url: string
  method: string
  status?: number
  type?: string
  failed?: boolean
  errorText?: string
}

export interface LaunchOptions {
  headless?: boolean
  /** Explicit Chrome path, when detection fails. */
  executable?: string
  /** Attach to an already-running browser instead of launching. */
  endpoint?: string
  timeoutMs?: number
  onError?: (message: string) => void
}

/** Chrome locations, by platform, most likely first. */
const CHROME_PATHS: Record<string, string[]> = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
  ],
}

/** Finds an installed Chrome, or undefined. */
export function findChrome(): string | undefined {
  const fromEnv = process.env.CHROME_PATH ?? process.env.CHROMIUM_PATH
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  for (const candidate of CHROME_PATHS[process.platform] ?? []) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export class Browser {
  private process?: ChildProcess
  private connection?: CdpConnection
  private sessionId?: string
  private readonly options: LaunchOptions

  private readonly console: ConsoleMessage[] = []
  private readonly network: NetworkRequest[] = []

  constructor(options: LaunchOptions = {}) {
    this.options = options
  }

  /** Launches or attaches, then opens a page session. */
  async start(): Promise<void> {
    const endpoint = this.options.endpoint ?? (await this.launch())
    this.connection = new CdpConnection(endpoint)
    await this.connection.connect(this.options.timeoutMs ?? 15_000)

    // Attach to a page target. CDP's root connection can only manage targets;
    // everything interesting needs a session against a page.
    const { targetInfos } = await this.connection.send<{
      targetInfos: { targetId: string; type: string }[]
    }>('Target.getTargets')

    let targetId = targetInfos.find((target) => target.type === 'page')?.targetId
    if (!targetId) {
      const created = await this.connection.send<{ targetId: string }>('Target.createTarget', {
        url: 'about:blank',
      })
      targetId = created.targetId
    }

    const attached = await this.connection.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    this.sessionId = attached.sessionId

    // Domains must be enabled before they emit anything, and enabling them
    // after navigating means missing the events that navigation produced.
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Network.enable')
    await this.send('Log.enable')

    this.connection.onEvent((event) => this.record(event))
  }

  private async launch(): Promise<string> {
    const executable = this.options.executable ?? findChrome()
    if (!executable) {
      throw new CdpError(
        'No Chrome or Edge installation was found. Set CHROME_PATH, or pass an endpoint to attach to a running browser.',
        'launch',
      )
    }

    const profile = mkdtempSync(join(tmpdir(), 'jean-chrome-'))
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      // A sandboxed renderer cannot start inside many containers, and the
      // browser here only visits what the agent tells it to.
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-extensions',
    ]
    if (this.options.headless !== false) args.push('--headless=new')

    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.process = child

    // Chrome prints the DevTools URL to stderr once it is listening. Polling
    // the port would race with startup; reading the announcement does not.
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CdpError('Chrome did not report a debugging endpoint within 20s', 'launch'))
      }, 20_000)

      let buffer = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const match = /ws:\/\/[^\s]+/.exec(buffer)
        if (match) {
          clearTimeout(timer)
          resolve(match[0])
        }
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(new CdpError(`could not start ${executable}: ${err.message}`, 'launch'))
      })

      child.on('exit', (code) => {
        clearTimeout(timer)
        reject(new CdpError(`Chrome exited with code ${code} before reporting an endpoint`, 'launch'))
      })
    })
  }

  private record(event: { method: string; params: Record<string, unknown> }): void {
    switch (event.method) {
      case 'Runtime.consoleAPICalled': {
        const params = event.params as {
          type: string
          args?: { value?: unknown; description?: string }[]
        }
        this.console.push({
          level: params.type,
          text: (params.args ?? [])
            .map((arg) => String(arg.value ?? arg.description ?? ''))
            .join(' ')
            .slice(0, 2000),
        })
        break
      }

      case 'Runtime.exceptionThrown': {
        const params = event.params as {
          exceptionDetails?: { text?: string; url?: string; lineNumber?: number }
        }
        this.console.push({
          level: 'error',
          text: params.exceptionDetails?.text ?? 'uncaught exception',
          url: params.exceptionDetails?.url,
          line: params.exceptionDetails?.lineNumber,
        })
        break
      }

      case 'Network.requestWillBeSent': {
        const params = event.params as { request: { url: string; method: string }; type?: string }
        this.network.push({ url: params.request.url, method: params.request.method, type: params.type })
        break
      }

      case 'Network.responseReceived': {
        const params = event.params as { response: { url: string; status: number } }
        const entry = this.network.find((r) => r.url === params.response.url && r.status === undefined)
        if (entry) entry.status = params.response.status
        break
      }

      case 'Network.loadingFailed': {
        const params = event.params as { errorText?: string }
        const entry = [...this.network].reverse().find((r) => r.status === undefined && !r.failed)
        if (entry) {
          entry.failed = true
          entry.errorText = params.errorText
        }
        break
      }

      default:
        break
    }

    // Bounded: a page with a polling loop would otherwise grow these forever.
    if (this.console.length > 500) this.console.splice(0, this.console.length - 500)
    if (this.network.length > 1000) this.network.splice(0, this.network.length - 1000)
  }

  /** Sends a CDP command against the page session. */
  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.connection) throw new CdpError('the browser is not started', method)
    return this.connection.send<T>(method, params, this.sessionId)
  }

  /**
   * Navigates and waits for the new document's load event. A `load` from the
   * document being left — the start page finishing late, say — does not
   * count: only one fired after the main frame committed this navigation.
   * A page still loading at the timeout is left as it is; most of it is
   * usually readable by then.
   */
  async goto(url: string, timeoutMs = 30_000): Promise<void> {
    const connection = this.connection
    if (!connection) throw new CdpError('the browser is not started', 'Page.navigate')

    // Listening starts before navigating: a fast page commits and fires
    // `load` before a listener attached afterwards would exist.
    let current: string | undefined
    const loaded = new Set<string>()
    let wake = () => {}
    const stop = connection.onEvent((event) => {
      if (event.sessionId !== this.sessionId) return
      if (event.method === 'Page.frameNavigated') {
        const frame = event.params.frame as { parentId?: string; loaderId?: string } | undefined
        if (frame && !frame.parentId) current = frame.loaderId
      } else if (event.method === 'Page.loadEventFired' && current) {
        loaded.add(current)
        wake()
      }
    })

    try {
      const result = await this.send<{ errorText?: string; loaderId?: string }>('Page.navigate', { url })
      if (result.errorText) throw new CdpError(`navigation failed: ${result.errorText}`, 'Page.navigate')
      // Only the fragment changed: the document stays, and no load follows.
      const loader = result.loaderId
      if (!loader) return
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs)
        wake = () => {
          if (!loaded.has(loader)) return
          clearTimeout(timer)
          resolve()
        }
        wake()
      })
    } finally {
      stop()
    }
  }

  /** Evaluates an expression in the page and returns its value. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send<{
      result?: { value?: T; description?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })

    if (result.exceptionDetails) {
      throw new CdpError(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'the expression threw',
        'Runtime.evaluate',
      )
    }

    return result.result?.value as T
  }

  /** The page's visible text. */
  async text(): Promise<string> {
    return this.evaluate<string>('document.body ? document.body.innerText : ""')
  }

  async title(): Promise<string> {
    return this.evaluate<string>('document.title')
  }

  async url(): Promise<string> {
    return this.evaluate<string>('location.href')
  }

  /** A base64 PNG of the viewport. */
  async screenshot(fullPage = false): Promise<string> {
    const result = await this.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: fullPage,
    })
    return result.data
  }

  /**
   * Clicks the first element matching a selector.
   *
   * Dispatched through the DOM rather than by synthesizing a mouse event at
   * coordinates: coordinates go stale the moment the layout shifts, and an
   * agent cannot see that it has.
   */
  async click(selector: string): Promise<void> {
    const clicked = await this.evaluate<boolean>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`,
    )
    if (!clicked) throw new CdpError(`no element matches ${selector}`, 'click')
  }

  /** Types into the first element matching a selector. */
  async type(selector: string, text: string): Promise<void> {
    const found = await this.evaluate<boolean>(
      `(() => {
         const el = document.querySelector(${JSON.stringify(selector)})
         if (!el) return false
         el.focus()
         el.value = ${JSON.stringify(text)}
         // Frameworks listen for these; setting .value alone updates the DOM
         // but leaves React and Vue unaware the field changed.
         el.dispatchEvent(new Event('input', { bubbles: true }))
         el.dispatchEvent(new Event('change', { bubbles: true }))
         return true
       })()`,
    )
    if (!found) throw new CdpError(`no element matches ${selector}`, 'type')
  }

  /** Waits for a selector to appear. */
  async waitForSelector(selector: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const present = await this.evaluate<boolean>(
        `document.querySelector(${JSON.stringify(selector)}) !== null`,
      )
      if (present) return
      await new Promise((resolve) => setTimeout(resolve, 150))
    }

    throw new CdpError(`${selector} did not appear within ${timeoutMs}ms`, 'waitForSelector')
  }

  consoleMessages(level?: string): ConsoleMessage[] {
    return level ? this.console.filter((message) => message.level === level) : [...this.console]
  }

  networkRequests(failedOnly = false): NetworkRequest[] {
    return failedOnly
      ? this.network.filter((request) => request.failed || (request.status ?? 0) >= 400)
      : [...this.network]
  }

  clearLogs(): void {
    this.console.length = 0
    this.network.length = 0
  }

  get isRunning(): boolean {
    return Boolean(this.connection && !this.connection.isClosed)
  }

  async stop(): Promise<void> {
    this.connection?.shutdown('the browser was stopped')
    this.connection = undefined

    const child = this.process
    this.process = undefined
    if (!child || child.killed) return

    child.kill()
    const timer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL')
    }, 2000)
    timer.unref?.()
  }
}
