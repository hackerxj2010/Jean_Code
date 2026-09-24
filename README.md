# Jean Code

> A coding agent that grows smarter every day. Terminal-first. Everywhere-accessible. Open by default.

Jean Code is an autonomous coding agent that lives on your machine. It reads your codebase, writes production code, runs your tests, and remembers what it learned for next time. Zero telemetry, zero lock-in, MIT licensed.

```bash
export OPENROUTER_API_KEY=sk-or-...
bun run jean
```

---

## Status

This is an early build of the architecture in [`jean-code-architecture.md`](jean-code-architecture.md). The foundation and a complete working vertical slice are here; the breadth is not. **[docs/STATUS.md](docs/STATUS.md) lists exactly what works, what is partial, and what is not built** — read it before relying on anything.

What works today, end to end:

- **The agent loop** — multi-turn, tool-calling, with parallel reads, truncation recovery, loop detection, rate-limit retries, auto-compaction, session persistence, and resume.
- **The tool harness** — `read`, `write`, `edit`, `glob`, `grep`, `bash`, `todo`, `spawn`, `git_*`, `retain`/`recall`, `skill`/`skill_save`, and MCP tools over stdio or HTTP.
- **Edits that land** — `old_string`/`new_string` with a tolerant matcher cascade, atomic multi-edit batches, and hashline anchors, in Rust *and* TypeScript.
- **The model layer** — 15 providers over three wire protocols, streaming, role routing, fallback chains, prompt caching, and extended-thinking replay.
- **Goals, rewind, and arena** — `--verify "npm test"` keeps the agent working until the check passes; `/rewind` undoes a turn's edits; `jean arena` runs several attempts in parallel and keeps the best.
- **Claude Code compatible extensibility** — hooks, permission rules, custom slash commands, and custom agents from `.claude/` or `.jean/`, with project trust.
- **The CLI** — a full-screen TUI on a terminal, line-based output when piped, one-shot mode with JSON output, slash commands, shell completions, `jean doctor`.
- **Code intelligence** — real diagnostics, go-to-definition through imports, and references that distinguish a binding from a string that happens to match, via any installed language server.
- **Memory** — SQLite with FTS5 recall, scoped per project, entirely local.

All of the above has been run against live models, not just mocks — see [docs/STATUS.md](docs/STATUS.md).

---

## Install

