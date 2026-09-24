/**
 * Runs the interface in a real terminal and reports what it drew.
 *
 * `bun packages/tui2/smoke.ts [--keep] [--send "text"]`
 *
 * A tty is not optional. The renderer paints almost nothing into a pipe, so a
 * piped check only catches a throw loud enough to reach stderr — and misses
 * every failure after the first paint, which is most of them. This drives a
 * tmux pane and captures what is actually on screen.
 *
 * Four earlier versions each passed while the interface was visibly broken:
 *
 * 1. "Is the process alive?" — React catches a render error and keeps it up.
 * 2. Trapping `console.error` — `@opentui` draws errors into the frame.
 * 3. Wrapping `process.stdout.write` — the renderer writes to the fd directly.
 * 4. Passing the command to `tmux new-session` — on Windows the pane runs a
 *    login shell whose profile printed a system banner over the whole pane, so
 *    the capture showed fastfetch rather than anything this program drew.
 *
 * Hence the shape below: start a bare session, wait for the shell to settle,
 * clear it, then type the command in.
 */

import { spawnSync } from 'node:child_process'

const SESSION = 'jean-smoke'

/** Long enough for a shell profile to finish printing. */
const SHELL_SETTLE_MS = 6000
/** Long enough for startup, config load, and a first paint. */
const RENDER_MS = 18000

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const sendIndex = args.indexOf('--send')
const toSend = sendIndex === -1 ? undefined : args[sendIndex + 1]

function tmux(...argv: string[]): { ok: boolean; out: string } {
  const result = spawnSync('tmux', argv, {
    encoding: 'utf8',
    // Git Bash rewrites any argument that looks like a Unix path into a Windows
    // one before the process sees it, so sending the literal text `/help` types
    // `C:/Program Files/Git/help` into the pane instead.
    env: { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' },
  })
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

// A leftover session would be captured instead of a fresh one, showing the
// previous run's failure.
tmux('kill-session', '-t', SESSION)

if (!tmux('new-session', '-d', '-s', SESSION, '-x', '120', '-y', '40').ok) {
  process.stderr.write('smoke: could not start tmux\n')
  process.exit(2)
}

await Bun.sleep(SHELL_SETTLE_MS)
tmux('send-keys', '-t', SESSION, 'clear', 'Enter')
await Bun.sleep(1500)

// Typed rather than passed as the pane command, so the shell's profile output
// is already on screen and cleared before this starts drawing.
tmux(
  'send-keys',
  '-t',
  SESSION,
  'cd D:\\ProjetsIA\\Jean_Code; bun run packages/cli/src/index.ts',
  'Enter',
)

await Bun.sleep(RENDER_MS)

if (toSend !== undefined) {
  // Text and Enter go in separate calls with a gap between. Sent together the
  // renderer sees them in one read and the newline lands inside the paste
  // rather than as a submit, so the prompt sits in the box unsent.
  tmux('send-keys', '-t', SESSION, '-l', toSend)
  await Bun.sleep(1200)
  tmux('send-keys', '-t', SESSION, 'Enter')
  await Bun.sleep(20000)
}

const screen = tmux('capture-pane', '-p', '-t', SESSION).out
if (!keep) tmux('kill-session', '-t', SESSION)

/**
 * Signatures of a failure.
 *
 * Deliberately specific: "error" alone appears in ordinary interface copy, and
 * a check that fires on that gets ignored within a week.
 */
const FAILURES: [RegExp, string][] = [
  [/\b(\w+) is not defined\b/, 'a reference to something that no longer exists'],
  [/\bis not a function\b/, 'a call hit a missing function'],
  [/Cannot find module/, 'a module failed to resolve'],
  [/Cannot read (?:propert|.*of undefined)/, 'read through a null'],
  [/not initialized/, 'used before it was set up'],
  [/at react_stack_bottom_frame/, 'a React render threw'],
  [/at renderWithHooks/, 'a hook threw during render'],
]

// The renderer wraps long lines mid-token, so a stack trace only matches as one
// string once the wrapping is undone.
const flat = screen.replace(/\s+/g, ' ')
const found: string[] = []

for (const [pattern, description] of FAILURES) {
  const match = pattern.exec(flat)
  if (!match) continue
  const start = Math.max(0, match.index - 120)
  found.push(`${description}\n    …${flat.slice(start, match.index + 220).trim()}…`)
}

process.stdout.write(`\n${'─'.repeat(72)}\n${screen.trimEnd()}\n${'─'.repeat(72)}\n\n`)

if (found.length > 0) {
  process.stdout.write(`smoke: FAILED — ${found.length} problem(s)\n\n`)
  for (const problem of found.slice(0, 3)) process.stdout.write(`  ${problem}\n\n`)
  process.exit(1)
}

// An empty pane is not a pass: it means nothing was drawn, which is its own
// failure and exactly the one a naive check calls success.
if (screen.trim().length === 0) {
  process.stdout.write('smoke: FAILED — the pane is empty; nothing was drawn\n')
  process.exit(1)
}

process.stdout.write(`smoke: rendered (${screen.trim().length} chars on screen)\n`)
if (keep) process.stdout.write(`  still running: tmux attach -t ${SESSION}\n`)
