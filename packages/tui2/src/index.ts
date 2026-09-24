/**
 * `@jean/tui` — the full-screen terminal interface (architecture §16.1).
 *
 * A React tree rendered onto the terminal through `@opentui`. `@jean/cli`'s
 * line-based renderer remains the fallback for pipes, CI, and dumb terminals,
 * where a repainting interface is worse than useless.
 */

export { launch, type LaunchOptions } from './main'
export { App } from './app'

export {
  LOGO,
  LOGO_SMALL,
  LOGO_TEXT,
  logoSizeFor,
  logoText,
  parseLogoLines,
  SHADOW_CHARS,
} from './branding/logo'

export { JeanClient, type ClientOptions } from './compat/client'
