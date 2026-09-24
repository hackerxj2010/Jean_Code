# Implementation status

The architecture document specifies roughly 340,000 lines across 27 packages. This is what actually exists, honestly categorized. Read this before relying on anything.

Three categories:

- **Working** — implemented and covered by tests that would catch a regression.
- **Partial** — the hard or load-bearing part is implemented; the rest is not.
- **Not built** — the interface is declared, and calling it reports that clearly rather than failing silently or quietly doing nothing.

---

## Working

### `@jean/config` — configuration
Six-layer resolution (defaults → imported → global → project → environment → flags), JSONC parsing, per-field validation that drops bad values with a message instead of failing the load, `${VAR}` expansion, `.env` reading that never shadows an exported variable, and import from eight other agents' config formats.

### `@jean/model` — the model layer
Fifteen providers across three wire protocols, spoken directly over `fetch` with no vendor SDKs:

- **OpenAI Chat Completions** — OpenRouter, OpenAI, xAI, DeepSeek, Mistral, Groq, Cerebras, Fireworks, Together, Nebius, SiliconFlow, Ollama, vLLM, llama.cpp
- **Anthropic Messages** — including extended thinking
- **Google Gemini** — `generateContent`, with JSON-Schema sanitization for keywords Gemini rejects

Plus streaming with SSE reassembly across chunk boundaries, ten model roles, fallback chains that fire on transport failures but not on auth errors, retries with jittered backoff honouring `Retry-After`, mid-stream rules, and a bundled model catalog covering the September 2026 generation (Claude Opus 5.5/Sonnet 5, GPT-5.x, Gemini 3.x, DeepSeek V4, and others), with their real context windows.

**Prompt caching.** Anthropic requests carry cache breakpoints on the system prompt (which covers the tools) and the last two user messages; through OpenRouter, Claude models get breakpoints on the system prompt and last user message. Cache reads and writes are counted in `usage`. Other providers cache automatically. **Thinking replay.** Signed (and redacted) Anthropic thinking blocks are captured from the stream and sent back, which extended thinking with tool use requires — before, the first tool call at `high` effort would have been rejected. [`tests/providers.test.ts`](../tests/providers.test.ts) pins the wire formats.

Defaults: `anthropic/claude-sonnet-5` with a 32K output ceiling, Haiku 4.5 for the cheap roles, Opus 5.5 for `slow` and `advisor`, and a 200-turn cap.

### `@jean/core` — the agent loop
`EventStore` as the single source of truth, with the model transcript *derived* from events rather than stored separately — which is what makes rewind a truncation, resume a replay, and compaction an event. Multi-turn loop with tool execution, turn caps, and interruption. Auto-compaction at a context threshold with a deterministic fallback that runs when the summarizer model is unavailable; the task list and changed files are appended to the summary verbatim so they survive it exactly. Session persistence as newline-delimited JSON.

The loop behaviours that decide whether a task gets finished, each covered by [`tests/loop-behaviors.test.ts`](../tests/loop-behaviors.test.ts):

- **Parallel reads.** Consecutive parallel-safe calls in one turn run concurrently; a mutating call is a barrier. Tools declare `concurrency` (default from `risk`); `ask`, `todo`, the browser, and the debugger opt out; `spawn` and MCP tools opt in.
- **Truncation recovery.** A response cut off by the output limit is continued (bounded) instead of being returned as the answer; a tool call cut off mid-way is reported as such. Both adapters report `length` rather than `tool_use` for a truncated call.
- **Repeat detection.** Three identical failing calls, or five identical calls, and the model is told it is looping, with the error quoted.
- **Transient-failure retries.** A rate limit or overloaded provider is waited out (5s, 15s, 30s, 60s, interruptible) rather than ending a long run.
- **Interrupt safety.** Every issued tool call gets a result, so an interrupted turn never leaves the transcript in a shape the provider rejects on the next message.
- **Hook seams.** `beforeTool` (deny, rewrite, approve, ask), `afterTool` (annotate), `beforeStop` (keep working), `beforeCompact`, and per-turn `reminders`, delivered to the model as `<system-reminder>` messages.
- **Stable, cacheable system prompt.** Per-prompt context (memories, skills, `@` mentions, hook output) rides in a reminder after the user's message instead of the system prompt, and the repository snapshot is taken once per session.
- **Freshness.** Files the agent read or wrote that change on disk afterwards are named to it before its next request.
- **File history.** The first change to each file in a turn is captured, so `/rewind` restores files and truncates the conversation together.

