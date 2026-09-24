/**
 * `@jean/browser` — browser control over the Chrome DevTools Protocol
 * (architecture §18).
 *
 * CDP is JSON-RPC over a WebSocket, so this needs no dependency: no Puppeteer,
 * no bundled browser download. Chrome is found on the machine rather than
 * fetched, because an agent should not quietly pull 150MB onto someone's disk.
 *
 * The capability that matters is not "the agent can browse" — it is that the
 * agent can check its own work on a web project: load the page it changed, read
 * the console, see which requests failed.
 */

export { CdpConnection, CdpError, type CdpEvent } from './cdp.ts'

export {
  Browser,
  findChrome,
  type ConsoleMessage,
  type LaunchOptions,
  type NetworkRequest,
} from './browser.ts'

export { BrowserSession, createBrowserTools } from './tools.ts'
