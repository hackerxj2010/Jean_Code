import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ToolError, type Tool, type ToolResult } from '@jean/tools'
import { Browser, findChrome } from './browser.ts'

/**
 * Browser tools (architecture §18).
 *
 * The capability that matters here is not "the agent can browse" — it is that
 * the agent can *check its own work* on a web project: load the page it just
 * changed, read the console, see which requests failed. Without that, a
 * front-end change is written blind and verified by asking the user.
 */

/** One browser per session, started on first use. */
export class BrowserSession {
  private browser?: Browser
  private starting?: Promise<Browser>

  constructor(private readonly onError?: (message: string) => void) {}

  async get(): Promise<Browser> {
    if (this.browser?.isRunning) return this.browser

    this.starting ??= (async () => {
      const browser = new Browser({ onError: this.onError })
      await browser.start()
      this.browser = browser
      return browser
    })()

    try {
      return await this.starting
    } catch (err) {
      // Cleared so a later call retries rather than reusing a rejected promise
      // forever — the browser may have been installed since.
      this.starting = undefined
      throw err
    }
  }

  get isRunning(): boolean {
    return Boolean(this.browser?.isRunning)
  }

  async stop(): Promise<void> {
    await this.browser?.stop()
    this.browser = undefined
    this.starting = undefined
  }
}