The system prompt ([`prompt.ts`](../packages/core/src/prompt.ts)) states a workflow, the verification rules (evidence over assertion, never weaken a test), tool-batching guidance, shell hygiene, and an "unattended" section for headless runs. Instruction files are discovered from every ancestor directory (`AGENTS.md`, `CLAUDE.md`, `JEAN.md`, `*.local.md`, `.claude/CLAUDE.md`) plus the user's `~/.jean/JEAN.md` and `~/.claude/CLAUDE.md`, with `@path` imports.

### `@jean/tools` — the tool harness
Central registry with permission gating, JSON-Schema argument validation, and per-call audit. Tools: `read` (line numbers plus the hashline anchor gutter), `write`, `edit`, `glob`, `grep`, `bash`, `bash_output`, `todo`.

`edit` takes three forms: `old_string`/`new_string` (the shape models are trained on), an atomic `edits` batch, or a hashline `patch`. Replacement runs a matcher cascade — exact, indentation-insensitive, whitespace-collapsed, escape-decoded, boundary-trimmed, and first/last-line block anchoring — that refuses ambiguity, maps the model's indentation onto the file's at every nesting level, preserves CRLF, and, when nothing matches, shows the closest region of the file with differing lines marked. The result shows the edited region with anchors, so a follow-up edit needs no re-read. See [`tests/replace.test.ts`](../tests/replace.test.ts).

Command output past 30K characters keeps its start *and* its end (where the verdict is), and the full text is saved to a file `read` may open.

Notable behaviours that are tested, not incidental:

- `edit` refuses a file that has not been read this session — its content would be a guess.
- `write` refuses to clobber an unread non-empty file.
- Paths that escape the project root are refused.
- The shell session's working directory persists across calls, including on Windows where Git Bash reports MSYS paths that `spawn` cannot use.
- Deny-listed commands never run; confirm-listed ones stop even in `auto` mode.
- Permission rules from `ToolContext.policy` are consulted before the mode, so a deny rule holds in `full` mode and for reads.

### Hashline — the edit primitive
Implemented twice: [`crates/hashline`](../crates/hashline/src/lib.rs) (Rust, dependency-free including its own SHA-256) and [`packages/tools/src/hashline.ts`](../packages/tools/src/hashline.ts) (TypeScript). Whitespace-normalized content-hash anchors, stale-anchor recovery through anchor text then hunk context, ambiguity resolution, automatic re-indentation of inserted lines, and multi-hunk line-drift tracking.

[`tests/parity.test.ts`](../tests/parity.test.ts) runs 17 fixtures — including ambiguous anchors, malformed patches, unicode, tabs, and files with no trailing newline — through both implementations and asserts byte-identical output.

### `@jean/memory` — persistent memory
SQLite with an FTS5 index kept in sync by triggers, ranked by relevance blended with recency, scoped per project. A JSONL backend as fallback, and a null backend. Resolves `bun:sqlite` or `node:sqlite` at runtime so it works under either runtime.

### `@jean/agent` — orchestration
Session orchestrator owning the store, registry, and tool context. Six specialized sub-agent definitions, each with its own model role and its own *tool surface* — a librarian that cannot write files cannot "helpfully" fix what it was reviewing. The roster is deliberately small: a sub-agent only pays for itself when it reads a great deal and reports a little, so the ones that edited, reasoned, or ran a command were removed and the main agent does that work itself. Sub-agent fan-out with depth limits; several `spawn` calls in one turn run in parallel, and sub-agents are bound by the parent's permission rules. Magic keyword detection applying per-turn, never per-session.

On top of that:

