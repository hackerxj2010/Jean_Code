/**
 * `@jean/desktop` — the Tauri desktop app (architecture §16.2).
 *
 * **Reserved. This package is being built separately and is deliberately empty.**
 *
 * Nothing here is stubbed or half-written, so there is no scaffolding to unpick
 * before starting. What follows is the integration surface that already exists,
 * so the app can be built against a working agent rather than alongside one.
 *
 * ## What to drive
 *
 * `@jean/sdk` is the intended entry point — `createAgent({ cwd })` returns an
 * agent with `send`, `spawn`, `interrupt`, `addTool`, `events`, `usage`,
 * `files`, and `close`. It owns a full `Orchestrator` underneath, so everything
 * the CLI can do is reachable without going through the CLI.
 *
 * For lower-level control, `Orchestrator` from `@jean/agent` takes:
 *
 * * `onEvent` — every `LoopEvent`: streaming text, tool starts and results,
 *   compaction notices, errors. This is what a UI renders.
 * * `confirm` — permission prompts. Returning a promise lets the app show a
 *   real dialog rather than a terminal y/n.
 * * `ask` — the `ask` tool's handler, for a question with options.
 *
 * ## What not to rebuild
 *
 * * Session persistence, resume, and compaction are in `@jean/core`.
 * * `@jean/tui2` already solves terminal rendering; its `components.ts` holds the
 *   diff renderer and status formatting, which are view-agnostic.
 * * `@jean/browser` drives Chrome over CDP, so an in-app browser pane does not
 *   need a second browser integration.
 *
 * ## The one thing worth deciding early
 *
 * Whether the app runs the agent in-process or talks to a separate one. Both
 * work: in-process is simpler, and a separate process survives the window
 * closing — which matters for the long autonomous runs this app is meant to
 * supervise. `@jean/acp` already speaks a session protocol over a stream pair
 * and is the natural transport if the answer is "separate".
 */

export const STATUS = 'reserved' as const

/**
 * Reports that this package is deliberately empty.
 *
 * Distinct from "not implemented yet": nothing is planned here, because the
 * desktop app is being built elsewhere.
 */
export function reserved(what: string): never {
  throw new Error(
    `@jean/desktop is reserved and intentionally empty, so ${what} is not available from it. Drive the agent through @jean/sdk instead.`,
  )
}