export function createBrowserTools(session: BrowserSession): Tool[] {
  async function browser(): Promise<Browser> {
    try {
      return await session.get()
    } catch (err) {
      throw new ToolError(
        err instanceof Error ? err.message : String(err),
        findChrome()
          ? 'Chrome was found but would not start. It may already be running with a conflicting profile.'
          : 'No Chrome or Edge installation was found. Install one, or set CHROME_PATH.',
      )
    }
  }

  const navigateTool: Tool<{ url: string; waitFor?: string }> = {
    name: 'browser_open',
    risk: 'execute',
    description: [
      'Open a URL in a headless browser and return the page text.',
      '',
      'Use this to check a change you just made to a web project — the rendered',
      'page, its console errors, and its failed requests are things you cannot',
      'learn from the source. For reading an article or documentation, `web_fetch`',
      'is cheaper.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to open.' },
        waitFor: { type: 'string', description: 'CSS selector to wait for before reading.' },
      },
      required: ['url'],
    },
    summarize: (args) => `open ${args.url.slice(0, 60)}`,

    async execute(args): Promise<ToolResult> {
      const page = await browser()
      page.clearLogs()

      await page.goto(args.url)
      if (args.waitFor) await page.waitForSelector(args.waitFor)

      const [title, text, url] = await Promise.all([page.title(), page.text(), page.url()])
      const errors = page.consoleMessages('error')
      const failed = page.networkRequests(true)

      const sections = [`# ${title}`, url, '']

      // Errors first: if the page is broken, that is the answer, and the text
      // below it is a symptom rather than the finding.
      if (errors.length > 0) {
        sections.push(`## ${errors.length} console errors`)
        for (const error of errors.slice(0, 10)) sections.push(`  ${error.text.slice(0, 200)}`)
        sections.push('')
      }

      if (failed.length > 0) {
        sections.push(`## ${failed.length} failed requests`)
        for (const request of failed.slice(0, 10)) {
          sections.push(`  ${request.status ?? request.errorText ?? 'failed'}  ${request.url.slice(0, 120)}`)
        }
        sections.push('')
      }

      sections.push(text.slice(0, 30_000))

      return {
        output: sections.join('\n'),
        display: { kind: 'browser', url, errors: errors.length },
      }
    },
  }

  const actTool: Tool<{
    action: 'click' | 'type' | 'wait' | 'evaluate'
    selector?: string
    text?: string
    expression?: string
  }> = {
    name: 'browser_act',
    risk: 'execute',
    description: [
      'Interact with the open page: click, type, wait for an element, or evaluate JavaScript.',
      '',
      'Elements are addressed by CSS selector rather than by coordinates, because',
      'coordinates go stale the moment the layout shifts and you cannot see that',
      'it has.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'type', 'wait', 'evaluate'] },
        selector: { type: 'string', description: 'CSS selector, for click/type/wait.' },
        text: { type: 'string', description: 'Text to type.' },
        expression: { type: 'string', description: 'JavaScript to evaluate.' },
      },
      required: ['action'],
    },
    summarize: (args) => `${args.action} ${args.selector ?? args.expression?.slice(0, 40) ?? ''}`,

    async execute(args): Promise<ToolResult> {
      const page = await browser()

      switch (args.action) {
        case 'click':
          if (!args.selector) throw new ToolError('`click` needs a `selector`.')
          await page.click(args.selector)
          return { output: `Clicked ${args.selector}.` }

        case 'type':
          if (!args.selector || args.text === undefined) {
            throw new ToolError('`type` needs a `selector` and `text`.')
          }
          await page.type(args.selector, args.text)
          return { output: `Typed into ${args.selector}.` }

        case 'wait':
          if (!args.selector) throw new ToolError('`wait` needs a `selector`.')
          await page.waitForSelector(args.selector)
          return { output: `${args.selector} appeared.` }

        case 'evaluate': {
          if (!args.expression) throw new ToolError('`evaluate` needs an `expression`.')
          const value = await page.evaluate(args.expression)
          return { output: value === undefined ? '(undefined)' : JSON.stringify(value, null, 2) }
        }

        default:
          throw new ToolError(`Unknown action "${args.action}".`)
      }
    },
  }

  const inspectTool: Tool<{ what: 'console' | 'network' | 'screenshot'; path?: string }> = {
    name: 'browser_inspect',
    risk: 'read',
    // One page, one session: an inspect racing an action reads a half-updated DOM.
    concurrency: 'serial',
    description: [
      'Read the console, the network log, or take a screenshot of the open page.',
      '',
      'The console and network log are what turn "the page looks wrong" into a',
      'specific failure you can act on.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        what: { type: 'string', enum: ['console', 'network', 'screenshot'] },
        path: { type: 'string', description: 'Where to save a screenshot.' },
      },
      required: ['what'],
    },
    summarize: (args) => `browser ${args.what}`,

    async execute(args, context): Promise<ToolResult> {
      const page = await browser()

      switch (args.what) {
        case 'console': {
          const messages = page.consoleMessages()
          if (messages.length === 0) return { output: 'The console is empty.' }

          const lines = messages
            .slice(-60)
            .map((message) => `  ${message.level.padEnd(7)} ${message.text.slice(0, 200)}`)
          return { output: `${messages.length} console messages:\n${lines.join('\n')}` }
        }

        case 'network': {
          const requests = page.networkRequests()
          if (requests.length === 0) return { output: 'No requests recorded.' }

          const failed = requests.filter((r) => r.failed || (r.status ?? 0) >= 400)
          const lines = (failed.length > 0 ? failed : requests.slice(-40)).map(
            (request) =>
              `  ${String(request.status ?? (request.failed ? 'failed' : '...')).padEnd(7)} ${request.method.padEnd(5)} ${request.url.slice(0, 110)}`,
          )

          const header =
            failed.length > 0
              ? `${failed.length} failed of ${requests.length} requests:`
              : `${requests.length} requests:`
          return { output: `${header}\n${lines.join('\n')}` }
        }

        case 'screenshot': {
          const data = await page.screenshot(true)
          // Written to disk rather than returned: a base64 PNG is hundreds of
          // thousands of tokens the model cannot read anyway.
          const target = join(context.cwd, args.path ?? 'screenshot.png')
          await writeFile(target, Buffer.from(data, 'base64'))
          return { output: `Saved a screenshot to ${args.path ?? 'screenshot.png'}.` }
        }

        default:
          throw new ToolError(`Unknown target "${args.what}".`)
      }
    },
  }

  return [navigateTool as Tool, actTool as Tool, inspectTool as Tool]
}