- **Custom agents** from `.jean/agents/*.md` and `.claude/agents/*.md` (Claude Code's format: `name`, `description`, `tools`, `model` with `sonnet`/`opus`/`haiku`/`inherit` mapped onto roles) join the `spawn` roster.
- **Goals.** `verify` (`--verify`, `/goal`) names a command that must pass before the agent may stop; each failure is handed back with its output, up to 25 times.
- **Rewind.** `/rewind [n]` and `/undo` restore the files the last turns edited and truncate the conversation. Changes made through the shell are not tracked.
- **Arena.** `jean arena` / `/arena` runs N attempts in parallel worktrees (the first as configured, the rest hotter or on other models), judges them with the verify command, and merges the smallest passing change, uncommitted. [`tests/arena.test.ts`](../tests/arena.test.ts) drives it with scripted attempts.
- **`@` mentions.** `@path` in a prompt attaches the file (counted as read) or lists the directory.
- **Images.** `send(prompt, { images })` carries pasted images to the model; the TUI used to reduce them to "[1 image attached]".
- **MCP** servers from config are connected at the first prompt, in parallel; project-defined ones only in trusted projects.

### `@jean/hooks` — permission rules and hooks
Claude Code's formats, so an existing `.claude/settings.json` means the same thing here. Rules — `Bash(npm test:*)`, `Read(./.env)`, `Edit(src/**)`, `WebFetch(domain:x)`, `mcp__server`, `Tool(param:value)` — evaluate deny, then ask, then allow. An allow rule never covers a chained command (`npm test && curl … | sh`); a deny rule catches the command anywhere in a chain. Hooks — `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`, `PreCompact`, `Notification` — run as shell commands with the JSON stdin/exit-code protocol, see Claude Code's tool names and `tool_input.file_path`, run matching hooks in parallel, and are killed at their timeout.

Project-level hooks, allow rules, MCP servers, and `!` commands apply only in projects trusted with `jean trust`: a cloned repository must not be able to run its author's commands just by being opened. Project deny and ask rules always apply.

### `@jean/commands` — custom slash commands
Markdown commands from `.jean/commands` and `.claude/commands` (user and project), namespaced by folder, with `$ARGUMENTS`, `$1`–`$9`, `@file` inlining (never credentials or files outside the project), and `` !`cmd` `` execution (trusted projects only). Available in the CLI, the TUI, headless `-p "/name"`, and to the model through `slash_command` unless a command opts out.

### `@jean/cli` — the binary
Flag parsing from a table that also generates `--help` and the bash/zsh/fish completions, so they cannot drift. Interactive readline sessions (line-buffered, so a piped script runs every command rather than only the first), one-shot mode with `text`, `json`, or `stream-json` output (one event per line, deltas coalesced per block), slash commands including `/goal`, `/rewind`, `/undo`, `/arena`, `/commands`, `/agents`, `/hooks`, `/mcp`, `/trust`, and the subcommands `doctor`, `config`, `models`, `memory`, `sessions`, `skills`, `plugins`, `arena`, `trust`, `untrust`, plus resume that carries prior context into a one-shot run.

The entry point loads a command's code only when that command runs: `jean --version` takes about a third of a second instead of loading the whole agent.

An explicit `--config <file>` is authoritative: it replaces the global file and suppresses `.jean.json`, so a pinned configuration cannot be silently overridden. All config output is redacted — API keys print as `sk-ant-a...w9q2`, never in full.

### `@jean/execution`
Local backend and a Docker backend that translates the security config into real `docker run` hardening: read-only root with a tmpfs `/tmp`, dropped capabilities plus `no-new-privileges`, PID limits, optional network isolation.

### `@jean/git`
Status, diff, log, and commit as agent tools, always via `execFile` with an argument array so model-supplied strings never reach a shell. Commit grouping by package, with locale-independent ordering.

### `@jean/skills`
Discovery from project and user directories (including `~/.claude/skills` and `.claude/skills`), YAML front-matter parsing, relevance matching with a deliberately high bar, and prompt rendering. Reads the same format other agents use. The `skill` tool lists every skill's name and description and loads a body on demand; `skill_save` lets the agent write down a procedure it worked out, to the user's library or the project's, usable in the same session.

### `@jean/teams`
Cross-process file locking with stale-lock recovery, a shared task list with atomic claiming, dependency ordering, and file-level partitioning so two teammates never receive tasks touching the same file. Mailbox with once-only delivery.

### `@jean/subagents`
Git worktree isolation, plus JSON extraction and schema validation for structured sub-agent results. A worktree starts from the working tree as it is — uncommitted and untracked changes included — with `node_modules`/`.venv` linked in so tests can run. Work comes back by file-level three-way merge into the working tree, **uncommitted**: nothing is committed to the user's branch, and a file both sides changed is refused, not merged with markers. Dependency links are removed before any deletion, and a test proves the real `node_modules` survives.

(Previously a worktree started from `HEAD`, so a sub-agent could not see the parent's uncommitted edits, and merging back used `git merge`, which put commits on the user's branch.)

### `@jean/advisor`
The watcher: prompt, response parsing, level thresholds, escalation, and deduplication. Wired into the orchestrator, running after each turn. On by default in autonomous mode.

### `@jean/mcp`
Client over three transports — stdio, Streamable HTTP (JSON or SSE-framed replies, `Mcp-Session-Id`, protocol-version header), and the older HTTP + SSE — with an untyped `url` trying the first and falling back to the second. `headers` with `${ENV}` expansion carry tokens. Paginated tool discovery with allow/deny filtering, parallel connection with a timeout, and adaptation into registry tools. [`tests/mcp-client.test.ts`](../tests/mcp-client.test.ts) runs each transport against a real server.

Until this session nothing called the client: servers were configured (and imported from `.mcp.json`) but never connected. The orchestrator now connects them at the first prompt. OAuth for remote servers is not implemented; use a token header.

### `@jean/sdk`
Embeddable agent — create, send, spawn, register tools, read events, resume.

### `@jean/tui` — the full-screen interface
A React interface rendered through `@opentui`, **derived from Codebuff's CLI** (Apache-2.0; see [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)). Jean's agent sits behind it through `src/compat/`, which translates `LoopEvent`s into the events the interface renders and tool names/results into the shapes its components read ([`tests/tui.test.ts`](../tests/tui.test.ts) pins that translation). Jean's session commands — `/goal`, `/rewind`, `/undo`, `/arena`, `/hooks`, `/mcp`, `/agents`, `/commands`, `/trust` — are in its palette, custom commands pass through to the agent, and pasted images reach the model.

It does not typecheck cleanly: about 300 errors, inherited from the port, none of which stop it rendering (`bun packages/tui/smoke.ts` drives it in a real terminal). `packages/tui2` is a near-identical copy kept for side-by-side comparison. An earlier hand-written differential renderer that this section used to describe no longer exists.

It takes over only on a real TTY. Piped output, a dumb terminal, or `--no-tui` gets the line-based renderer in `@jean/cli`.

### `@jean/lsp` — language server integration
Content-Length framed JSON-RPC (LSP's own framing, not the newline form `@jean/acp` and `@jean/mcp` use), a registry of 18 language servers with binary and root-marker detection, lazy per-(server, root) startup, full-text document sync, and six agent tools: `lsp_diagnostics`, `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_symbols`, `lsp_rename`.

This is the capability that separates reasoning about *code* from reasoning about *text*: `grep` for a symbol matches comments, strings, and unrelated identifiers, and misses aliased imports; `lsp_references` returns the bindings that actually resolve. Tools address code as `(line, symbol)` rather than LSP's zero-based columns, because models are reliable about the former and not the latter — and resolving the column by searching the line also catches a stale line number before it produces a confidently wrong answer.

Servers start only when a file they handle is touched *and* a root marker for them exists, so opening one `.py` file in a Go monorepo does not launch a Python server against the wrong root. A server that fails to start is reported once and not retried per file.

Verified against a live `typescript-language-server`: definition (resolving through imports), references (all bindings across files), hover, and document symbols. **Diagnostics are not verified** — see below.

### `@jean/dap` — the debugger
The full 28 operations of architecture §8.3 over Content-Length framed DAP. Six adapters registered, covering the three targets the architecture names: `lldb` for a C segfault, `dlv` for a hung Go service, `debugpy` for wedged Python.

Exposed to the agent as five tools rather than twenty-eight: an agent does not want the protocol, it wants to answer "why is this wrong". `debug_inspect` therefore returns the stack *and* the live variables of a frame in one call, because the alternative is three round trips to learn one thing. Expensive scopes (globals) are skipped, and an unverified breakpoint is reported as an error — an unverified breakpoint never fires, silently, and the agent would otherwise conclude the code is unreachable.

### `@jean/coreutils` — in-process shell utilities
`head`, `tail`, `wc`, `sort`, `uniq`, `cut`, `paste`, `join`, `comm`, `tr`, `sed`, `awk`, `fold`, `fmt`, `expand`, `unexpand`, `nl`, `column`, `rev`, `shuf`, `seq`, `yes`, `jq`, `bc`, `diff`, `xargs`, `tee`, `date`, `env`, and the path utilities — as pure functions over strings, composed by a `text` tool.

Zero fork/exec is the stated benefit; the larger one is that `jq`, `sed`, and `awk` are frequently absent on Windows, so an agent that learns to rely on them breaks the moment it runs somewhere else. `bc` is a recursive-descent parser rather than `eval`, because the expression reaches it from a model and `eval` on model output is arbitrary code execution with extra steps.

`sed` and `awk` implement the subsets pipelines actually use and report anything else as unsupported, rather than silently doing nothing.

### `@jean/codemap` — repository intelligence
Indexes what the codebase declares and where, across 15 languages, so the agent can find the files a task touches without reading them. In a large repository, locating the handful of relevant files by reading is the single largest waste of context an agent commits — and it usually finds the wrong ones.

The architecture specifies tree-sitter with 50+ grammars. Tree-sitter is a native dependency and this build has none, so this is a per-language pattern scanner instead. The difference is real and worth stating: a parser knows a declaration from a mention inside a string, and this does not, always. What makes it useful anyway is the job — a false positive costs one wasted `read`, where a parser would cost a native build step on every platform. `@jean/lsp` provides exact resolution where it matters.

Ranking puts a symbol match well above a filename match, because a developer describing a task names the things it touches.

### `@jean/runtime` — persistent kernels
Long-lived Python and JavaScript interpreters with state that survives between calls, and a loopback bridge letting kernel code call back into agent tools (`jean.read`, `jean.grep`, `jean.task`) — routed through the same registry, so those calls are gated exactly like any other.

Executions are serialized: one interpreter means one execution at a time, and without the queue concurrent calls interleave and lose writes. A wedged kernel is replaced rather than waited on — losing session state is bad, hanging the agent is worse.

### `@jean/readers` — extended `read` targets
ZIP and TAR (including gzip and GNU long names), Jupyter notebooks, SQLite, and CSV. Parsed in-process rather than shelled out to, because `unzip`, `tar`, and `sqlite3` behave differently across platforms and none reliably exists on Windows.

The `sql` tool is read-only twice over: the connection is opened read-only *and* the statement is checked, including a refusal of stacked statements, which is how a read-only check normally gets bypassed.

### `@jean/scheduler` — cron, one-off, and trigger runs
A 5-field cron parser, next-fire calculation, a persisted schedule store, and a daemon that fires them.

The daemon polls a persisted `nextRunAt` rather than holding a timer per schedule. Timers drift across a laptop suspend and must be rebuilt on every edit; polling persisted state is correct across both and survives the process being killed — which matters, because a daemon that forgets what it was waiting for is worse than none, since the user believes it is running. A schedule is marked fired whether or not it succeeded, so a failing one is not a runaway; a paused one re-arms from now rather than firing once per missed interval on resume.

### `@jean/acp` — Agent Client Protocol
Newline-delimited JSON-RPC with correlation and notification dispatch, plus session serving: `initialize`, `session/new`, `session/prompt` with streamed `session/update` notifications, and `session/cancel`.

The protocol is editor-driven — the editor owns the UI, so streamed output travels as notifications back to the client rather than as terminal writes. That inversion is why it cannot reuse the CLI's session loop. Capabilities advertise only what is implemented: claiming more makes the editor send requests nothing answers, which reads as a hang.

### `@jean/search` — the web search chain
Ten providers tried in order until one answers. Keyless providers (DuckDuckGo, Wikipedia, Stack Overflow, GitHub, arXiv) are in the chain, so an unconfigured install still searches — a chain whose first working link needs a paid account is a paid dependency with extra steps. A provider missing its key is skipped rather than attempted, costing no latency.

Results always carry their source URL: an agent that summarizes search results without sources produces text nobody can check. `web_fetch` refuses non-http schemes, since `file:` would turn it into an arbitrary file read that bypasses the workspace boundary and the credential-file refusal.

### `@jean/collab` — live session sharing
Frames sealed with AES-256-GCM before they reach the transport, so the relay routes without being able to read. Three properties hold structurally rather than by policy: sealing lives in a module the transport cannot bypass; an invite link grants viewing and never control; and a sender's permissions are enforced on *receipt*, because a modified guest client will send anything.

Replay detection by per-sender sequence, per-participant rate limiting, single-use expiring invites with the key in the URL fragment so it stays out of server logs, and host authority bound to a participant id carried in the invite — because everyone in a session holds the same key, so the key proves membership and not authority.

### `@jean/projects` — knowledge base and retrieval
Structural chunking (code splits at declaration boundaries, Markdown at headings, each chunk carrying the symbol or heading path it sits under) with BM25 retrieval over an inverted index.

No embedding model, deliberately: that would mean a network call per chunk on every reindex, a second provider's API key, and a vector store to maintain. For a codebase — where the query is usually a symbol, an error string, or a path — lexical retrieval is also *better*, because those are exact matches an embedding blurs. Identifier splitting (`runAgentLoop` is findable as "agent loop"), path boosts that demote `node_modules` and fixtures, and a mild recency boost close most of the remaining gap.

Incremental: a file whose mtime has not changed keeps its chunks, and a deleted file leaves the index on the next build.

### `@jean/gateway` — multi-platform access
Four complete adapters — Telegram (Bot API long polling), Discord (Gateway WebSocket with heartbeats, resume, and REST sending), Slack (Socket Mode), and email (IMAP and SMTP spoken directly over TLS) — plus a message router and cross-platform session identity.

Each adapter is written against the wire protocol rather than a client library, which keeps the dependency count at zero and puts the failure modes in view: Discord's zombie connection when a heartbeat goes unacknowledged, Slack's three retries for an unacknowledged envelope, IMAP's interleaved untagged responses that a read-until-newline parser mixes up.

The identity layer is the substance here. "Start on Telegram, continue in your terminal" only means something if both resolve to the same session, and nothing in a Telegram user id says which terminal belongs to the same human. Binding is by an explicit, expiring, single-use six-digit code typed on both sides — never inferred from usernames, because guessing wrong hands one person's repository to another. Bots are closed by default: a Telegram bot's username is discoverable, so an open one is an open shell.

---

## Partial

| Package | Implemented | Missing |
|---|---|---|
| `@jean/plugins` | Discovery, validation, activation, tool and command registration | Hot reload |
| `crates/pi-shell` | Tokenizer, parser, expansion, executor; sessions that persist across calls | No functions, loops, or conditionals — they are refused by name (`brush-core`) rather than half-run |
| `crates/pi-iso` | Three-way merge over content-hashed snapshots, conflicts refused rather than resolved | Only the copy backend; APFS clonefile, reflink, overlayfs, and ProjFS are detected but not used |
| `crates/pi-voice` | WAV decode/encode, resampling, silence trimming, turn detection | WAV only, and no device capture — the host supplies the recording |
| `@jean/lsp` diagnostics | The pull and push paths are both implemented and the transport is tested | Unverified against a live server — see below |
| `@jean/dap` | All 28 operations, six adapters, tested against a mock adapter over real DAP framing | Unverified against a real debugger — none is installed here |
| `@jean/coreutils` | 30 utilities as pure functions — the `text` tool's fallback when the Rust core is not built | Not intercepted inside the system shell; the embedded `pi-shell` does run them in-process |
| `@jean/gateway` | Telegram, Discord, Slack, and email end to end; identity, routing, queueing | WhatsApp, Signal, Matrix, SMS |
| `@jean/readers` | ZIP, TAR, notebooks, SQLite, CSV | PDFs, URLs, SSH paths, and the `pr://` / `issue://` schemes |

**LSP diagnostics caveat:** `lsp_diagnostics` implements both LSP diagnostic models — pull (`textDocument/diagnostic`, 3.17) and push (`publishDiagnostics`) — and declares the client capability that makes a server advertise the pull form. Neither produced results on this machine: the installed `typescript-language-server` advertises no `diagnosticProvider` and publishes nothing on `didOpen` or `didChange` with TypeScript 6.0.3, and `rust-analyzer` resolves to an uninstalled rustup shim. So the code path is written but has never returned a real diagnostic. The other five tools are confirmed working against a live server. Treat diagnostics as unproven until it is tried against a server known to publish them.

**Plugin isolation caveat:** `PluginLoader` runs only plugins the user enabled by name, namespaces their tools so one cannot shadow `read` or `bash`, and disables a plugin that throws rather than retrying it. This is not a sandbox: a plugin is `import`ed into this process and can do anything Node can. The boundary limits accident, not intent — which is why activation requires naming the plugin rather than merely dropping it in a directory.

**Sub-agent isolation:** `spawnSubagent` runs a sub-agent that can *write* in its own git worktree, so two launched in parallel by `fanOut` cannot land in each other's edits. Isolation is decided from the tool surface rather than a flag — the surface is what actually constrains the agent — and skipped under `plan` permissions, where no mutating tool is reachable anyway. Read-only agents run in place: a worktree costs a git operation to isolate work that touches nothing.

A conflicting merge is refused, not resolved. The parent is told which files conflicted and the work is left on its branch, because guessing which of two edits was intended is how a merge quietly discards someone's work. Outside a git repository — or in one with no commits — `crates/pi-iso` makes the private copy instead: dependencies and build output left out, `node_modules` and virtualenvs linked back, and the merge planned against the snapshot so a file also changed in the main tree is a conflict, not an overwrite. The arena uses the same path, so it works in a plain directory too. Only a project over 20,000 files, or a machine without the Rust core, still runs in place.

### The Rust core, wired

Every crate in `crates/` backs a runtime feature, and each is exercised through
that feature's ordinary entry point by [`tests/native-wiring.test.ts`](../tests/native-wiring.test.ts),
which asserts the bridge's call counter for the method the feature must use. A
feature that silently took its TypeScript fallback fails there.

| Crate | What runs on it |
|---|---|
| `pi-walker` | `glob`; `grep` (a literal pattern is one parallel Rust search; a regex is matched in JavaScript over the Rust enumeration); every `walk()` — so the code map, structural search, the security scanner, and checkpoints |
| `hashline` | the anchors `read` shows and the patches `edit` applies — one implementation at both ends of the round trip |
| `pi-ast` | `ast_grep` (a token matcher: a metavariable takes a whole bracketed expression, a commented-out call is not a call); `codemap_outline` without building the index |
| `pi-builtins` | the `text` tool's pipeline, plus `grep`, `rev`, `fmt`, `shuf`, and checksums that only Rust has; the embedded shell's coreutils |
| `pi-shell` + `brush-core` | the deny list and the confirm list see each command as the shell parser does (`'r''m' -rf /` is `rm -rf /`, and `$(curl ...)` is a command); `Bash(...)` permission rules get the same list; bash runs in the embedded shell when no system shell starts, or with `shell.backend: "native"` |
| `pi-iso` | sub-agent and arena isolation outside git |
| `snapcompact` | every compaction archives the turns it replaces under a content hash; `recall_archive` reads them back |
| `pi-sys` | a timed-out, interrupted, or killed bash command is killed with its whole process tree; the machine is held awake during a run; `/copy` |
| `pi-tokens` | the auto-compaction threshold (calibrated for code, exact with `~/.jean/tokenizer.tiktoken`) |
| `pi-voice` | `read` on a `.wav` (length, level, speech segments); `transcribe` prepares the audio before a Whisper-compatible upload |
| `pi-mnemopi` | the default memory backend (an append-only log with BM25 recall), with memories from an existing SQLite store imported once |

Bugs this wiring surfaced and fixed on the Rust side: `walk.glob` and
`walk.search` read `limit` as a traversal cap, so a glob on a large tree
stopped before reaching its matches; an omitted `extraIgnores` replaced the
walker's defaults and walked into `node_modules`; `tr a-z A-Z`, `cut -f 1`,
`sort -k 2`, `awk -F :`, `fold -w`, and `shuf -n` read their option values as
file names; and anchors disagreed with the TypeScript port on the first line of
a file saved with a byte order mark.

**Transport.** `crates/pi-natives` is a binary speaking one JSON request per
line; `@jean/native` spawns it once and pairs replies by id (about 0.3 ms a
call). The memory backend's interface is synchronous, and running the binary
per call costs a process start — about 80 ms on Windows — so `crates/pi-ffi`
exposes the same `dispatch` as a library loaded through `bun:ffi`, which brings
a synchronous call down to microseconds. It is built under its own `ffi`
profile, which unwinds on panic: a panic is caught at the boundary and returned
as an error instead of aborting the agent.

**Discovery.** The binary ships with Jean Code, so it is looked up next to this
package — `JEAN_NATIVE_BIN`, then the checkout's newest build, then beside the
executable, then `~/.jean/bin` — never in the working directory, where running
whatever `target/release/pi-natives` a cloned repository contains would be code
execution on `cd`. It used to be looked up only there, which meant Jean run
outside its own checkout never used Rust at all.

**Optional, still.** Every feature keeps a TypeScript fallback, and
`JEAN_NATIVE=0` forces it; the wiring tests run both and compare. `jean native`
reports the build (and whether it is older than the sources or missing
methods), `jean native test` drives each crate once and prints what it saw,
`jean native build` builds both artifacts, and `/native` shows the calls made
in the current session.

---

## Reserved

Deliberately empty, being built separately. Each documents the integration
surface to build against rather than holding a stub to unpick:

| Package | Build against |
|---|---|
| `@jean/desktop` | `@jean/sdk` for the agent, `@jean/acp` if it should run out of process |
| `@jean/web` | `@jean/sdk` over a socket, `@jean/gateway`'s `IdentityStore` for auth, `@jean/lsp` and `@jean/codemap` for the editor panes |

---

## Not built

| Package | What it would be |
|---|---|
| `@jean/evals` | Trajectory export and a public benchmark harness |

`crates/pi-lsp` and `crates/pi-dap` are outside the workspace: `pi-lsp` declares modules that were never written and does not compile, and `pi-dap` has no source. Both jobs are done, and wired, by `@jean/lsp` and `@jean/dap`.

`crates/brush-core` was reserved to vendor the `brush` shell. It is superseded: `pi-shell` implements its own parser and executor, and vendoring a full bash would have brought a dependency tree larger than the rest of this repository. The crate stays as a pointer, and carries a check that names which constructs need a real shell.

Not started at all: computer control, image generation, and text-to-speech.

---

## Test coverage

```
929 TypeScript tests   bun test   (30 in tests/native-wiring.test.ts)
469 Rust tests         cargo test --workspace
```

Additionally verified by hand against a live OpenRouter key on 2026-08-28: real multi-turn tool use, hashline edits applied by a real model, cross-session memory recall, sub-agent delegation, plan-mode enforcement, destructive-command refusal, fallback chains, session resume, skill injection, and git tools. See the session notes for what that surfaced.

Verified live again on 2026-09-23 with `poolside/laguna-s-2.1:free`: parallel reads, an `old_string` edit chosen by the model unprompted, verification by running the check, a custom command in headless mode with `stream-json` output, and two free-tier rate limits waited out mid-run. The free model pinned in the repository's `.jean.json` (`minimax/minimax-m3:free`) is no longer free on OpenRouter and fails with a 404.

| Suite | Covers |
|---|---|
| `tests/loop-behaviors.test.ts` | Parallel batches, truncation, repeat detection, hooks, retries, interrupt pairing, compaction state |
| `tests/replace.test.ts` | The replacement matcher cascade, indentation mapping, CRLF, closest-match hints, the edit tool |
| `tests/providers.test.ts` | Cache breakpoints, thinking replay, truncation stop reasons, cache usage |
| `tests/hooks.test.ts` | Rule parsing and matching, chained-command safety, trust, real hook processes |
| `tests/extensions.test.ts` | Custom commands, custom agents, skill tools, `@` mentions, goals, rewind, prompt blocking |
| `tests/arena.test.ts` | Best-of-N selection and uncommitted merge |
| `tests/mcp-client.test.ts` | stdio, Streamable HTTP, HTTP + SSE, fallback, parallel connect |
| `tests/prompt.test.ts` | Instruction discovery and imports, prompt stability, the repository snapshot |
| `tests/hashline.test.ts` | Anchoring, recovery, re-indentation, parsing |
| `tests/parity.test.ts` | Rust ↔ TypeScript byte-identical output over 17 fixtures |
| `tests/config.test.ts` | Layering, validation, JSONC, foreign-format import |
| `tests/tools.test.ts` | Registry, gating, file ops, search, shell sessions |
| `tests/loop.test.ts` | Agent loop and EventStore against a scripted provider |
| `tests/packages.test.ts` | Skills, advisor, execution, git, teams, subagents, scheduler, plugins |
| `tests/lsp.test.ts` | LSP framing against a real subprocess, URI conversion, server selection |
| `tests/tui.test.ts` | The agent-to-interface translation: tool names, argument shapes, result shapes |
| `tests/isolation.test.ts` | Worktree snapshots of uncommitted work, uncommitted merge-back, conflicts, dependency-link safety |
| `tests/dap.test.ts` | DAP framing against a real subprocess, session lifecycle, breakpoints, stack and variables |
| `tests/coreutils.test.ts` | Every utility, the jq filter language, the bc parser, pipeline composition |
| `tests/codemap.test.ts` | Symbol extraction per language, indexing, ranking, incremental rebuild |
| `tests/runtime.test.ts` | Kernel lifecycle, state persistence, serialization, timeouts, the loopback bridge |
| `tests/readers.test.ts` | Notebooks, CSV quoting, SQLite read-only enforcement |
| `tests/archives.test.ts` | ZIP and TAR readers, against archives the test builds itself |
| `tests/gateway.test.ts` | Link codes, identity binding, routing, turn serialization |
| `tests/search.test.ts` | Chain fallback, key skipping, deduplication, HTML extraction |
| `tests/acp.test.ts` | Handshake, session lifecycle, streaming, disconnect handling |
| `tests/scheduler-plugins.test.ts` | Schedule firing and persistence, plugin activation and isolation |
| `tests/e2e.test.ts` | The real binary against a real HTTP model server |

Untested: everything in "Not built", and the sub-agent spawn path (it needs a live model to exercise meaningfully).
