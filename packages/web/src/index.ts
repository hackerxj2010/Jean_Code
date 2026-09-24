/**
 * `@jean/web` — the browser IDE (architecture §16.3).
 *
 * **Reserved. This package is being built separately and is deliberately empty.**
 *
 * Nothing here is stubbed or half-written, so there is no scaffolding to unpick
 * before starting. What follows is the integration surface that already exists.
 *
 * ## What to drive
 *
 * `@jean/sdk`'s `createAgent({ cwd })` on the server side, with its event stream
 * forwarded to the browser. `Orchestrator`'s `onEvent` emits `LoopEvent`s that
 * are already shaped for rendering — text deltas, tool starts and results,
 * compaction notices — so the wire format can be those events verbatim rather
 * than a translation of them.
 *
 * `@jean/mcp`'s `serveMcp` shows the pattern for exposing the agent over a
 * stream, and `@jean/acp`'s `serve` shows a session protocol with streamed
 * updates. Either is a reasonable starting shape for the WebSocket layer.
 *
 * ## What not to rebuild
 *
 * * `@jean/codemap` answers "which files matter" and outlines a file without
 *   reading it — both directly useful for a file tree and a jump-to-symbol box.
 * * `@jean/lsp` provides definitions, references, hover, and symbols, which is
 *   what an editor pane needs and is far better than re-deriving them.
 * * `@jean/tools`'s `read` returns hashline anchors; an editor that shows them
 *   lets a user cite one back to the agent.
 *
 * ## The two things worth deciding early
 *
 * **Authentication.** Serving an agent over HTTP puts a shell on the network.
 * `@jean/gateway`'s `IdentityStore` already implements expiring single-use link
 * codes for exactly this problem and is reusable here — the reasoning behind it
 * applies unchanged.
 *
 * **Whether the browser edits files directly or asks the agent to.** Going
 * through the agent keeps every write inside the permission gate and the event
 * log; a direct write path bypasses both and has to re-earn that safety.
 */

export const STATUS = 'reserved' as const

/**
 * Reports that this package is deliberately empty.
 *
 * Distinct from "not implemented yet": nothing is planned here, because the web
 * IDE is being built elsewhere.
 */
export function reserved(what: string): never {
  throw new Error(
    `@jean/web is reserved and intentionally empty, so ${what} is not available from it. Drive the agent through @jean/sdk instead.`,
  )
}