Requires [Bun](https://bun.sh) 1.3+ (or Node 22+), and a Rust toolchain for the native core:

```bash
bun install
bun run build:native     # or: bun run jean native build
bun run jean native test # every crate, driven once through the bridge
bun run jean --help
```

The Rust core runs search, edits, shell parsing, isolation, compaction, memory, and audio. Every one of those keeps a TypeScript fallback, so Jean still starts without a Rust build — it is just slower and loses what only Rust provides. `jean doctor` says which you have.

Set one key and you can reach every provider:

```bash
export OPENROUTER_API_KEY=sk-or-...
```

That is the whole setup — OpenRouter is the default provider. See **[docs/openrouter.md](docs/openrouter.md)** for choosing models, the free tier, fallback chains, and routing roles to different models.

Or go direct: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, and a dozen more. Run `jean doctor` if anything is unclear — it reports credentials, which config files won, and whether memory is working.

> Jean Code's loop is built on tool calls. Pick a model that supports them, or the agent will describe the work instead of doing it.

---

## Use

```bash
jean                                  # interactive session
jean "fix the failing test in auth"   # start with a prompt
jean -p "what does this service do?"  # one-shot, non-interactive
jean -p "list the API routes" -f json # machine-readable output
jean resume                           # continue where you left off
jean doctor                           # diagnose configuration
```

Inside a session:

| Command | Does |
|---|---|
| `/help` | Every command and keyword |
| `/focus` `/autonomous` `/swarm` | Switch operating mode |
| `/model [id]` | Show or change the model |
| `/effort <fast\|normal\|high\|xhigh>` | Reasoning depth |
| `/permissions <auto\|ask\|plan\|full>` | Permission gating |
| `/context` | Token usage, cost, files changed |
| `/compact` | Summarize and continue |
| `/tools` | What the agent can currently do |
| `/goal <command>` | Keep working until the command passes (`/goal off` to clear) |
| `/rewind [n]` `/undo` | Restore the files the last turn(s) edited and forget them |
| `/arena [n] <task>` | Run n attempts in parallel, keep the best one |
| `/commands` `/agents` | Custom commands and sub-agents available here |
| `/hooks` `/mcp` | Active hooks, permission rules, and MCP servers |
| `/trust` | Let this project's own hooks, allow rules, and MCP servers run |
| `/your-command args` | Any custom command from `.jean/commands/` or `.claude/commands/` |

Magic keywords work inline in any prompt: `ultrathink`, `orchestrate`, `plan-first`, `deep-review`, `workflowz`. They apply to that turn only. `@path/to/file` attaches a file to the prompt.

---

## Getting tasks finished

```bash
jean -p "fix the failing auth tests" --verify "npm test"       # cannot stop until npm test passes
jean arena "make the parser handle unicode" --attempts 3 --verify "bun test"
jean -p "/review src/auth" --output-format stream-json          # a custom command, headless, one JSON event per line
```

**Goals.** With `--verify` (or `/goal`), the agent is not allowed to finish until the command passes; each failure is handed back to it with the output.

**Arena.** Several independent attempts run in parallel, each in its own git worktree seeded from your current files. The verify command judges them; the smallest passing change is merged into your working tree, uncommitted. Nothing is committed to your branch.

**Rewind.** Every file the agent edits is captured before its first change in a turn. `/rewind` puts them back and truncates the conversation to before that prompt.

## Extending it — the Claude Code formats

Jean reads the same files Claude Code does, so an existing setup works unchanged:

| What | Where |
|---|---|
| Instructions | `AGENTS.md`, `CLAUDE.md`, `JEAN.md` in the project and every parent directory, `*.local.md`, `~/.jean/JEAN.md`, with `@path` imports |
| Slash commands | `.jean/commands/*.md`, `.claude/commands/*.md` — `$ARGUMENTS`, `$1`, `@file`, `` !`cmd` `` |
| Sub-agents | `.jean/agents/*.md`, `.claude/agents/*.md` — `name`, `description`, `tools`, `model` |
| Skills | `.jean/skills/*/SKILL.md`, `.claude/skills/`, `~/.jean/skills/` — and the agent can write its own |
| Hooks and permission rules | `hooks` and `permissions` in `.jean.json`, `~/.jean/config.json`, `.claude/settings.json` |
| MCP servers | `mcpServers` in `.jean.json`, `~/.jean/config.json`, `.mcp.json` — stdio or remote (`url`, `headers`) |

A repository's own hooks, allow rules, MCP servers, and `!` commands run only after `jean trust` — opening a cloned repository must not run its author's commands.

---

## Edits

`edit` accepts the `old_string` → `new_string` form models are trained on, with a matcher that tolerates the slips they make — wrong indentation, collapsed whitespace, escaped newlines — re-indents the replacement to fit, refuses ambiguity, and, when nothing matches, shows the closest region of the file so the retry is built from what is there. Several replacements can go in one atomic call.

It also accepts hashline patches. `read` returns every line with its number and a content-hash anchor:

```
41 h:3f8a2b1c │ export class RateLimiter {
42 h:9c1de470 │   private counter = 0;
```

An edit can cite the anchor:

```
anchor: h:9c1de470 -> "private counter = 0;"
patch: |-|
  - private counter = 0;
  + private counter = new Map<string, number>();
```

Because the anchor is a hash of the *whitespace-normalized* line, it survives re-indentation, and inserted lines are re-indented to match the file they land in. If the file moved on since the read, the applier recovers from the quoted anchor text, then from the hunk's own context, instead of failing with a "string not found" loop.

This is implemented twice — [`crates/hashline`](crates/hashline/src/lib.rs) in Rust and [`packages/tools/src/hashline.ts`](packages/tools/src/hashline.ts) in TypeScript — so the CLI works with or without a native build. [`tests/parity.test.ts`](tests/parity.test.ts) feeds identical fixtures to both and asserts the output is byte-identical, because a divergence here would corrupt code rather than merely disagree.

---

## Permission model

| Mode | Behaviour |
|---|---|
| `auto` (default) | Acts freely; confirms only destructive operations |
| `ask` | Confirms every write and every command |
| `plan` | Read-only — mutating tools are not even advertised to the model |
| `full` | Never confirms |

Destructive commands (`rm -rf`, `git reset --hard`, `git push --force`, …) stop for confirmation in every mode except `full`, and a hard deny list (`rm -rf /` and friends) never runs at all. In a non-interactive run, a gated call is **refused**, never assumed-approved.

Zero telemetry. Nothing leaves your machine except the requests you configured to a model provider.

---

## Configuration

`~/.jean/config.json` globally, `.jean.json` per project. Six layers, lowest to highest:

```
defaults → imported foreign config → global → project → environment → flags
```

On first run Jean Code reads configuration that already exists for eight other agents — Claude Code, Cursor, Windsurf, Gemini CLI, Codex, Cline, Copilot, VS Code — so a repo already used with one of those keeps its rules and MCP servers with no migration step.

```jsonc
{
  "model": { "provider": "openrouter", "modelId": "anthropic/claude-sonnet-4.5" },
  "agents": {
    "default": { "maxTokens": 8192 },
    "smol": { "model": "openai/gpt-4o-mini" },
    "advisor": { "model": "anthropic/claude-opus-4.1" }
  },
  "permissionMode": "auto",
  "memory": { "backend": "sqlite" }
}
```

Agents ask for a **role** (`default`, `smol`, `slow`, `advisor`, and six more) rather than a model, so retargeting every reviewer to a different model is one line of config.

---

## As a library

```ts
import { createAgent } from '@jean/sdk'

const agent = await createAgent({ cwd: process.cwd() })
const result = await agent.send('add a health check endpoint')

console.log(result.text, result.files)
agent.close()
```

Register your own tools, subscribe to the event stream, or drive sub-agents directly. See [`packages/sdk`](packages/sdk/src/index.ts).

---

## Layout

```
crates/          Rust core, wired into the runtime (see docs/STATUS.md)
  pi-walker/     Parallel ignore-aware walk and search — glob, grep, every walk()
  hashline/      Content-hash anchors and patches — read and edit
  pi-ast/        Structural search and outlines — ast_grep, codemap_outline
  pi-builtins/   58 coreutils — the text tool, the embedded shell
  pi-shell/      Shell parser and executor — command safety, permission rules, no-bash fallback
  pi-iso/        Snapshot copies with three-way merge — sub-agents and the arena outside git
  snapcompact/   Reversible compaction — the archive behind recall_archive
  pi-sys/        Process trees, keep-awake, clipboard — bash kills, long runs, /copy
  pi-tokens/     Token counting — the auto-compaction threshold
  pi-voice/      WAV analysis and preparation — read, transcribe
  pi-mnemopi/    Append-only memory log with BM25 — the default memory backend
  pi-natives/    The bridge binary (JSON lines over a pipe)
  pi-ffi/        The same bridge as an in-process library, for synchronous calls
packages/        25 TypeScript packages
  config/        Six-layer config resolution, 8-format import
  model/         15 providers, 3 wire protocols, roles, fallback, streaming
  core/          EventStore, agent loop, context management, compaction
  tools/         Tool registry, file ops, search, shell, permission gating
  agent/         Orchestrator, specialized agents, sub-agent fan-out
  memory/        pi-mnemopi log by default; SQLite + FTS5 and JSONL fallbacks
  native/        The typed bridge to crates/, with per-method call counts
  lsp/           Language servers: 18 registered, 6 agent tools
  tui/           Full-screen renderer, raw-mode input, tool cards
  cli/           The `jean` binary
  ...            teams, subagents, advisor, git, skills, mcp, execution, sdk, ...
tests/           Unit, cross-language parity, and end-to-end suites
docs/            Status, architecture notes
```

Every package documents what it does and, where it is incomplete, says so in its own module docs.

---

## Develop

```bash
bun install
bun test              # TypeScript tests, including tests/native-wiring.test.ts
cargo test --workspace # Rust tests
bun run jean native test # each crate through the bridge, with what it saw
bunx tsc --noEmit -p tsconfig.json
bun run jean          # run the CLI from source
```

The end-to-end suite ([`tests/e2e.test.ts`](tests/e2e.test.ts)) runs the real `jean` binary against a real HTTP model server, so it exercises flag parsing, config resolution, the provider adapter, SSE reassembly, the agent loop, and the tool harness as one system.

---

## License

MIT. The full-screen interface in `packages/tui` is derived from Codebuff (Apache-2.0); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
