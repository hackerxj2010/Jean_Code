# Jean Code and OpenCode 2.0

What OpenCode had in September 2026 — the 2.0 line (2.0.4 to 2.0.16, released 16–24 September) and the 1.18 releases before it — set against Jean Code, and what was built here to close the gap. Researched on 2026-09-25 from OpenCode's documentation (`opencode.ai/docs`: CLI, TUI, providers, models, Zen), its GitHub releases, and the 2.0 announcement coverage.

## What 2.0 changed

2.0 is mostly a rebuild: a redesigned server API, a move from Bun to Node for the server's memory use, the desktop app moved from Tauri to Electron, the agent running as a background service by default, several sessions open at once in tabs (each on its own model), skills that load without a restart, a wider plugin API, and voice input. The 1.18 line before it added reasoning-effort variants, resumable sub-agent calls, JSON export of whole sessions, a command palette that finds sessions, and more providers.

## The comparison

| OpenCode | Jean before | Now |
|---|---|---|
| 75+ providers from models.dev, picked with `/connect` | 16 built-in providers, a bundled list of 30 models | **The models.dev catalog** (223 providers, 8,000+ models), cached in `~/.jean/cache/models.json` and refreshed daily in the background; every provider whose wire format Jean speaks is usable — 200 and more |
| OpenCode Zen (`opencode/…`), four API families behind one key | — | **`opencode` and `opencode-go`** built in, routed per model: Claude over Anthropic Messages, GPT over OpenAI Responses, Gemini over Google's API, the rest over Chat Completions |
| `@ai-sdk/openai` (Responses API) | Chat Completions only | **An OpenAI Responses adapter**, with encrypted reasoning handed back between turns (`store: false`) |
| `/models` picker, recent models | `/models` printed a table | **A searchable picker** in place of the prompt: the model in use, favorites (Ctrl+F), recent, then every connected provider's models; Tab to providers |
| `/connect`, `opencode auth login/list/logout`, `auth.json` | `/connect <id> <key>` wrote the key into the config file | **`/connect` picker** with masked key entry; **`jean auth login/list/logout`**, keys checked against the provider and kept in `~/.jean/auth.json` (0600) |
| `opencode models [provider] --refresh --verbose` | `jean models` listed the bundled table | **`jean models [provider] [text] --all --free --refresh --verbose`** and **`jean providers [--all]`** |
| Default model: flag → config → last used → first provider | Flag → config → OpenRouter default | **The same order**: with no model configured and no key for the default provider, the model picked last, else the first connected provider's recommended model — small and large roles moved along |
| Custom providers, `whitelist`/`blacklist` | `providers.<id>.baseUrl` overrode a known provider only | **A provider of your own** from `baseUrl` + `api` (`chat`, `responses`, `anthropic`, `google`) + `models`; whitelist and blacklist in the pickers |
| `OPENCODE_CONFIG_CONTENT` | — | **`JEAN_CONFIG_CONTENT`** |
| Reasoning-effort variants, `variant_cycle` | `--effort`, `/effort` in the line CLI | **`/effort`** in the full-screen interface too, cycling when given nothing |
| Runs as a service; `serve`, `web`, `attach`, `run --attach` | `serve [mcp\|acp]` in the help, not wired | **`jean serve`**: sessions over HTTP, several at once, streamed as server-sent events, permission questions sent to the watching client, a password required off this machine; **`jean attach`** and **`-p … --attach`**; **`jean serve acp`** and **`jean serve mcp`** wired |
| Parallel sessions in tabs | One session per terminal | Several sessions at once through `jean serve`, each attachable from its own terminal. **Tabs inside the full-screen interface are not built.** |
| `opencode session list/delete`, `export [--sanitize]`, `import` | `jean sessions` (list) | **`jean sessions [delete\|rename\|fork]`**, **`jean export [--sanitize] [-f text]`**, **`jean import <file\|url>`**, `/export` in both interfaces |
| `--continue`, `--fork` | `--resume [id]` | **`--continue`** and **`--fork`** |
| `opencode stats` | `/context` for one session | **`jean stats [--days N] [--all] [--verbose]`**: tokens, cost, by model, by tool, by day; `/stats` for this session |
| `/undo`, `/redo` | `/rewind`, `/undo` | **`/redo`**, files and conversation both |
| `/compact`, `/sessions` in the TUI | Line CLI only | **Both interfaces** |
| Resumable sub-agent calls (`task_id`, 1.18.20) | A sub-agent's work was lost with its report | **`spawn` returns a `task_id`**; passing it back continues the same agent with everything it read |
| Skills hot-reload (2.0) | Re-read only after `skill_save` | **Read again whenever a SKILL.md is added or changed**, checked before each turn |
| `opencode agent create/list` | `/agents` (list) | **`jean agents [create]`** |
| `opencode mcp add/list/…` | `/mcp` (list) | **`jean mcp [add\|remove]`** |
| `opencode pr <n>` | `pr://123` readable | **`jean pr <n>`**: checks the PR out with `gh`, then the session |
| `opencode upgrade` | — | **`jean upgrade [--check]`**, which refuses a checkout with uncommitted work |

## Where Jean was already ahead

Things OpenCode does not have, or has less of: a Rust core wired end to end (search, edits, the shell, LSP for 79 servers, DAP verified on real debuggers), a debugger the agent drives, hashline edits, the arena (best of N attempts), swarm mode, `--verify` goals, cross-session memory, code maps, Telegram/Discord/Slack/email/Matrix/Signal/WhatsApp/SMS gateways, voice capture and transcription, PDF/SSH/`pr://` reading, and Claude Code's hooks, skills, agents, and commands formats read as they are.

## Not done, and why

- **Tabs inside the full-screen interface.** Parallel sessions work through `jean serve` and `jean attach`; switching between live sessions inside one full-screen window needs the interface's chat state split per session, which it is not yet.
- **OpenCode's free Zen tier.** Its free models answer only OpenCode's own client (`FreeTierError`); Jean does not pretend to be it. With a Zen key, the free-priced models work like any other.
- **Sign-ins that are not API keys**: GitHub Copilot's device flow, ChatGPT and Claude subscriptions over OAuth, Amazon Bedrock's request signing, Google Vertex service accounts, Azure deployments. The catalog lists those providers and marks them; Jean does not speak their sign-in yet. Pointing `providers.<id>.baseUrl` at an OpenAI-compatible gateway in front of them works.
- **`opencode web`, the Electron desktop, `/share` links on opencode's servers.** `packages/web` and `packages/desktop` are reserved; a sanitized `jean export` is the shareable file.
- **`opencode uninstall`.** Removing Jean is deleting `~/.jean` and its checkout; a command that deletes user data without a way to test it safely was not added.
- **Node instead of Bun.** OpenCode moved for memory; Jean's heavy work runs in its Rust core, and Bun stays.
