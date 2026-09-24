# Jean Code — Complete Architecture Document

> **A coding agent that grows smarter every day. Terminal-first. Everywhere-accessible. Open by default.**

---

## Table of Contents

1. [Vision & Identity](#1-vision--identity)
2. [Design Principles](#2-design-principles)
3. [System Overview](#3-system-overview)
4. [Three Modes](#4-three-modes)
5. [Architecture Layers](#5-architecture-layers)
6. [Module Breakdown](#6-module-breakdown)
7. [Data Flow](#7-data-flow)
8. [Tool Harness](#8-tool-harness)
9. [Model Layer](#9-model-layer)
10. [Memory & Skills System](#10-memory--skills-system)
11. [Agent Teams Architecture](#11-agent-teams-architecture)
12. [Sub-Agent System](#12-sub-agent-system)
13. [Advisor Layer](#13-advisor-layer)
14. [Execution Layer](#14-execution-layer)
15. [Multi-Platform Gateway](#15-multi-platform-gateway)
16. [TUI / Desktop / Web UI](#16-tui--desktop--web-ui)
17. [Git & Platform Integration](#17-git--platform-integration)
18. [Browser & Desktop Control](#18-browser--desktop-control)
19. [Web Search Chain](#19-web-search-chain)
20. [MCP & Plugin System](#20-mcp--plugin-system)
21. [Scheduler & Automations](#21-scheduler--automations)
22. [Collaboration Mode](#22-collaboration-mode)
23. [Security Model](#23-security-model)
24. [Configuration System](#24-configuration-system)
25. [CLI Reference](#25-cli-reference)
26. [Slash Commands](#26-slash-commands)
27. [Internal URL Schemes](#27-internal-url-schemes)
28. [Tech Stack](#28-tech-stack)
29. [Directory Structure](#29-directory-structure)
30. [Build & Test Strategy](#30-build--test-strategy)
31. [LOC Budget](#31-loc-budget)
32. [Performance Targets](#32-performance-targets)
33. [Comparison Matrix](#33-comparison-matrix)

---

## 1. Vision & Identity

Jean Code is the most powerful AI coding agent in existence. It is not a chatbot. It is not a copilot. It is an autonomous agent that lives on your machine, understands your codebase, writes production-quality code, debugs with real debuggers, drives browsers, controls desktops, and collaborates with teams — all from a single terminal session.

### What Jean Code Is

- **A terminal-native coding agent** — primary interface is your terminal, where developers already live
- **An autonomous software engineer** — give it a goal, it plans, executes, tests, reviews, and commits
- **A multi-agent orchestration platform** — specialized agents collaborate, compete, and verify each other
- **A persistent personal agent** — remembers your preferences, projects, and environment across sessions
- **A multi-platform gateway** — accessible from CLI, desktop, web, Telegram, Discord, Slack, WhatsApp, Signal, and 15+ more platforms
- **An open-source platform** — zero telemetry, zero lock-in, fully auditable, MIT licensed

### What Jean Code Is Not

- Not an IDE plugin (though it integrates with editors via ACP)
- Not a cloud-only service (runs entirely on your machine, optional cloud)
- Not a single-model wrapper (1000+ models, 60+ providers, swap mid-session)
- Not a one-shot chatbot (persistent memory, skills, cross-session learning)

### Target Users

| Segment | Use Case |
|---|---|
| **Solo developers** | Write, debug, refactor, and ship code faster |
| **Engineering teams** | Collaborative coding with shared knowledge bases, agent teams, and automated reviews |
| **DevOps / SRE** | Automated incident response, infrastructure changes, deployment pipelines |
| **Researchers** | Batch trajectory generation, RL training, agent evaluation |
| **Platform engineers** | Embed Jean Code SDK into custom tools, build on the agent framework |

---

## 2. Design Principles

### 1. Best-of-Breed, Not Best-of-One

Every feature in Jean Code is the strongest implementation found across 9 existing agents. We don't reinvent — we extract, combine, and improve.

| Feature | Best Source | Why |
|---|---|---|
| Hashline edits | Oh My Pi | Content-hash anchored — 61% fewer tokens, no whitespace battles |
| Multi-agent pipeline | Codebuff | Specialized agents, best-of-N selection, arbitrary nesting |
| Agent Teams | Claude Code | Direct inter-agent messaging, shared task list, mailbox |
| Contract-driven execution | OpenFox | Immutable acceptance criteria, loops until all pass |
| Embedded bash + 58 coreutils | Oh My Pi | Zero fork/exec, in-process, sessions survive across calls |
| LSP + DAP wired in | Oh My Pi | 14 LSP ops + 28 DAP ops, drives real debuggers |
| Persistent memory | Hermes | Retain/learn/recall, FTS5 search, cross-session recall |
| Auto-compact | OpenCode | 95% context trigger, prevents OOM |
| Smart compaction | Codebuff | Non-lossy summaries after 5min idle |
| Multi-platform gateway | Hermes | 20+ platforms, single process, voice mode |
| Desktop control | Oh My Pi | Persistent JS against host, accessibility tree, screenshots |
| Browser tool | Oh My Pi | Stealth mode, Chrome relay, CDP attach |
| Atomic commits | Oh My Pi | Dependency-ordered, cycle detection, source-first scoring |
| Advisor layer | Oh My Pi | Second model watches every turn, injects blockers |
| OpenTUI React TUI | Codebuff | No flicker, hover/click, polished experience |
| 16 internal URL schemes | Oh My Pi | One interface for PRs, issues, conflicts, agents, skills |
| Skill auto-creation | Hermes | Writes SKILL.md from hard problems, self-improves |
| Plan approval | Claude Code Agent Teams | Read-only plan mode, lead approves/rejects autonomously |
| Effort slider | Claude Code | Interactive control over model reasoning depth |
| Fallback models | Claude Code | Up to 3 fallbacks tried in order |
| Vim-mode TUI | OpenCode | Full vim-style navigation in terminal |
| Codebase indexing | Codebuff | Tree-sitter scans, function/class/type extraction |
| Custom commands | OpenCode | Markdown-based, named arguments, user/project dirs |
| Mission Control | Cursor | Window manager view for multiple agents |
| Cloud agents | Cursor | Fleets of agents in parallel on ambitious tasks |
| Tab autocomplete | Cursor | Context-aware, predicts next action, not just characters |

### 2. Terminal-First, Everywhere-Accessible

The CLI TUI is the primary interface — where developers already live. But Jean Code is accessible from everywhere: desktop app, web IDE, Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Email, SMS, and 15+ more platforms. Start a conversation on Telegram while commuting, continue in your terminal at your desk.

### 3. Agent-Centric, Not Model-Centric

The unit of composition is an **agent**, not an LLM call. Agents have tools, prompts, roles, and behaviors. They spawn other agents, share context, and collaborate. Models are interchangeable — swap Sonnet for Opus mid-session, or route editors to Flash and reviewers to Opus.

### 4. Zero Lock-In

- **1000+ models** across 60+ providers — direct APIs, coding plans, gateways, local servers
- **Open standards** — MCP for external tools, ACP for editor integration, agentskills.io for skills
- **Open source** — MIT licensed, audit every line, contribute freely
- **Portable config** — imports from 8 formats (Cursor, Cline, Codex, Copilot, Windsurf, Gemini, Claude, VSCode)

### 5. Open by Default

Zero telemetry. Zero data collection. All memory stored locally. All processing on your machine. Optional cloud features (sandbox execution, hosted sandboxes) are opt-in and transparent.

### 6. Right Tool for Every Job

Three modes — focus, autonomous, swarm — give you the right level of agent intelligence for every task. Quick edit? Focus. Multi-file refactor? Autonomous. Entire service? Swarm. No over-engineering the default, no under-powering the extreme.

---

## 3. System Overview

Jean Code is composed of 5 architectural layers, each with clear responsibilities and well-defined interfaces:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Jean Code Ecosystem                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                     MULTI-PLATFORM GATEWAY                            │  │
│  │  CLI TUI │ Desktop │ Web │ Telegram │ Discord │ Slack │ WhatsApp │... │  │
│  └─────────────────────────────┬─────────────────────────────────────────┘  │
│                                │                                            │
│  ┌─────────────────────────────▼─────────────────────────────────────────┐  │
│  │                      AGENT ORCHESTRATOR                               │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────────┐   │  │
│  │  │ Main Agent  │  │ Agent Teams  │  │ Sub-Agent Fan-Out          │   │  │
│  │  │ (Lead)      │  │ (3-5 peers)  │  │ (unlimited depth)          │   │  │
│  │  └──────┬──────┘  └──────┬───────┘  └────────────┬───────────────┘   │  │
│  │         │               │                        │                     │  │
│  │  ┌──────▼────────────────▼────────────────────────▼──────────────┐   │  │
│  │  │                  SPECIALIZED AGENTS                           │   │  │
│  │  │  Editor │ Reviewer │ Researcher │ Thinker │ FilePicker │     │   │  │
│  │  │  Basher  │ CodeSearcher │ Planner │ + N custom agents       │   │  │
│  │  └───────────────────────────────────────────────────────────────┘   │  │
│  │  ┌───────────────────────────────────────────────────────────────┐   │  │
│  │  │                   ADVISOR LAYER                               │   │  │
│  │  │  Second model watches every turn → injects notes/blockers     │   │  │
│  │  └───────────────────────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                │                                            │
│  ┌─────────────────────────────▼─────────────────────────────────────────┐  │
│  │                        TOOL HARNESS                                   │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │  │
│  │  │ File Ops │ │  Shell   │ │   LSP    │ │   DAP    │ │ Runtime  │   │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘   │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │  │
│  │  │   Git    │ │ Browser  │ │   Web    │ │ Memory   │ │  Skills  │   │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘   │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │  │
│  │  │ Computer │ │  Image   │ │   TTS    │ │   MCP    │ │ Plugins  │   │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                │                                            │
│  ┌─────────────────────────────▼─────────────────────────────────────────┐  │
│  │                       EXECUTION LAYER                                 │  │
│  │  Local │ Docker │ SSH │ Daytona │ Modal │ Singularity                │  │
│  │  Security: read-only root │ dropped caps │ PID limits │ namespaces   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                │                                            │
│  ┌─────────────────────────────▼─────────────────────────────────────────┐  │
│  │                         MODEL LAYER                                   │  │
│  │  1000+ models │ 60+ providers │ 10 roles │ Streaming │ Auto-compact  │  │
│  │  Fallback chain │ Adaptive thinking │ Effort slider │ Mid-token rules│  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                     SCHEDULER + AUTOMATIONS                           │  │
│  │  Cron │ One-off │ Trigger-based │ Always-on │ Mobile push            │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Layer Responsibilities

| Layer | Responsibility | Key Decision |
|---|---|---|
| **Gateway** | Accept input from any platform, route to orchestrator | Single process, 20+ platforms, voice mode |
| **Orchestrator** | Manage agent lifecycle, mode selection, task coordination | Three modes: focus, autonomous, swarm |
| **Tool Harness** | Execute operations on files, shell, code, web, desktop | In-process Rust core + TypeScript tools |
| **Execution** | Run commands in isolated environments | Local default, optional cloud sandboxes |
| **Model** | Route LLM calls to providers, manage streaming | 1000+ models, 10 roles, fallback chain |

### Inter-Layer Communication

```
Gateway  ──JSON-RPC──►  Orchestrator  ──in-process──►  Tool Harness
                                                    ──FFI (Neon/N-API)──►  Rust Core
                                                    ──HTTP/gRPC──►  Model Layer
                                                    ──spawn──►  Execution Layer
```

- **Rust ↔ TypeScript**: FFI via Neon or N-API. Core exports file ops, shell, LSP, DAP, grep, glob as async JS functions.
- **Agent ↔ Teams ↔ Subagents**: In-process via shared EventStore. Cross-process via JSON-RPC.
- **Tool Registry**: Central registry routes tool calls to the right module. MCP tools and plugins register here.
- **Model Layer**: Provider-agnostic. Agents request a model by role; model layer resolves to actual provider/model.

---## 4. Three Modes

Jean Code operates in three intelligent modes, each designed for a different class of task. The mode determines how many agents are active, how they coordinate, and what orchestration strategy is used.

### Mode 1: `focus` — Default Mode

**"One agent, one conversation, zero friction."**

This is the default mode. You open Jean Code, you talk to one agent, it acts immediately. No spawning overhead, no orchestration complexity. This is where 80% of your work happens.

| Aspect | Detail |
|---|---|
| **Agent count** | 1 (main agent only) |
| **Context** | Full context window, auto-compact at 95% |
| **Model role** | `default` role — your configured primary model |
| **Tools** | Full tool harness: file ops, shell, LSP, DAP, git, browser, web search, memory, skills, MCP |
| **Subagents** | Available on-demand — agent spawns them when it needs focused work, results summarized back |
| **Advisor** | Off by default (toggle with `/advisor`) |
| **Best for** | Quick edits, debugging, code Q&A, single-file refactors, running commands, writing tests, PR reviews |
| **Entry** | `jean` (default) or `jean focus` |

**What happens in focus mode:**

1. You type a prompt in the TUI
2. The main agent reads relevant files (via hashline reads — summarized, not dumped)
3. It edits code (hashline patches that land on first attempt)
4. It runs tests (embedded bash, zero fork/exec)
5. It commits changes (atomic, dependency-ordered)
6. It reports back with citations

**No permission prompts by default** — the agent just does the work. Destructive operations (`rm -rf`, `git reset --hard`) require confirmation. Configure via `/config`.

### Mode 2: `autonomous` — Multi-Agent Pipeline

**"Give it a goal, it plans, executes, tests, reviews, and commits."**

The agent decomposes your task, spawns specialized sub-agents, runs them in parallel, verifies results, and delivers a complete solution. You set the acceptance criteria, it loops until they pass.

| Aspect | Detail |
|---|---|
| **Agent count** | 5–8 specialized agents (orchestrator + file picker + thinker + editor ×N + reviewer + basher) |
| **Orchestration** | Orchestrator pattern — main agent has NO tools except spawning others. Stays context-clean. |
| **Parallelism** | Best-of-N selection — multiple editors run in parallel on same task, selector picks best |
| **Advisor** | **On by default** — second model watches every turn, injects blockers |
| **Verification** | Contract-driven — immutable acceptance criteria, agent loops until all pass |
| **Context** | Smart compaction — non-lossy summaries after 5min idle, deterministic strategy |
| **Best for** | Multi-file refactors, building new features, migrating dependencies, writing entire modules |
| **Entry** | `jean autonomous "Add rate limiting to all public API routes"` or `/autonomous` from focus |

**What happens in autonomous mode:**

1. You provide a goal and optional acceptance criteria
2. The orchestrator spawns a **planner** agent that breaks the task into sub-tasks
3. A **file picker** agent scans the codebase (tree-sitter) and finds relevant files
4. A **researcher** agent searches the web for best practices and examples
5. A **thinker** agent performs deep analysis on complex parts
6. Multiple **editor** agents run in parallel on different sub-tasks (best-of-N selection)
7. A **reviewer** agent catches bugs, style issues, dead code
8. A **basher** agent runs tests and type checks
9. The orchestrator collects results, synthesizes, and commits atomically
10. If any acceptance criterion fails, the relevant agent retries

**The orchestrator never sees the raw output of its children** — only their structured results. This keeps its context clean and focused.

### Mode 3: `swarm` — Agent Teams

**"A team of agents collaborating on ambitious work."**

A Team Lead coordinates 3–5 teammates, each with their own context window and model. They communicate directly via a shared mailbox, claim tasks from a shared task list, and self-coordinate.

| Aspect | Detail |
|---|---|
| **Agent count** | 1 lead + 3–5 teammates (no hard limit, diminishing returns after 5) |
| **Coordination** | Shared task list (pending → in progress → completed), mailbox for direct messaging |
| **Communication** | Direct inter-agent messaging — teammates message each other without routing through lead |
| **Isolation** | Manual file partitioning + optional worktree isolation per teammate |
| **Plan approval** | Teammates can work in read-only plan mode until lead approves |
| **Hooks** | TeammateIdle, TaskCreated, TaskCompleted — exit 2 to gate |
| **Display** | In-process (default) or split panes (tmux / iTerm2) |
| **Best for** | Large-scale refactors, building entire services, cross-layer coordination |
| **Entry** | `jean swarm "Refactor the entire authentication system"` or `/swarm` from focus |

**What happens in swarm mode:**

1. You describe the ambitious task to the Team Lead
2. The Lead creates a shared task list with dependencies
3. The Lead spawns 3–5 teammates, each with their own model and context
4. Teammates claim tasks from the list (file locking prevents races)
5. Teammates message each other directly via the mailbox (e.g., "I changed the API contract, update your client")
6. The Lead monitors progress, approves plans, resolves conflicts
7. When all tasks complete, the Lead synthesizes results and commits
8. Teammates shut down gracefully

**This is the 5% of tasks that are genuinely ambitious** — building features that span the entire codebase, migrating from one framework to another, or writing an entire service from scratch.

### Mode Transitions

```
┌──────────┐    /autonomous    ┌──────────────┐
│  focus   │ ◄───────────────► │ autonomous   │
│ (default)│    /focus         │              │
└────┬─────┘                   └──────┬───────┘
     │                                │
     │         /swarm                 │  /swarm
     └────────────────────────────────►│  swarm     │
                                       └────────────┘
```

| Transition | Command | Behavior |
|---|---|---|
| Enter focus | `jean` or `/focus` | Single agent, interactive TUI |
| Enter autonomous | `jean autonomous "goal"` or `/autonomous` | Spawns pipeline, stays in session |
| Enter swarm | `jean swarm "goal"` or `/swarm` | Spawns team lead + teammates |
| Autonomous → Focus | `/focus` | Returns to single-agent interactive |
| Swarm → Focus | "shut down the team" → `/focus` | Graceful shutdown, then single-agent |
| Focus → Swarm | `/swarm` | Spawns team from current session |

### Magic Keywords

Work in any mode. Inline in your prompt to trigger specific behaviors:

| Keyword | Effect |
|---|---|
| `ultrathink` | Multi-step reasoning + highest thinking effort |
| `orchestrate` | Force parallel subagents + verify each phase |
| `workflowz` | Deterministic multi-subagent workflow |
| `deep-review` | Spawn fleet of bug-hunting agents (UltraReview) |
| `plan-first` | Read-only plan mode, require approval before changes |

### Mode Selection Guide

| Your Task | Recommended Mode | Why |
|---|---|---|
| Fix a bug in one file | `focus` | Fast, direct, no overhead |
| Write a new API endpoint | `focus` | Single agent handles it |
| Refactor auth across 15 files | `autonomous` | Multi-file, needs review |
| Migrate from REST to GraphQL | `autonomous` | Complex, needs planning + verification |
| Build a new microservice | `swarm` | Frontend + backend + tests + docs in parallel |
| Rewrite the entire frontend | `swarm` | Multiple modules, cross-layer coordination |
| Debug with competing hypotheses | `swarm` | Different teammates test different theories |

---

## 5. Architecture Layers

### 5.1 Multi-Platform Gateway

The gateway is Jean Code's entry point. It accepts input from any platform and routes it to the Agent Orchestrator.

**Platforms supported (20+):**

| Platform | Protocol | Voice | Notes |
|---|---|---|---|
| CLI (TUI) | Stdio | Yes | Primary interface, full feature set |
| Desktop App | WebSocket | Yes | Tauri-based, mission control view |
| Web IDE | WebSocket | No | Full browser experience |
| Telegram | Bot API | Yes (voice memos) | Start on phone, continue in terminal |
| Discord | Gateway | Yes (VC) | Voice channel support |
| Slack | Events API | No | PR reviews, changelog updates |
| WhatsApp | Business API | Yes | Voice memo transcription |
| Signal | Service | Yes | Encrypted messaging |
| Matrix | Client-Server | No | Federated messaging |
| Mattermost | Webhook | No | Self-hosted alternative |
| Email | IMAP/SMTP | No | Async conversations |
| SMS | Twilio | No | Text-only |
| DingTalk | API | No | Chinese enterprise |
| Feishu | API | No | Chinese enterprise |
| WeCom | API | No | Chinese enterprise |
| Weixin | API | No | Chinese social |
| QQ Bot | API | No | Chinese social |
| Home Assistant | WebSocket | No | Smart home integration |
| Microsoft Teams | Graph API | No | Enterprise |
| Google Chat | API | No | Workspace |

**Single gateway process** — one `jean gateway start` command connects all platforms. Cross-platform continuity: start a conversation on Telegram, pick it up in your terminal.

**Voice mode** — real-time voice interaction in CLI, Telegram, Discord, Discord VC. Voice memo transcription for WhatsApp, Signal.

### 5.2 Agent Orchestrator

The orchestrator is the brain of Jean Code. It manages agent lifecycle, mode selection, task coordination, and context management.

**Core responsibilities:**

1. **Mode management** — Switch between focus, autonomous, and swarm modes
2. **Agent lifecycle** — Spawn, monitor, and terminate agents
3. **Task coordination** — Shared task lists, mailbox messaging, file locking
4. **Context management** — Auto-compact, smart compaction, context window management
5. **Permission gating** — Approve/deny destructive operations
6. **Result synthesis** — Collect results from sub-agents, produce final output

**Orchestrator variants:**

| Variant | Mode | Description |
|---|---|---|
| `base` | focus | Single agent, interactive |
| `base-autonomous` | autonomous | Orchestrator pattern, spawns specialized agents |
| `base-swarm` | swarm | Team lead, manages teammates |
| `base-lite` | focus | Faster, cheaper model for quick tasks |
| `base-max` | autonomous | Best-of-N selection, multiple reviewers |
| `base-plan` | focus | Read-only, no file writes |

### 5.3 Tool Harness

The tool harness provides all the operations agents can perform. It's split between a Rust core (in-process, zero fork/exec) and TypeScript tools.

**Rust core (in-process):**

| Tool | Implementation | LOC |
|---|---|---|
| `read` | Direct file I/O + archive/SQLite/PDF/notebook support | 850 |
| `write` | Direct file I/O + archive/SQLite support | 420 |
| `edit` | Hashline patches + unified diff patches | 1100 |
| `grep` | ripgrep in-process | 380 |
| `glob` | Parallel FS walker + gitignore | 430 |
| `bash` | Embedded bash (brush) + 58 coreutils | 2200 |
| `lsp` | 14 LSP operations | 1800 |
| `dap` | 28 DAP operations | 2100 |
| `ignore` | globset + gitignore parsing | 290 |
| `clipboard` | arboard (cross-platform) | 370 |
| `profiler` | flamegraph output | 520 |
| `process` | Process tree, kill, descendants | 195 |
| `sixel` | Terminal image rendering | 55 |
| `tokens` | O200k / Cl100k BPE counting | 70 |
| `power` | macOS power-assertion API | 270 |
| `treesitter` | 50+ language grammars | 1200 |

**TypeScript tools:**

| Tool | Description |
|---|---|
| `browser` | Puppeteer over headless Chromium, CDP attach, Chrome relay |
| `computer` | Persistent JS against host: windows, screenshots, native input, AX tree |
| `web_search` | 23-provider chain, structured markdown output |
| `runtime` | Python + Bun kernels with loopback bridge |
| `git` | Git operations, GitHub/GitLab API, Sourcegraph |
| `security_scan` | Native security reviews + cloud scans |
| `generate_image` | Image generation via Gemini, GPT, Grok |
| `tts` | Text-to-speech via Grok Voice |
| `rewind` | Prune exploratory context, keep concise report |
| `inspect_image` | Vision AI for models that can't see |

### 5.4 Execution Layer

The execution layer runs commands in isolated environments. Local terminal is the default; cloud sandboxes are optional.

| Backend | Use Case | Persistence | Cost |
|---|---|---|---|
| **Local Terminal** | Default — run commands on your machine | N/A | Free |
| **Docker** | Isolated container with security hardening | Container lifecycle | Low |
| **SSH** | Remote server execution | Server lifecycle | Your server |
| **Daytona** | Serverless dev environments | Hibernates when idle | Near-zero when idle |
| **Modal** | Cloud GPU/compute | Serverless | Pay per use |
| **Singularity** | HPC clusters | Cluster lifecycle | Cluster cost |

**Security hardening** (Docker/Modal/Singularity):

- Read-only root filesystem
- Dropped Linux capabilities
- PID limits
- Namespace isolation
- Seccomp filters
- No internet access (optional)

### 5.5 Model Layer

The model layer routes LLM calls to providers. It's provider-agnostic — agents request a model by role, the model layer resolves to the actual provider/model.

**Provider categories:**

| Category | Providers | Auth |
|---|---|---|
| **Direct API** | Anthropic, OpenAI, Google Gemini, xAI, DeepSeek, Mistral, Groq, Cerebras, Fireworks, Together, Baseten, Hugging Face, NVIDIA, Meta, AWS Bedrock, Azure, SiliconFlow, GMI Cloud, CoreWeave, Sakana AI, Synthetic, Vercel AI Gateway, Cloudflare AI Gateway, Wafer Serverless | API Key / OAuth |
| **Coding Plans** | Cursor, GitHub Copilot, GitLab Duo, Devin, Kimi Code, MiniMax, Alibaba, Qwen, Z.AI, Zhipu, Xiaomi MiMo, Qianfan, Umans, NanoGPT, Novita, Venice, Kilo, ZenMux | OAuth / Plan |
| **Gateways** | OpenRouter, Nous Portal | API Key / OAuth |
| **Local** | vLLM, Ollama, llama.cpp, sglang | Local endpoint |

**10 Model Roles:**

| Role | Purpose | Default Model |
|---|---|---|
| `default` | Main agent | Sonnet 5 |
| `smol` | Fast, cheap tasks | Flash / GPT-4o-mini |
| `slow` | Deep reasoning | Opus 4.7 |
| `plan` | Planning & architecture | Sonnet 5 |
| `commit` | Writing commit messages | Flash |
| `vision` | Image analysis | GPT-4o |
| `designer` | UI/UX design | Sonnet 5 |
| `task` | Background tasks | Flash |
| `advisor` | Review & block | Opus 4.7 |
| `tiny` | Trivial tasks | GPT-4o-mini |

**Streaming features:**

- **Mid-token stream rules** — Inject system reminders mid-token if regex detects off-script behavior
- **Fallback chain** — Up to 3 fallback models tried in order on failure
- **Auto-compact** — At 95% context window, summarize and continue in new session
- **Smart compaction** — After 5min idle (prompt cache expired), non-lossy summaries
- **Adaptive thinking** — On by default, adjusts reasoning depth based on task complexity
- **Effort slider** — Interactive control: `fast` → `normal` → `high` → `xhigh`

---

## 6. Module Breakdown

Jean Code is organized as a monorepo with 27 packages. Each package has clear ownership and well-defined interfaces.

### 6.1 `jean-core` (Rust) — 45,000 LOC

The Rust core provides all in-process operations. Zero fork/exec. This is the performance-critical layer.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `file_ops` | read, write, edit, archive, SQLite, PDF, notebook support | 4,500 |
| `hashline` | Content-hash anchored patch language and applier | 2,200 |
| `shell` | Embedded bash (brush) with sessions that survive across calls | 3,800 |
| `builtins` | 58 coreutils: ls, sed, sort, xargs, jq, grep, find, etc. | 4,200 |
| `lsp` | 14 LSP operations: diagnostics, rename, imports, navigation | 3,500 |
| `dap` | 28 DAP operations: breakpoints, stepping, threads, stack, variables | 4,000 |
| `treesitter` | 50+ language grammars, code summarizer, AST utilities | 3,200 |
| `grep` | ripgrep in-process, regex over files/globs/internal URLs | 1,100 |
| `glob` | Parallel ignore-aware filesystem walker with scan cache | 1,400 |
| `ignore` | gitignore-aware globset | 800 |
| `clipboard` | Cross-platform clipboard (arboard) | 600 |
| `profiler` | Flamegraph output, performance profiling | 1,200 |
| `process` | Cross-platform process tree, kill, descendant listing | 500 |
| `sixel` | Terminal image rendering, SIXEL encode | 900 |
| `tokens` | O200k / Cl100k BPE token counting, both tables embedded | 300 |
| `power` | macOS power-assertion API (idle/system/display-sleep prevention) | 500 |
| `walker` | Parallel ignore-aware filesystem walker, shared by grep/glob/workspace | 2,800 |
| `iso` | Task isolation: APFS clones, btrfs/zfs reflinks, overlayfs, projfs | 2,500 |
| `voice` | Audio capture/playback, Opus codecs, live WebRTC streaming | 3,000 |
| **N-API bindings** | Rust → TypeScript FFI layer | 4,000 |

**Key design decisions:**

- **In-process everything** — No shelling out to external binaries. Every tool runs inside the Jean Code process.
- **Sessions survive** — The embedded bash maintains state across calls. `export VAR=value` in one call, `$VAR` is available in the next.
- **Hashline edits** — Content-hash anchored patches. If the anchor is stale, the applier recovers using context. 61% fewer output tokens than line-number patches.
- **LSP wired into every write** — When the agent renames a file, `workspace/willRenameFiles` updates all re-exports, barrel files, and aliased imports automatically.

### 6.2 `jean-agent` (TypeScript) — 40,000 LOC

The agent framework manages the main agent loop, orchestrator pattern, specialized agents, and context management.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `orchestrator` | Main agent loop, event-driven, single source of truth | 6,000 |
| `agents/editor` | Code editing and file modifications | 4,000 |
| `agents/reviewer` | Code review, bug detection, style checking | 3,500 |
| `agents/researcher` | Web search, documentation lookup | 3,000 |
| `agents/thinker` | Deep analysis, problem decomposition | 3,000 |
| `agents/file-picker` | File discovery via tree-sitter code map | 2,500 |
| `agents/basher` | Terminal command execution | 2,000 |
| `agents/code-searcher` | Pattern matching in code files | 2,000 |
| `agents/planner` | Task breakdown, architecture planning | 2,500 |
| `context` | Context management, auto-compact, smart compaction | 4,000 |
| `contract` | Contract-driven execution, acceptance criteria | 3,000 |
| `generator` | Generator function control for programmatic agents | 2,500 |
| `structured` | JSON Schema output, validation | 2,000 |

**Key design decisions:**

- **Orchestrator pattern** — The main agent has NO tools except spawning other agents. It stays context-clean because spawned agents contribute only their final output.
- **Generator functions** — Mix LLM calls with TypeScript code using `yield`. Full programmatic control over tool calls and LLM steps.
- **Contract-driven execution** — Acceptance criteria serve as an immutable contract. The agent loops until all criteria pass.
- **Smart compaction** — After 5 minutes of idle (prompt cache expired), create non-lossy summaries that preserve 10–20 roundtrips of context.

### 6.3 `jean-teams` (TypeScript) — 15,000 LOC

Agent Teams implementation — team lead, teammates, shared task list, mailbox messaging, file locking, plan approval.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `lead` | Team lead logic: spawn teammates, create tasks, assign, monitor | 3,500 |
| `teammate` | Teammate lifecycle: claim tasks, execute, report, shutdown | 3,000 |
| `tasklist` | Shared task list with file locking, dependency tracking | 2,500 |
| `mailbox` | Inter-agent messaging via JSON files | 2,000 |
| `approval` | Plan approval flow: read-only plan mode, lead reviews/rejects | 2,000 |
| `hooks` | TeammateIdle, TaskCreated, TaskCompleted hooks | 1,000 |
| `display` | In-process and split-pane display modes | 1,000 |

**Key design decisions:**

- **Direct inter-agent communication** — Teammates message each other via the mailbox without routing through the lead. This removes the bottleneck of a single main agent relaying all information.
- **Shared task list with file locking** — Prevents race conditions when multiple teammates try to claim the same task.
- **Plan approval** — Teammates can work in read-only plan mode until the lead approves their approach. If rejected, the teammate revises and resubmits.

### 6.4 `jean-subagents` (TypeScript) — 12,000 LOC

Sub-agent fan-out with schema-validated results, worktree isolation, context inheritance toggle, arbitrary nesting.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `fanout` | Parallel sub-agent spawning and result collection | 3,000 |
| `schema` | JSON Schema validation for sub-agent results | 2,000 |
| `worktree` | Worktree isolation via APFS clones, btrfs reflinks, overlayfs | 2,500 |
| `context` | Context inheritance toggle, history management | 2,000 |
| `nesting` | Arbitrary nesting depth, parent-child communication | 1,500 |
| `rpc` | RPC pipeline collapse, zero-context-cost turns | 1,000 |

**Key design decisions:**

- **Schema-validated results** — Each sub-agent returns a typed, schema-validated object. No prose to parse, no merge conflicts.
- **Worktree isolation** — Each sub-agent runs in its own isolated worktree. Changes are merged back only after validation.
- **Arbitrary nesting** — Agents spawn agents that spawn agents — unlimited depth. Each level contributes only structured results upward.

### 6.5 `jean-advisor` (TypeScript) — 5,000 LOC

Advisor layer — a second model watches every turn the main agent takes, injecting notes inline: a quiet aside, a concern, or a hard blocker.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `watcher` | Monitor main agent turns, detect issues | 2,000 |
| `injector` | Inline note/blocker injection | 1,500 |
| `config` | Advisor model selection, permission set | 1,000 |
| `escalation` | Hard blocker escalation to user | 500 |

**Key design decisions:**

- **Own context and model** — The advisor runs on its own context window and its own model (typically Opus). It doesn't share context with the main agent.
- **Three injection levels** — Note (informational), Concern (warning), Blocker (hard stop). The main agent sees the injection and course-corrects, or tells the user why it won't.
- **On by default in autonomous mode** — Quality multiplier that catches what the doer rushed past.

### 6.6 `jean-tools` (TypeScript) — 25,000 LOC

Tool registry and all TypeScript-based tools.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `registry` | Central tool registry, routing, permission gating | 3,000 |
| `browser` | Puppeteer/Chromium, CDP attach, Chrome relay extension | 4,000 |
| `computer` | Persistent JS against host: windows, screenshots, native input, AX tree | 3,500 |
| `web_search` | 23-provider chain, structured markdown output | 3,000 |
| `runtime` | Python + Bun kernels, loopback bridge | 3,500 |
| `security_scan` | Native security reviews + cloud scans | 2,000 |
| `image_gen` | Image generation via Gemini, GPT, Grok | 1,500 |
| `tts` | Text-to-speech via Grok Voice | 1,000 |
| `rewind` | Prune exploratory context, keep concise report | 1,000 |
| `inspect_image` | Vision AI for models that can't see | 1,000 |
| `voice` | Real-time voice interaction | 2,500 |

**Key design decisions:**

- **Central registry** — All tools register with the tool registry. MCP tools and plugins register here too. The registry routes tool calls to the right module.
- **Browser tool** — Stealth mode on by default. Can drive headless Chromium, attach to existing Chrome tabs via relay extension, or control any Electron app via CDP.
- **Computer tool** — Persistent JavaScript against the real host. Not the DOM — the actual desktop. Enumerate windows, capture screenshots, send native input, walk accessibility tree, touch clipboard.
- **Runtime workers** — Long-lived Python and Bun kernels. Either kernel can call back into agent tools via the loopback bridge. The agent loads a CSV from inside Python, charts from JS, never leaves the cell.

### 6.7 `jean-git` (TypeScript) — 10,000 LOC

Git operations, GitHub/GitLab API, Sourcegraph, atomic commits, conflict resolution, PR review.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `git` | Core git operations (commit, diff, status, branch, merge) | 2,500 |
| `github` | GitHub API: PRs, issues, code search, Actions | 2,500 |
| `gitlab` | GitLab API: MRs, issues, pipelines | 1,500 |
| `sourcegraph` | Code search across public repositories | 1,000 |
| `atomic` | Atomic commit splitting: dependency-ordered, cycle detection | 1,500 |
| `conflict` | Conflict resolution via URL scheme | 500 |
| `review` | PR review with P0-P3 ranking and confidence scores | 500 |

**Key design decisions:**

- **GitHub as filesystem** — `read pr://1428` returns the same shape as `read src/foo.ts`. PRs, issues, code search are paths — one interface.
- **Atomic commits** — Reads working tree via `git_overview`, `git_file_diff`, `git_hunk`. Splits unrelated changes into atomic commits ordered by dependencies. Cycles rejected. Source files scored above tests/docs/configs. Lock files excluded.
- **Conflict resolution** — Each merge conflict becomes one URL. Agent writes `@theirs`, `@ours`, or `@base` to `conflict://N`. Bulk form: `conflict://*`.

### 6.8 `jean-memory` (TypeScript) — 12,000 LOC

Memory system with retain/learn/recall/reflect/edit operations. SQLite/FTS5 backend with Hindsight and Mnemopi compatibility.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `retain` | Store facts and lessons from conversations | 2,000 |
| `learn` | Extract patterns and preferences from usage | 2,000 |
| `recall` | FTS5 search across stored memory | 2,000 |
| `reflect` | Periodic self-reflection, memory consolidation | 1,500 |
| `edit` | Manual memory editing | 1,000 |
| `backend/sqlite` | SQLite + FTS5 storage | 1,500 |
| `backend/hindsight` | Hindsight compatibility layer | 1,000 |
| `backend/mnemopi` | Mnemopi compatibility layer | 1,000 |

**Key design decisions:**

- **Curated memory** — The agent actively decides what to retain, what to learn, and what to forget. Not everything is stored — only what's useful.
- **FTS5 search** — Full-text search across all stored memory. The agent can search its own past conversations for context.
- **Cross-session recall** — Memory persists across sessions. The agent remembers your preferences, projects, and environment — no re-explaining.

### 6.9 `jean-skills` (TypeScript) — 10,000 LOC

SKILL.md auto-generation, agentskills.io hub, skill execution, 40+ built-in skills, skill self-improvement.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `engine` | Skill execution, tool surface mapping | 2,500 |
| `autogen` | Automated skill creation from hard problems | 2,000 |
| `hub` | agentskills.io integration, community skills | 1,500 |
| `builtin` | 40+ built-in skills (MLOps, GitHub, diagramming, etc.) | 2,500 |
| `improve` | Skill self-improvement during use | 1,500 |

**Key design decisions:**

- **Auto-generation** — When the agent solves a hard problem, it writes a SKILL.md file that captures the solution. Future sessions can reuse it.
- **Self-improvement** — Skills improve during use. The agent learns from each execution and updates the skill.
- **Community hub** — Skills are published to agentskills.io. Browse, install, and share with one command.

### 6.10 `jean-mcp` (TypeScript) — 8,000 LOC

MCP (Model Context Protocol) integration — stdio + SSE, permission system, tool filtering.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `stdio` | Stdio-based MCP server connections | 2,000 |
| `sse` | SSE-based MCP server connections | 2,000 |
| `permissions` | Permission system for MCP tools | 2,000 |
| `filter` | Tool filtering, selective exposure | 1,000 |
| `registry` | MCP tool registration with central registry | 1,000 |

**Key design decisions:**

- **Stdio + SSE** — Both connection types supported. Stdio for local tools, SSE for remote tools.
- **Permission system** — Each MCP tool can be individually permitted or denied. Fine-grained control.
- **Tool filtering** — Expose only the tools you want. Filter by name, category, or risk level.

### 6.11 `jean-plugins` (TypeScript) — 8,000 LOC

Plugin system — .zip/URL loading, PATH injection, extension API, slash-command registry, hotkey table.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `loader` | .zip/URL plugin loading, extraction, validation | 2,000 |
| `path` | PATH injection for plugin executables | 1,000 |
| `api` | Extension API — same tool surface as built-ins | 2,000 |
| `commands` | Slash-command registry for plugins | 1,500 |
| `hotkeys` | Hotkey table for plugins | 1,500 |

**Key design decisions:**

- **Same API as built-ins** — Plugins have access to the same tool API, slash-command registry, hotkey table, and TUI primitives as built-in tools. Nothing is reserved.
- **PATH injection** — Plugin executables are added to the bash tool's PATH. The agent can run them like any other command.
- **Reload without restart** — `/reload-plugins` reloads all plugins without restarting the session.

### 6.12 `jean-model` (TypeScript) — 15,000 LOC

Model layer — 60+ providers, 1000+ models, streaming, mid-token rules, fallback chain, role routing.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `providers` | 60+ provider implementations | 6,000 |
| `catalog` | Model catalog: bundled model database, provider descriptors | 2,000 |
| `streaming` | Streaming responses, mid-token rules | 2,000 |
| `fallback` | Fallback chain (up to 3 models) | 1,500 |
| `roles` | 10 model roles, routing by role | 1,500 |
| `compaction` | Auto-compact at 95%, smart compaction | 1,000 |
| `thinking` | Adaptive thinking, effort slider, reasoning effort | 1,000 |

**Key design decisions:**

- **Provider-agnostic** — Agents request a model by role; the model layer resolves to the actual provider/model. Swap providers mid-session.
- **Mid-token rules** — Inject system reminders mid-token if regex detects off-script behavior. Course-corrects without context tax.
- **Fallback chain** — Up to 3 fallback models tried in order on failure. Transparent to the agent.

### 6.13 `jean-tui` (Rust + TypeScript) — 25,000 LOC

Terminal UI — differential rendering, tool call cards, edit previews, vim-mode input, agent hub, split panes.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `render` | Differential rendering engine (Rust/ratatui) | 4,000 |
| `cards` | Tool call cards, structured display | 2,500 |
| `preview` | Edit previews before landing | 2,000 |
| `input` | Vim-mode input, external editor support | 3,000 |
| `hub` | Agent Hub TUI — monitor/steer/kill subagents | 2,500 |
| `panes` | Split pane support (tmux / iTerm2) | 2,000 |
| `accessibility` | Screen reader mode — plain linear text | 1,500 |
| `react-tui` | React-based TUI components (OpenTUI-style) | 4,500 |
| `sixel` | Terminal image rendering | 2,000 |
| `theme` | Theme system, customization | 1,000 |

**Key design decisions:**

- **Differential rendering** — Only changed regions are redrawn. No flicker. Smooth, polished experience.
- **React TUI** — React-based TUI components for complex UI elements. Hover and click support.
- **Vim-mode input** — Full vim-style navigation in the terminal. External editor support for composing long prompts.

### 6.14 `jean-desktop` (Tauri + React) — 20,000 LOC

Desktop app — Tauri-based, mission control view, in-app browser, shadow workspaces.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `shell` | Tauri shell, window management | 3,000 |
| `mission-control` | Window manager view for multiple agents | 3,500 |
| `browser` | In-app browser for web content | 3,000 |
| `workspaces` | Shadow workspaces, multi-project management | 3,000 |
| `agents-view` | Multi-agent view, parallel monitoring | 2,500 |
| `notifications` | Desktop notifications, push | 1,500 |
| `settings` | Settings UI, model configuration | 2,000 |
| `updates` | Auto-update mechanism | 1,500 |

**Key design decisions:**

- **Tauri, not Electron** — Smaller binary, native performance, Rust backend integration.
- **Mission Control** — F3 or double-tap desktop to see all agents at once. Like macOS Expose for coding agents.

### 6.15 `jean-web` (React) — 15,000 LOC

Web IDE — full browser experience, project overview, session history, stats panel, integrated terminal.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `ide` | Web IDE with code editor, file tree | 4,000 |
| `projects` | Project overview, session history | 2,500 |
| `stats` | Real-time metrics: prefill time, generation speed, context usage | 2,000 |
| `terminal` | Integrated terminal | 2,000 |
| `notifications` | Event log, notifications | 1,500 |
| `agents` | Agent management panel | 1,500 |
| `settings` | Settings UI | 1,500 |

### 6.16 `jean-gateway` (TypeScript) — 15,000 LOC

Multi-platform gateway — 20+ platforms, voice mode, cross-platform continuity.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `core` | Gateway core, message routing, session management | 3,000 |
| `telegram` | Telegram bot integration | 1,500 |
| `discord` | Discord bot integration | 1,500 |
| `slack` | Slack bot integration | 1,000 |
| `whatsapp` | WhatsApp Business API | 1,000 |
| `signal` | Signal bot integration | 1,000 |
| `matrix` | Matrix bot integration | 1,000 |
| `email` | Email integration (IMAP/SMTP) | 1,000 |
| `sms` | SMS integration (Twilio) | 500 |
| `voice` | Voice mode, transcription, TTS | 2,000 |
| `platforms` | Additional platforms (DingTalk, Feishu, WeCom, etc.) | 2,000 |

**Key design decisions:**

- **Single process** — One `jean gateway start` connects all platforms. No separate processes per platform.
- **Cross-platform continuity** — Start a conversation on Telegram, pick it up in your terminal. Same session, same context.
- **Voice mode** — Real-time voice interaction in CLI, Telegram, Discord, Discord VC. Voice memo transcription for WhatsApp, Signal.

### 6.17 `jean-execution` (TypeScript) — 10,000 LOC

Execution backends — local, Docker, SSH, Daytona, Modal, Singularity.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `local` | Local terminal execution | 1,500 |
| `docker` | Docker sandbox execution | 2,000 |
| `ssh` | SSH remote execution | 1,500 |
| `daytona` | Daytona serverless environments | 1,500 |
| `modal` | Modal cloud execution | 1,500 |
| `singularity` | Singularity HPC execution | 1,000 |
| `security` | Security hardening, namespace isolation | 1,000 |

### 6.18 `jean-scheduler` (TypeScript) — 8,000 LOC

Scheduler and automations — cron, one-off, trigger-based, always-on agents.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `cron` | Cron-based recurring tasks | 2,000 |
| `oneoff` | One-off scheduled tasks | 1,500 |
| `triggers` | Trigger-based automations (CI failure, branch event) | 2,000 |
| `always-on` | Always-on agents, persistent monitoring | 1,500 |
| `push` | Mobile push notifications | 1,000 |

### 6.19 `jean-collab` (TypeScript) — 8,000 LOC

Collaboration mode — live session relay, link + QR, read-write/read-only, client-side sealing.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `relay` | Session relay server, WebSocket | 2,500 |
| `host` | Host session, share link + QR | 2,000 |
| `guest` | Guest client, join session | 2,000 |
| `security` | Client-side sealing, frame encryption | 1,500 |

### 6.20 `jean-cli` (TypeScript) — 10,000 LOC

CLI entry point — commands, flags, completion scripts, non-interactive mode, custom commands.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `commands` | CLI commands (focus, autonomous, swarm, gateway, etc.) | 3,000 |
| `flags` | Flag parsing, completion script generation | 2,000 |
| `non-interactive` | Non-interactive mode, JSON output | 1,500 |
| `custom` | Custom commands (Markdown-based, named arguments) | 1,500 |
| `hooks` | Pre/post hooks with conditional logic | 1,000 |
| `config` | CLI configuration, settings | 1,000 |

### 6.21 `jean-config` (TypeScript) — 8,000 LOC

Configuration management — 8-format import, settings, validation.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `parser` | Config file parsing, validation | 2,000 |
| `import` | 8-format import (Cursor, Cline, Codex, Copilot, Windsurf, Gemini, Claude, VSCode) | 3,000 |
| `settings` | Settings management, runtime updates | 2,000 |
| `env` | Environment variable handling | 1,000 |

### 6.22 `jean-acp` (TypeScript) — 5,000 LOC

Agent Client Protocol — JSON-RPC over stdio, editor integration, permission gating.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `protocol` | JSON-RPC implementation | 2,000 |
| `editor` | Editor integration (VS Code, JetBrains, Zed) | 2,000 |
| `permissions` | Permission gating for ACP clients | 1,000 |

### 6.23 `jean-sdk` (TypeScript) — 8,000 LOC

Embeddable SDK — build custom agents, programmatic control, generator functions.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `core` | SDK core, agent embedding | 3,000 |
| `agents` | Custom agent definition, tool surface | 2,500 |
| `generator` | Generator function control | 1,500 |
| `types` | TypeScript types, interfaces | 1,000 |

### 6.24 `jean-projects` (TypeScript) — 10,000 LOC

Projects — shared knowledge bases, RAG, role-based permissions, sharing, connectors.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `knowledge` | Knowledge base management, file uploads | 2,500 |
| `rag` | Retrieval Augmented Generation (10x expansion) | 2,500 |
| `sharing` | Project sharing, role-based permissions | 2,000 |
| `connectors` | Database, API, cloud storage connectors | 2,000 |
| `search` | Enterprise search, vector search | 1,000 |

### 6.25 `jean-evals` (TypeScript) — 10,000 LOC

Evaluation framework — BuffBench-style evals, batch processing, trajectory export, RL training.

**Sub-modules:**

| Sub-module | Responsibility | LOC |
|---|---|---|
| `bench` | BuffBench-style evals, 175+ tasks | 3,000 |
| `batch` | Batch processing, parallel trajectory generation | 2,500 |
| `export` | Trajectory export, ShareGPT format | 1,500 |
| `rl` | RL training integration, Atropos | 1,500 |
| `harness` | Benchmark runners, REST/SSE API, live dashboard | 1,500 |

---## 7. Data Flow

### 7.1 Focus Mode — Single File Edit

```
User: "Fix the rate limiter bug in src/middleware/rate-limit.ts"
  │
  ▼
┌─────────────────────────────────────────────────────┐
│  GATEWAY (CLI TUI)                                   │
│  Parses input → routes to Main Agent                │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│  MAIN AGENT (focus mode)                             │
│  1. Loads project context (CLAUDE.md, memory)        │
│  2. Reads rate-limit.ts via hashline (summarized)    │
│  3. Greps for related test files                     │
│  4. Reads test file                                  │
│  5. Identifies bug: counter not reset on window     │
│     rotation                                         │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│  TOOL HARNESS                                        │
│  edit src/middleware/rate-limit.ts → hashline patch  │
│  bash npm test → embedded bash (zero fork/exec)      │
│  lsp diagnostics → LSP client                       │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│  MAIN AGENT — Reports Result                         │
│  "Fixed: counter now resets on window rotation.      │
│   All 12 tests pass. LSP clean."                     │
└─────────────────────────────────────────────────────┘
```

### 7.2 Autonomous Mode — Multi-File Feature

```
User: "Add rate limiting to all public API routes"
  │
  ▼
┌─────────────────────────────────────────────────────┐
│  MAIN AGENT (autonomous mode)                        │
│  1. Planner breaks task into 4 sub-tasks:            │
│     a. Create rate limiter middleware                │
│     b. Apply to all public routes                    │
│     c. Write tests                                   │
│     d. Update docs                                   │
│  2. File Picker scans codebase (tree-sitter)         │
│  3. Researcher searches web for best practices       │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│  SPECIALIZED AGENTS (parallel)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ Editor A │  │ Editor B │  │ Editor C │  ...      │
│  │ (mid.)   │  │ (routes) │  │ (tests)  │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│                                                      │
│  Best-of-N: 2 editors on middleware, selector picks  │
│  the best implementation                             │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│  REVIEWER + BASHER (parallel)                        │
│  Reviewer: catches bugs, style issues, dead code     │
│  Basher: runs tests, type checks                     │
│                                                      │
│  Contract check: all acceptance criteria pass?       │
│  If NO → relevant agent retries                     │
│  If YES → proceed to commit                         │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│  MAIN AGENT — Synthesis                              │
│  1. Collects results from all agents                 │
│  2. Advisor flagged 1 concern → addressed            │
│  3. Atomic commits: 4 commits ordered by dependency  │
│  4. Creates PR with citations                        │
│  5. Reports to user                                  │
└─────────────────────────────────────────────────────┘
```

### 7.3 Swarm Mode — Team Collaboration

```
User: "Refactor the entire authentication system"
  │
  ▼
┌─────────────────────────────────────────────────────┐
│  TEAM LEAD (swarm mode)                              │
│  1. Creates shared task list with 8 tasks            │
│  2. Spawns 4 teammates:                              │
│     - Auth (backend API)                             │
│     - Session (session management)                   │
│     - Frontend (auth UI)                             │
│     - Tests (integration + unit)                     │
│  3. Assigns initial tasks                            │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│  4 TEAMMATES (parallel, independent contexts)        │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ Auth     │  │ Session  │  │ Frontend │  ...      │
│  │ Teammate │  │ Teammate │  │ Teammate │          │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘          │
│       │              │              │                │
│       └──────────┬───┴──────────────┘                │
│                  │                                   │
│         MAILBOX: Direct inter-agent messaging        │
│         "I changed the JWT structure,               │
│          update your session decoder"                │
│                                                      │
│         TASK LIST: Self-claim, file locking          │
│         Auth finishes task 1 → claims task 5         │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│  TEAM LEAD — Monitors & Synthesizes                  │
│  1. Reviews plan submissions from each teammate      │
│  2. Approves/rejects autonomously                    │
│  3. Resolves conflicts between teammates             │
│  4. When all tasks complete → synthesizes results    │
│  5. Atomic commits + PR                              │
└─────────────────────────────────────────────────────┘
```

---

## 8. Tool Harness

### 8.1 File Operations (Rust Core)

Jean Code's file operations are implemented in Rust and run in-process. No shelling out to `cat`, `head`, `tail`, or `sed`.

**`read`** — Unified read interface for everything:

| Target | Behavior |
|---|---|
| Regular files | Read content, summarize if large |
| Directories | List contents with type filters |
| Archives | Read entries from .zip, .tar, .gz |
| SQLite | Query databases directly |
| PDFs | Extract text and structure |
| Notebooks | Read .ipynb cells |
| URLs | Fetch and parse web content |
| SSH paths | Read from remote servers |
| Internal schemes | `pr://`, `issue://`, `agent://`, `skill://`, `conflict://` |

**`write`** — Create or overwrite files, archive entries, SQLite rows.

**`edit`** — Two patch modes:

| Mode | Description | Best For |
|---|---|---|
| **Hashline** | Content-hash anchored patches with stale-anchor recovery | Default — 61% fewer tokens, lands on first attempt |
| **Unified diff** | Traditional unified diff patches | Legacy compatibility, human review |

Hashline edit example:
```
edit src/middleware/rate-limit.ts
  anchor: h:3f8a2b1c → "export class RateLimiter {"
  patch: |-|
    - private counter = 0;
    + private counter = new Map<string, number>();
    + 
    + private resetOnWindowRotation(windowKey: string) {
    +   if (!this.counter.has(windowKey)) {
    +     this.counter.set(windowKey, 0);
    +   }
    + }
```

If the anchor is stale (file changed since read), the applier uses surrounding context to recover — no "string not found" loops.

**`grep`** — ripgrep in-process. Regex over files, globs, and internal URLs. Fastest in the west.

**`glob`** — Parallel ignore-aware filesystem walker. Respects .gitignore. Shared scan cache with grep and workspace operations.

**`ignore`** — globset-based ignore pattern matching. Parses .gitignore, .ignore, and custom ignore files.

### 8.2 Shell (Rust Core)

**Embedded bash (brush)** — A fork of brush-shell, compiled into Jean Code. Sessions survive across calls — `export VAR=value` in one call, `$VAR` is available in the next.

**58 in-process coreutils:**

| Category | Utilities |
|---|---|
| **File ops** | `ls`, `cat`, `cp`, `mv`, `rm`, `mkdir`, `touch`, `chmod`, `chown`, `stat`, `file`, `wc`, `head`, `tail`, `sort`, `uniq`, `diff`, `patch` |
| **Text** | `sed`, `awk`, `grep`, `tr`, `cut`, `paste`, `join`, `comm`, `fold`, `fmt`, `expand`, `unexpand`, `pr`, `column` |
| **Data** | `jq`, `xargs`, `find`, `basename`, `dirname`, `readlink`, `realpath`, `mktemp`, `shuf`, `seq`, `bc`, `date`, `env`, `printenv`, `tee`, `yes` |

Zero fork/exec overhead. Every utility runs inside the Jean Code process.

**Background job dispatch** — Run long commands in the background with PTY support. Monitor output, kill jobs, collect results.

### 8.3 Code Intelligence (Rust Core)

**LSP (14 operations):**

| Operation | Description |
|---|---|
| `diagnostics` | Get errors, warnings, info for a file |
| `rename` | Rename symbol across entire codebase |
| `willRenameFiles` | Update re-exports, barrel files, aliased imports before file moves |
| `definition` | Go to definition |
| `references` | Find all references to a symbol |
| `implementation` | Find implementations of an interface |
| `typeDefinition` | Go to type definition |
| `documentSymbol` | List symbols in a document |
| `workspaceSymbol` | Search symbols across workspace |
| `codeAction` | Get available code actions |
| `codeLens` | Get code lenses |
| `hover` | Get hover information |
| `formatting` | Format document |
| `rawRequest` | Send raw LSP request |

LSP is wired into every write. When the agent renames a file, `workspace/willRenameFiles` fires automatically — re-exports, barrel files, and aliased imports update before the file moves.

**DAP (28 operations):**

| Operation | Description |
|---|---|
| `setBreakpoint` | Set a breakpoint |
| `clearBreakpoint` | Clear a breakpoint |
| `continue` | Continue execution |
| `next` | Step over |
| `stepIn` | Step into |
| `stepOut` | Step out |
| `pause` | Pause execution |
| `stackTrace` | Get stack trace |
| `scopes` | Get variable scopes |
| `variables` | Get variables in scope |
| `evaluate` | Evaluate expression |
| `threads` | Get threads |
| `configurationDone` | Signal configuration done |
| `launch` | Launch debuggee |
| `attach` | Attach to debuggee |
| `disconnect` | Disconnect debugger |
| `restart` | Restart session |
| `terminate` | Terminate debuggee |
| `breakpoints` | Get all breakpoints |
| `modules` | Get modules |
| `loadedSources` | Get loaded sources |
| `completions` | Get completions |
| `exceptionInfo` | Get exception info |
| `cancel` | Cancel request |
| `setExceptionBreakpoints` | Set exception breakpoints |
| `setFunctionBreakpoints` | Set function breakpoints |
| `setData` | Set data in memory |
| `readData` | Read data from memory |

Drives real debuggers: `lldb` (C segfault → attach, step to bad pointer, read frame), `dlv` (Go service hang → walk goroutines), `debugpy` (Python wedged → pause, inspect, evaluate).

**Tree-sitter (50+ language grammars):**

Scans the entire codebase and builds a code map: function names, class names, type names, directory structure. Used by the File Picker agent to find relevant files instantly.

### 8.4 Runtime Workers (TypeScript)

**Persistent Python kernel** — Long-lived Python interpreter. The agent sends code, gets results. State persists across calls.

**Persistent Bun kernel** — Long-lived JavaScript/TypeScript interpreter. Same model as Python.

**Loopback bridge** — Either kernel can call back into agent tools from within code:

```python
# Inside Python kernel
import jean
files = jean.read("src/config.yaml")
result = jean.grep("TODO", include="*.ts")
tasks = jean.task("summarize this data", result)
```

The agent loads a CSV from inside Python, charts from JS, never leaves the cell.

### 8.5 Browser & Desktop Control (TypeScript)

**Browser tool:**

| Mode | Description |
|---|---|
| **Headless Chromium** | Puppeteer over headless Chromium. Stealth mode on by default. |
| **CDP attach** | Attach to running apps (Slack, any Electron app) via Chrome DevTools Protocol |
| **Chrome relay** | Drive your own Chrome tabs via relay extension. No focus stealing. |

**Computer tool:**

Persistent JavaScript against the real host OS:

| Operation | Description |
|---|---|
| `windows()` | Enumerate all windows and displays |
| `screenshot()` | Capture screenshot of active window or full screen |
| `click(x, y)` | Send native mouse click |
| `type(text)` | Send native keyboard input |
| `accessibilityTree()` | Walk the OS accessibility tree |
| `clipboard()` | Read/write system clipboard |

Not the DOM — the actual desktop. The same desktop you're looking at.

### 8.6 Web Search Chain (TypeScript)

23-provider search chain. Providers are ranked and chained — if the top provider fails, the next one is tried automatically.

| Tier | Providers |
|---|---|
| **Primary** | Perplexity, Gemini, Exa, Tavily, Firecrawl |
| **Secondary** | SerpAPI, Serper, Brave, DuckDuckGo, SearXNG |
| **Tertiary** | Bing, Google Custom Search, You.com, Jina, Wolfram Alpha |
| **Specialized** | Arxiv (papers), GitHub (code), Stack Overflow (Q&A), Wikipedia |

Output is structured markdown with intact anchors. Arxiv PDFs, GitHub pages, Stack Overflow threads come back as clean markdown — cite, follow, quote, never lose where you came from.

### 8.7 Git & Platform Integration (TypeScript)

**Git operations:**

| Operation | Description |
|---|---|
| `git_overview` | Get working tree status, branch info, uncommitted changes |
| `git_file_diff` | Get diff for a specific file |
| `git_hunk` | Get specific hunk from a diff |
| `atomic_commit` | Split unrelated changes into atomic, dependency-ordered commits |
| `pr_create` | Create pull request with citations |
| `pr_review` | Review PR with P0-P3 ranking and confidence scores |

**GitHub as filesystem:**

`read pr://1428` returns the same shape as `read src/foo.ts`. PRs, issues, and code search are paths — one interface to teach the model, one surface to keep correct.

**Conflict resolution:**

Each merge conflict becomes one URL. The agent writes `@theirs`, `@ours`, or `@base` to `conflict://N`. Bulk form: `conflict://*`.

**Sourcegraph integration:**

Search code across public repositories for reference. `sourcegraph "rate limiter middleware TypeScript"` returns relevant code snippets from open source projects.

### 8.8 Security Scan (TypeScript)

Plans and runs native security reviews. Drives Codex Security cloud scans. Integrates with SAST/DAST tools.

### 8.9 Image Generation & TTS (TypeScript)

**Image generation** — Generate or edit raster images via Gemini, GPT, or Grok image models.

**Text-to-speech** — Text-to-speech via Grok Voice. Five built-in voices, WAV or MP3 output.

### 8.10 Rewind (TypeScript)

Prune exploratory context, keep a concise report. The agent can rewind to a checkpoint, discard everything since, and continue from a clean state.

---

## 9. Model Layer

### 9.1 Provider Architecture

```
┌─────────────────────────────────────────────────────┐
│  Model Layer (Provider-Agnostic)                     │
│                                                     │
│  Agent requests: "model(role: 'default')"           │
│       │                                              │
│       ▼                                              │
│  ┌─────────────────────────────────────────────┐   │
│  │  Role Resolver                               │   │
│  │  default → Sonnet 5                          │   │
│  │  smol → Flash                                │   │
│  │  slow → Opus 4.7                             │   │
│  │  ... (10 roles total)                        │   │
│  └─────────────────┬───────────────────────────┘   │
│                    │                                │
│                    ▼                                │
│  ┌─────────────────────────────────────────────┐   │
│  │  Provider Router                             │   │
│  │  1. Primary provider (Anthropic)             │   │
│  │  2. Fallback 1 (OpenAI)                      │   │
│  │  3. Fallback 2 (Google)                      │   │
│  └─────────────────┬───────────────────────────┘   │
│                    │                                │
│                    ▼                                │
│  ┌─────────────────────────────────────────────┐   │
│  │  Streaming Engine                            │   │
│  │  - Mid-token stream rules                    │   │
│  │  - Auto-compact at 95%                       │   │
│  │  - Adaptive thinking                         │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 9.2 10 Model Roles

| Role | Purpose | Default Model | Effort |
|---|---|---|---|
| `default` | Main agent interactions | Sonnet 5 | Adaptive |
| `smol` | Fast, cheap tasks (file picker, basher) | Flash / GPT-4o-mini | Low |
| `slow` | Deep reasoning (thinker, reviewer) | Opus 4.7 | High |
| `plan` | Planning & architecture | Sonnet 5 | High |
| `commit` | Writing commit messages | Flash | Low |
| `vision` | Image analysis, screenshot understanding | GPT-4o | Medium |
| `designer` | UI/UX design, visual layout | Sonnet 5 | Medium |
| `task` | Background tasks, scheduling | Flash | Low |
| `advisor` | Review & block (advisor layer) | Opus 4.7 | High |
| `tiny` | Trivial tasks (title generation, formatting) | GPT-4o-mini | Low |

### 9.3 Provider Categories

**Direct APIs (25+ providers):**

Anthropic, OpenAI, Google Gemini, Google Vertex, Google Antigravity, xAI, SuperGrok, DeepSeek, Mistral, Groq, Cerebras, Fireworks, Together, Baseten, Hugging Face, NVIDIA, Meta, Amazon Bedrock, Azure OpenAI, SiliconFlow, GMI Cloud, CoreWeave, Sakana AI, Synthetic, Vercel AI Gateway, Cloudflare AI Gateway, Wafer Serverless.

**Coding Plans (20+ providers):**

Cursor, GitHub Copilot, GitLab Duo, Devin, Kimi Code, Moonshot, MiniMax Coding Plan, Alibaba Coding Plan, Qwen Portal, Z.AI / GLM Coding Plan, Zhipu Coding Plan, Xiaomi MiMo, Qianfan, Umans, NanoGPT, Novita, Venice, Kilo, ZenMux.

**Gateways:**

OpenRouter (200+ models), Nous Portal (bundled tools: web search, image gen, TTS, browser).

**Local:**

vLLM, Ollama, llama.cpp, sglang — auto-detected on first run.

### 9.4 Streaming Features

**Mid-token stream rules:**

System reminders injected mid-token if a regex match detects off-script behavior. Course-corrects without context tax. Example: if the agent starts writing prose instead of code, a mid-token reminder redirects it.

**Auto-compact at 95%:**

When the conversation reaches 95% of the context window limit, Jean Code automatically summarizes the conversation and creates a new session with the summary. Prevents "out of context" errors.

**Smart compaction:**

After 5 minutes of idle (prompt cache expired), Jean Code creates non-lossy summaries that preserve 10–20 roundtrips of context. Deterministic strategy: user messages, assistant messages, and tool calls are all kept.

**Adaptive thinking:**

On by default. Adjusts reasoning depth based on task complexity. Simple tasks get shallow thinking; complex tasks get deep reasoning.

**Effort slider:**

Interactive control: `/effort fast` → `/effort normal` → `/effort high` → `/effort xhigh`. Maps to the provider's reasoning effort parameter.

**Fallback chain:**

Up to 3 fallback models tried in order on failure. If the primary model is rate-limited or errors, the fallback kicks in automatically. Transparent to the agent.

---

## 10. Memory & Skills System

### 10.1 Memory Operations

| Operation | Description | Example |
|---|---|---|
| `retain` | Store a fact or lesson from the current conversation | "Retain: user prefers TypeScript over JavaScript" |
| `learn` | Extract patterns and preferences from usage | Automatically learns coding style, project structure |
| `recall` | Search stored memory via FTS5 | "Recall: how does the auth system work?" |
| `reflect` | Periodic self-reflection, memory consolidation | Runs every 10 sessions, consolidates related memories |
| `memory_edit` | Manual memory editing | "Edit memory: change preferred linter to ESLint" |

### 10.2 Memory Backends

| Backend | Storage | Search | Use Case |
|---|---|---|---|
| **SQLite + FTS5** | Local SQLite database | Full-text search | Default — fast, local, no dependencies |
| **Hindsight** | Hindsight-compatible storage | Vector + FTS | Compatible with Hindsight ecosystem |
| **Mnemopi** | Mnemopi-compatible storage | Vector + FTS | Compatible with Mnemopi ecosystem |

### 10.3 Memory Lifecycle

```
Conversation → retain (store facts) → learn (extract patterns)
                                              │
                                              ▼
                                        SQLite/FTS5 store
                                              │
                                              ▼
recall (search) ←─────────────────── New conversation starts
                                              │
                                              ▼
reflect (consolidate) ←─────── Every 10 sessions
```

### 10.4 Skills System

**What is a skill?**

A skill is a reusable, self-contained unit of knowledge and behavior. It's a `SKILL.md` file that defines:

- **Trigger** — When the skill activates (keyword, pattern, context)
- **Inputs** — What parameters the skill accepts
- **Steps** — Step-by-step instructions for execution
- **Tools** — Which tools the skill can use
- **Output** — What the skill produces

**Built-in skills (40+):**

| Category | Skills |
|---|---|
| **MLOps** | Model training, evaluation, deployment, monitoring |
| **GitHub** | PR creation, code review, issue management, Actions |
| **Diagramming** | Generate diagrams from code, architecture diagrams |
| **Note-taking** | Create, organize, and search notes |
| **Documentation** | API docs, README generation, changelog |
| **Testing** | Test generation, test runner configuration |
| **Security** | Vulnerability scanning, dependency audit |
| **DevOps** | Docker, Kubernetes, CI/CD pipeline management |
| **Database** | Schema design, migration, query optimization |
| **API** | REST, GraphQL, gRPC API design and implementation |

**Automated skill creation:**

When the agent solves a hard problem, it writes a `SKILL.md` file that captures the solution. Future sessions can reuse it. The skill self-improves during use — the agent learns from each execution and updates the skill.

**Community hub (agentskills.io):**

Skills are published to agentskills.io. Browse, install, and share with one command:

```bash
jean skill install agent-name/skill-name
jean skill publish my-skill
```

**Skill self-improvement:**

After each skill execution, the agent evaluates the outcome and updates the skill if a better approach was discovered. Skills get better over time.

---

## 11. Agent Teams Architecture

### 11.1 The Four Components

| Component | Description |
|---|---|
| **Team Lead** | Main Claude Code session. Spawns teammates, creates tasks, assigns them, monitors progress, synthesizes results. Fixed for session lifetime. |
| **Teammates** | Separate Jean Code instances, each with own context window and model. Load project context (CLAUDE.md, MCP servers, skills) automatically. Do NOT inherit lead's conversation history. |
| **Task List** | Shared work items with 3 states: `pending`, `in progress`, `completed`. Supports dependencies — completing a task unblocks dependent ones. File locking prevents race conditions. |
| **Mailbox** | Direct inter-agent messaging via JSON files at `~/.jean/teams/{team-name}/inboxes/{agent-name}.json`. Teammates message each other directly. Malformed entries are validated, reported, and removed. |

### 11.2 Task List Structure

```json
{
  "tasks": [
    {
      "id": "task-1",
      "title": "Create rate limiter middleware",
      "status": "completed",
      "assigned_to": "auth-teammate",
      "dependencies": [],
      "created_at": "2026-08-09T01:00:00Z",
      "completed_at": "2026-08-09T01:15:00Z"
    },
    {
      "id": "task-2",
      "title": "Apply middleware to all public routes",
      "status": "in_progress",
      "assigned_to": "routes-teammate",
      "dependencies": ["task-1"],
      "created_at": "2026-08-09T01:00:00Z",
      "completed_at": null
    },
    {
      "id": "task-3",
      "title": "Write integration tests",
      "status": "pending",
      "assigned_to": null,
      "dependencies": ["task-2"],
      "created_at": "2026-08-09T01:00:00Z",
      "completed_at": null
    }
  ]
}
```

### 11.3 Mailbox Protocol

```json
{
  "from": "auth-teammate",
  "to": "session-teammate",
  "timestamp": "2026-08-09T01:10:00Z",
  "message": "I changed the JWT structure from {sub, exp} to {sub, exp, roles}. Please update your session decoder to handle the new roles field.",
  "type": "interface_change"
}
```

Teammates message each other directly. The lead does NOT relay messages. This removes the bottleneck of a single main agent relaying all information.

### 11.4 File Locking

When a teammate claims a task, a file lock is created:

```
~/.jean/teams/{team-name}/locks/task-2.lock
```

The lock contains the teammate's ID and timestamp. If another teammate tries to claim the same task, the lock prevents the race condition.

### 11.5 Plan Approval Flow

```
Teammate: "I plan to refactor auth by: 1) Extract JWT logic, 2) Add middleware, 3) Update routes"
    │
    ▼
Lead reviews plan autonomously:
    │
    ├─ APPROVED → Teammate proceeds with implementation
    │
    └─ REJECTED → "Your plan is missing test coverage. Revise and resubmit."
                         │
                         ▼
                    Teammate revises plan → resubmits → Lead reviews again
```

The lead can be influenced with criteria: "Only approve plans that include test coverage and documentation updates."

### 11.6 Hooks

| Hook | When | Exit Codes |
|---|---|---|
| `TeammateIdle` | When a teammate goes idle | 0 = shut down, 2 = keep working |
| `TaskCreated` | When a new task is created | 0 = allow, 2 = prevent creation |
| `TaskCompleted` | When a task is completed | 0 = allow, 2 = prevent completion (re-open) |

Hooks are external scripts that can gate teammate behavior. Exit 2 to block the action.

### 11.7 Display Modes

| Mode | Description |
|---|---|
| **In-process** (default) | All teammates in main terminal. Arrow keys to select, Enter to view/message, Escape to interrupt, `x` to stop, `Ctrl+T` for task list. Idle rows hide after 30s. More than 3 idle teammates collapse into a single row. |
| **Split panes** | Each teammate gets its own pane via tmux or iTerm2. Not supported in VS Code integrated terminal, Windows Terminal, or Ghostty. |

### 11.8 Model Selection for Teammates

Teammates don't inherit the lead's `/model` by default. Fallback chain:

1. Family alias specified in spawn prompt
2. Default teammate model (configured in `/config`)
3. Provider's default Opus model
4. Lead's current model

Checked against org's `availableModels` allowlist.

### 11.9 Teammate Lifecycle

```
Spawn → Load project context → Receive spawn prompt → Claim task from list
    → Execute (edit, test, review) → Message other teammates via mailbox
    → Report completion → Claim next task OR go idle
    → Graceful shutdown (lead requests) → Clean up shared directories
```

### 11.10 Limits

| Limit | Detail |
|---|---|
| No nested teams | Teammates cannot spawn their own teammates. Only the lead can manage the team. |
| One team per session | Exactly one team, scoped to that session. |
| No session resumption | `/resume` and `/rewind` do not restore in-process teammates. |
| No background subagents | In-process teammates cannot spawn background subagents. |
| Linear token cost | Each teammate has its own context window and consumes tokens independently. |

### 11.11 Agent Teams vs. Subagents

| Dimension | Subagents | Agent Teams |
|---|---|---|
| **Communication** | Report to main agent only | Direct inter-agent messaging |
| **Coordination** | Main agent manages all | Shared task list + self-claim |
| **Context** | Own window, results summarized | Own window, fully independent |
| **File isolation** | Optional worktrees | None (manual partition) |
| **Best for** | Focused tasks | Complex collaborative work |
| **Token cost** | Lower (results summarized) | Higher (each is full session) |
| **Nesting** | Unlimited depth | No nesting |
| **Session scope** | Within one session | One team per session |

---## 12. Sub-Agent System

### 12.1 Fan-Out Architecture

Subagents are spawned by the main agent (or by other subagents — unlimited nesting depth). Each subagent runs in its own context window and reports back structured results.

```
Main Agent
  │
  ├─► Subagent A (File Picker) ──► { files: ["src/auth.ts", "src/middleware.ts"] }
  │
  ├─► Subagent B (Researcher) ──► { findings: [{ url: "...", summary: "..." }] }
  │
  ├─► Subagent C (Editor) ──► { edits: [{ file: "...", patch: "..." }] }
  │
  └─► Subagent D (Reviewer) ──► { issues: [{ severity: "P1", message: "..." }] }
```

### 12.2 Schema-Validated Results

Each subagent declares an output schema. Results are validated against this schema before being returned to the parent:

```typescript
const editorAgent = {
  agent_type: "editor",
  outputSchema: {
    type: "object",
    properties: {
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            file: { type: "string" },
            patch: { type: "string" },
            lines_changed: { type: "number" }
          },
          required: ["file", "patch"]
        }
      },
      summary: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 }
    },
    required: ["edits", "summary"]
  }
}
```

No prose to parse. No merge conflicts between siblings. The parent reads structured data directly.

### 12.3 Worktree Isolation

Each subagent can run in an isolated worktree:

| Backend | OS | Performance |
|---|---|---|
| **APFS clones** | macOS | Instant (copy-on-write) |
| **btrfs reflinks** | Linux (btrfs) | Instant (copy-on-write) |
| **zfs reflinks** | Linux/FreeBSD (zfs) | Instant (copy-on-write) |
| **overlayfs** | Linux | Fast (union mount) |
| **projfs** | Windows | Fast (ReFS projection) |
| **rcopy** | Fallback | Slower (full copy) |

Changes in the worktree don't affect the main workspace. After validation, changes are merged back.

### 12.4 Context Inheritance

Subagents can optionally inherit the parent's conversation history:

| Setting | Behavior |
|---|---|
| `inheritContext: true` | Subagent receives the parent's full conversation history |
| `inheritContext: false` | Subagent starts fresh with only the spawn prompt |

Default is `false` — subagents start blank. This is cheaper and prevents context pollution.

### 12.5 Arbitrary Nesting

Agents spawn agents that spawn agents — unlimited depth. Each level contributes only structured results upward:

```
Level 0: Main Agent (orchestrator)
  Level 1: Editor Agent
    Level 2: Researcher Agent (looks up API docs)
      Level 3: File Picker Agent (finds relevant source files)
        → Returns { files: [...] }
      → Returns { findings: [...] }
    → Returns { edits: [...] }
  → Returns { result: "Feature complete" }
```

The orchestrator at each level sees only the structured output of its children. Context stays clean at every level.

### 12.6 RPC Pipeline Collapse

Multi-step pipelines can be collapsed into zero-context-cost turns via RPC. A Python script calls tools via RPC, and the results are returned as a single structured object:

```python
import jean.rpc as rpc

# Multi-step pipeline
files = rpc.call("glob", {"pattern": "src/**/*.ts"})
results = []
for f in files:
    content = rpc.call("read", {"path": f})
    analysis = rpc.call("llm", {"prompt": f"Analyze: {content}"})
    results.append(analysis)

rpc.set_output({"analysis": results})
```

The entire pipeline collapses into one turn in the agent's context.

---

## 13. Advisor Layer

### 13.1 Architecture

The advisor is a second model that watches every turn the main agent takes. It runs on its own context window and its own model.

```
┌─────────────────┐         ┌─────────────────┐
│   Main Agent    │────────►│   Advisor       │
│   (Sonnet 5)    │         │   (Opus 4.7)    │
│                 │◄────────│                 │
│  Reads, writes, │  Note   │  Watches every  │
│  edits, runs    │/Concern │  turn, detects  │
│  commands       │/Blocker │  issues         │
└─────────────────┘         └─────────────────┘
```

### 13.2 Three Injection Levels

| Level | Severity | Behavior |
|---|---|---|
| **Note** | Informational | Quiet aside — "FYI, this pattern is deprecated in v3" |
| **Concern** | Warning | "This approach has a race condition. Consider using a mutex." |
| **Blocker** | Hard stop | "This edit would break the public API. Do not proceed." |

### 13.3 Advisor Flow

```
Main agent generates: "I'll delete src/legacy/ and create src/new/"
    │
    ▼
Advisor reads the turn:
    │
    ├─ Detects: deletion of non-empty directory without migration
    │
    └─ Injects Blocker: "Deleting src/legacy/ will break 3 imports
        in src/app.ts. Migrate the imports first, then delete."
    │
    ▼
Main agent sees the blocker and course-corrects:
    "You're right. I'll migrate the imports first, then delete."
```

### 13.4 Advisor Configuration

| Setting | Description |
|---|---|
| `advisor.model` | Model for the advisor (default: Opus 4.7) |
| `advisor.enabled` | Enable/disable advisor (default: off in focus, on in autonomous) |
| `advisor.permissions` | Permission set for the advisor (can block, can suggest, can only note) |
| `advisor.patterns` | Regex patterns that trigger advisor review |

---

## 14. Execution Layer

### 14.1 Execution Backends

| Backend | Use Case | Setup | Persistence | Cost |
|---|---|---|---|---|
| **Local Terminal** | Default — run commands on your machine | None | N/A | Free |
| **Docker** | Isolated container with security hardening | Docker installed | Container lifecycle | Low |
| **SSH** | Remote server execution | SSH keys configured | Server lifecycle | Your server |
| **Daytona** | Serverless dev environments | Daytona account | Hibernates when idle | Near-zero when idle |
| **Modal** | Cloud GPU/compute | Modal account | Serverless | Pay per use |
| **Singularity** | HPC clusters | Singularity installed | Cluster lifecycle | Cluster cost |

### 14.2 Security Hardening

For Docker, Modal, and Singularity backends:

| Hardening | Description |
|---|---|
| **Read-only root** | Root filesystem is read-only. Writable tmp directory provided. |
| **Dropped capabilities** | All Linux capabilities dropped except those explicitly needed. |
| **PID limits** | Maximum number of processes limited to prevent fork bombs. |
| **Namespace isolation** | PID, network, mount, and user namespaces isolated. |
| **Seccomp filters** | System call filtering — only allowed syscalls can execute. |
| **No internet** | Optional — disable all network access for sandboxed execution. |

### 14.3 Backend Selection

```bash
# Use local terminal (default)
jean focus

# Use Docker sandbox
jean --execution docker autonomous "Build the feature"

# Use SSH remote
jean --execution ssh://deploy@prod-server swarm "Deploy and verify"

# Use Daytona serverless
jean --execution daytona autonomous "Run the test suite"
```

---

## 15. Multi-Platform Gateway

### 15.1 Gateway Architecture

```
┌─────────────────────────────────────────────────────┐
│  Gateway Process (Single Process)                    │
│                                                     │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐  │
│  │Telegram │ │ Discord │ │  Slack  │ │WhatsApp │  │
│  │  Bot    │ │  Bot    │ │  Bot    │ │  Bot    │  │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘  │
│       │           │           │           │        │
│       └───────────┴───────────┴───────────┘        │
│                          │                         │
│                  ┌───────▼───────┐                 │
│                  │  Message Router│                 │
│                  └───────┬───────┘                 │
│                          │                         │
│                  ┌───────▼───────┐                 │
│                  │ Session Manager│                 │
│                  │ (shared across │                 │
│                  │  all platforms)│                 │
│                  └───────┬───────┘                 │
│                          │                         │
│                  ┌───────▼───────┐                 │
│                  │  Agent        │                 │
│                  │  Orchestrator │                 │
│                  └───────────────┘                 │
└─────────────────────────────────────────────────────┘
```

### 15.2 Cross-Platform Continuity

Start a conversation on Telegram while commuting. Pick it up in your terminal at your desk. Same session, same context, same agent.

```
10:00 AM — Telegram: "Jean, refactor the auth module"
10:05 AM — Telegram: Agent: "I've created a plan. Should I proceed?"
10:10 AM — Telegram: "Yes, go ahead"
10:30 AM — Terminal: Agent: "Auth refactoring complete. 4 commits, all tests pass."
```

### 15.3 Voice Mode

| Platform | Voice Support |
|---|---|
| CLI | Real-time voice interaction (microphone + TTS) |
| Telegram | Voice memo transcription |
| Discord | Voice channel support (real-time) |
| WhatsApp | Voice memo transcription |
| Signal | Voice memo transcription |

### 15.4 Platform Setup

```bash
# Start gateway with all platforms
jean gateway start

# Interactive setup wizard
jean gateway setup

# Install as system service
jean gateway install

# Check platform status
jean gateway status
```

---

## 16. TUI / Desktop / Web UI

### 16.1 Terminal UI (TUI)

**Differential rendering** — Only changed regions are redrawn. No flicker. Smooth, polished experience.

**Components:**

| Component | Description |
|---|---|
| **Message stream** | Conversation history with tool call cards |
| **Tool call cards** | Structured display of tool calls with status, input, output |
| **Edit previews** | Show diff before landing — accept or reject |
| **Input bar** | Vim-mode input with full vim-style navigation |
| **Agent hub** | `Alt+A` — monitor, steer, or kill subagents in real-time |
| **Task list** | `Ctrl+T` — view shared task list (swarm mode) |
| **Status bar** | Model, mode, context usage, token count |
| **Split panes** | Each teammate gets its own pane (tmux / iTerm2) |

**Vim-mode input:**

| Key | Action |
|---|---|
| `i` | Insert mode |
| `Esc` | Normal mode |
| `h/j/k/l` | Navigate |
| `dd` | Delete line |
| `yy` | Yank line |
| `p` | Paste |
| `:` | Command mode |
| `Ctrl+E` | Open external editor |

**Screen reader mode:**

Plain linear text output for VoiceOver/NVDA compatibility. No differential rendering, no ANSI codes — just clean text.

### 16.2 Desktop App (Tauri)

Built with Tauri — smaller binary than Electron, native performance, Rust backend integration.

**Features:**

| Feature | Description |
|---|---|
| **Mission Control** | F3 or double-tap desktop — window manager view for all agents |
| **In-app browser** | Built-in browser for web content, PR reviews, docs |
| **Shadow workspaces** | Multiple projects, each with its own agent session |
| **Multi-agent view** | See all agents at once, monitor progress |
| **Desktop notifications** | Native notifications for task completion |
| **Auto-update** | Automatic updates with restart prompt |

### 16.3 Web IDE

Full browser experience with code editor, file tree, integrated terminal, and agent panel.

**Features:**

| Feature | Description |
|---|---|
| **Code editor** | Monaco-based editor with syntax highlighting, linting |
| **File tree** | Project file tree with search |
| **Integrated terminal** | Run commands in the browser |
| **Agent panel** | Monitor agent activity, view tool calls |
| **Session history** | Browse past sessions |
| **Stats panel** | Real-time metrics: prefill time, generation speed, context usage |
| **Notifications** | Event log, notifications |

---

## 17. Git & Platform Integration

### 17.1 Git Operations

Jean Code reads the working tree through `git_overview`, `git_file_diff`, and `git_hunk`. It splits unrelated changes into atomic commits ordered by their dependencies.

**Atomic commit process:**

1. Analyze all changed files
2. Build dependency graph (imports, function calls, type references)
3. Topological sort — source files before tests, tests before docs
4. Reject cycles — if A depends on B and B depends on A, merge into one commit
5. Score commits — source files get higher priority than tests/docs/configs
6. Exclude lock files from analysis

**Commit ordering example:**

```
Commit 1: Add RateLimiter class (src/middleware/rate-limit.ts) — Source
Commit 2: Add rate limiting middleware (src/middleware/index.ts) — Source
Commit 3: Apply middleware to routes (src/routes/*.ts) — Source
Commit 4: Add rate limiter tests (tests/rate-limit.test.ts) — Tests
Commit 5: Update API documentation (docs/api.md) — Docs
```

### 17.2 GitHub as Filesystem

`read pr://1428` returns the same shape as `read src/foo.ts`. One interface for everything:

| Scheme | Resolves To |
|---|---|
| `pr://1428` | Pull request #1428 files and diff |
| `issue://42` | Issue #42 description and comments |
| `commit://abc123` | Commit abc123 diff |
| `branch://feature-x` | Branch feature-x file tree |

### 17.3 Conflict Resolution

Each merge conflict becomes one URL:

```
conflict://1 — src/auth.ts (3 conflicts)
conflict://2 — src/middleware.ts (1 conflict)
conflict://* — all conflicts
```

The agent writes `@theirs`, `@ours`, or `@base` to resolve:

```
edit conflict://1
  resolution: @theirs  # Accept their version
edit conflict://2
  resolution: @ours    # Keep our version
edit conflict://*
  resolution: @base    # Fall back to base for all remaining
```

### 17.4 PR Review

`/review` spawns dedicated reviewer subagents that sweep branches, single commits, or uncommitted work in parallel. Clear verdict with P0-P3 ranking and confidence scores:

```
Review Verdict: APPROVE with conditions
───────────────────────────────────────
P0 (Critical): 0 issues
P1 (High):     2 issues — race condition in rate limiter counter
P2 (Medium):   5 issues — missing error handling, unused imports
P3 (Low):      3 issues — style nits, documentation gaps

Confidence: 94%
Reviewer: Opus 4.7 (advisor role)
```

---

## 18. Browser & Desktop Control

### 18.1 Browser Tool

| Mode | Description | Use Case |
|---|---|---|
| **Headless Chromium** | Puppeteer over headless Chromium. Stealth mode on by default. | Web scraping, testing web apps |
| **CDP attach** | Attach to running apps (Slack, any Electron app) via Chrome DevTools Protocol | Read Slack DMs, control desktop apps |
| **Chrome relay** | Drive your own Chrome tabs via relay extension. No focus stealing. | Browse the web as yourself |

**Stealth mode** — Pages see a normal user instead of a headless bot. Default on.

### 18.2 Computer Tool

Persistent JavaScript against the real host OS:

```javascript
// List all windows
const windows = computer.windows();
// → [{ title: "VS Code", pid: 12345, x: 0, y: 0, width: 1920, height: 1080 }]

// Capture screenshot
const screenshot = computer.screenshot();
// → Base64-encoded PNG

// Click at coordinates
computer.click(100, 200);

// Type text
computer.type("Hello, world!");

// Walk accessibility tree
const tree = computer.accessibilityTree();
// → [{ role: "button", name: "Submit", x: 100, y: 200 }]

// Read clipboard
const text = computer.clipboard.read();

// Write clipboard
computer.clipboard.write("Copied text");
```

Not the DOM — the actual desktop. The same desktop you're looking at.

---

## 19. Web Search Chain

### 19.1 23-Provider Chain

Providers are ranked and chained. If the top provider fails, the next one is tried automatically:

| Tier | Providers | Latency | Quality |
|---|---|---|---|
| **Primary** | Perplexity, Gemini, Exa, Tavily, Firecrawl | Fast | High |
| **Secondary** | SerpAPI, Serper, Brave, DuckDuckGo, SearXNG | Medium | Medium |
| **Tertiary** | Bing, Google Custom Search, You.com, Jina, Wolfram Alpha | Slow | Medium |
| **Specialized** | Arxiv, GitHub, Stack Overflow, Wikipedia | Varies | High (domain-specific) |

### 19.2 Output Format

Structured markdown with intact anchors:

```markdown
## Rate Limiter Best Practices

### Token Bucket Algorithm
The token bucket algorithm is the most common approach for rate limiting...
[Source: https://docs.example.com/rate-limiting](https://docs.example.com/rate-limiting)

### Implementation in TypeScript
```typescript
class TokenBucket {
  // ...
}
```
[Source: https://github.com/example/rate-limiter](https://github.com/example/rate-limiter)

### Common Pitfalls
1. Not resetting counters on window rotation
2. Not handling distributed environments
[Source: https://stackoverflow.com/questions/12345](https://stackoverflow.com/questions/12345)
```

Cite, follow, quote — never lose where you came from.

---

## 20. MCP & Plugin System

### 20.1 MCP (Model Context Protocol)

Connect to external tools via MCP — stdio and SSE connection types.

**Stdio MCP:**

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    },
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
    }
  }
}
```

**SSE MCP:**

```json
{
  "mcpServers": {
    "puppeteer": {
      "type": "sse",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

### 20.2 Permission System

Each MCP tool can be individually permitted or denied:

| Permission | Description |
|---|---|
| `allow` | Tool can be used without confirmation |
| `ask` | Tool requires user confirmation before each use |
| `deny` | Tool cannot be used |

Fine-grained control per tool, per session, per mode.

### 20.3 Plugin System

Plugins are TypeScript modules with access to the same tool API, slash-command registry, hotkey table, and TUI primitives as built-in tools. Nothing is reserved.

**Loading plugins:**

```bash
# Load from .zip
jean plugin install ./my-plugin.zip

# Load from URL
jean plugin install https://example.com/my-plugin.zip

# Reload without restart
/reload-plugins
```

**Plugin structure:**

```typescript
// my-plugin.ts
import { Plugin, Tool, SlashCommand } from "jean-sdk";

export default {
  name: "my-plugin",
  version: "1.0.0",
  tools: [
    {
      name: "my_tool",
      description: "Does something useful",
      parameters: { /* JSON Schema */ },
      handler: async (params) => { /* ... */ }
    }
  ],
  commands: [
    {
      name: "my-command",
      description: "My custom command",
      handler: async (context) => { /* ... */ }
    }
  ],
  hotkeys: [
    {
      key: "Ctrl+M",
      action: "my-action"
    }
  ]
} as Plugin;
```

**PATH injection:**

Plugin executables are added to the bash tool's PATH. The agent can run them like any other command:

```bash
# Plugin installs a binary
jean plugin install ./my-plugin.zip
# Binary is now on PATH
bash my-plugin-binary --help
```

---## 21. Scheduler & Automations

### 21.1 Scheduler Types

| Type | Description | Example |
|---|---|---|
| **Cron** | Recurring tasks on a schedule | "Run tests every morning at 9 AM" |
| **One-off** | Run once at a specific time | "Deploy to staging at 2 PM today" |
| **Trigger-based** | Run when an event occurs | "Fix CI failures on main", "Review PRs when opened" |
| **Always-on** | Persistent monitoring agents | "Watch for security vulnerabilities", "Monitor API health" |

### 21.2 Cron Scheduling

```bash
# Recurring: daily at 9 AM UTC
jean schedule add --name "Daily tests" --cron "0 9 * * *" --prompt "Run the full test suite and report results"

# Recurring: every Monday at 10 AM UTC
jean schedule add --name "Weekly review" --cron "0 10 * * 1" --prompt "Review all open PRs and provide feedback"

# Recurring: every 6 hours
jean schedule add --name "Health check" --cron "0 */6 * * *" --prompt "Check API health endpoints and alert if down"
```

### 21.3 One-off Scheduling

```bash
# Run once at specific time
jean schedule add --name "Deploy" --at "2026-08-10T14:00:00Z" --prompt "Deploy main branch to production"
```

### 21.4 Trigger-based Automations

```bash
# Trigger on CI failure
jean schedule add --name "Fix CI" --trigger "ci_failure" --prompt "Root cause the CI failure and fix it"

# Trigger on PR open
jean schedule add --name "Review PR" --trigger "pr_opened" --prompt "Review the new PR and provide feedback"

# Trigger on branch push
jean schedule add --name "Run tests" --trigger "branch_push:main" --prompt "Run tests on the latest push to main"
```

### 21.5 Always-on Agents

```bash
# Persistent monitoring agent
jean schedule add --name "Security monitor" --always-on --prompt "Monitor for security vulnerabilities in dependencies"

# Persistent health check
jean schedule add --name "API monitor" --always-on --prompt "Check API health every 5 minutes, alert if down"
```

### 21.6 Mobile Push Notifications

When a long-running task finishes or the agent needs user input, Jean Code sends a push notification to your phone. Available for iOS and Android.

```bash
# Enable push notifications
jean config set push.enabled true

# Configure push provider
jean config set push.provider pushover  # or apns, fcm
```

### 21.7 Schedule Management

```bash
# List all schedules
jean schedule list

# Enable a disabled schedule
jean schedule enable <id>

# Disable a schedule (pause)
jean schedule disable <id>

# Remove a schedule
jean schedule remove <id>

# View execution history
jean schedule history [--id <id>]

# View timezone and current time
jean schedule timezone
```

---

## 22. Collaboration Mode

### 22.1 Collab Mode

`/collab` puts your live session on a relay and hands back a link — and a QR code. A teammate joins from another terminal with `jean collab join <link>`, or just opens it in a browser.

**Modes:**

| Mode | Description |
|---|---|
| **Read-write** | Pair on the same agent — both can steer |
| **Read-only** | Anyone can watch but no one can steer (`/collab view`) |

**Security:**

Frames are sealed client-side. The relay never sees your keys, code, or conversation content. End-to-end encryption via WebSocket.

### 22.2 Collab Flow

```
Host terminal:
  $ jean
  > /collab
  → Session shared: https://jean.sh/collab/abc123
  → QR code displayed

Guest terminal:
  $ jean collab join https://jean.sh/collab/abc123
  → Joined session as read-write collaborator

Guest browser:
  Open https://jean.sh/collab/abc123
  → Live view of the session (read-only or read-write)
```

### 22.3 Real-time Sync

Both participants see the same conversation, tool calls, and agent output in real-time. Input from either participant is routed to the same agent session.

---

## 23. Security Model

### 23.1 Permission Levels

| Level | Description | Tools Allowed |
|---|---|---|
| **Full** | All tools available, no restrictions | Everything |
| **Auto** | Classifier handles permissions, blocks risky actions | Most tools, risky ones auto-blocked |
| **Ask** | User must approve each tool call | Everything, with confirmation |
| **Limited** | Only safe tools available | Read, grep, glob, LSP diagnostics |
| **None** | No tools available | None (read-only chat) |

### 23.2 Auto Mode Rules

In auto mode, Jean Code uses a classifier to handle permissions automatically:

| Action | Behavior |
|---|---|
| **Read files** | Always allowed |
| **Edit files** | Allowed (non-destructive) |
| **Run bash** | Allowed (non-destructive commands) |
| **`rm -rf`** | Blocked — asks before `rm -rf` on unresolved variables |
| **`git reset --hard`** | Blocked — destructive git commands when not asked to discard |
| **`git push --force`** | Blocked — requires explicit user confirmation |
| **Network requests** | Allowed (unless sandboxed) |
| **Transcript tampering** | Blocked — cannot modify conversation history |
| **Credential access** | Blocked — cannot read .env, .npmrc, or other secret files |

### 23.3 Hard Deny Rules

Block actions unconditionally, regardless of mode:

```json
{
  "hardDeny": [
    "rm -rf /",
    "rm -rf ~",
    "format /dev/sda",
    "curl | bash",
    "wget | sh"
  ]
}
```

### 23.4 Permission Inheritance

| Context | Inheritance |
|---|---|
| **Subagents** | Inherit parent's permission level |
| **Agent Teams** | Teammates start with lead's permission mode. Can change individual teammate modes after spawning, but not at spawn time. |
| **Background sessions** | Permission requests bubble up to the lead session |
| **MCP tools** | Individual permission per tool (allow/ask/deny) |

### 23.5 Sandbox Security

For Docker, Modal, and Singularity execution backends:

| Hardening | Description |
|---|---|
| **Read-only root** | Root filesystem is read-only |
| **Dropped capabilities** | All Linux capabilities dropped except those explicitly needed |
| **PID limits** | Maximum number of processes limited |
| **Namespace isolation** | PID, network, mount, and user namespaces |
| **Seccomp filters** | System call filtering |
| **No internet** | Optional — disable all network access |

### 23.6 Zero Telemetry

Jean Code collects zero telemetry and zero data. All processing happens on your machine. All memory is stored locally. Optional cloud features (sandbox execution, hosted sandboxes) are opt-in and transparent.

---

## 24. Configuration System

### 24.1 Config File

Main config file: `~/.jean/config.json`

```json
{
  "model": {
    "provider": "anthropic",
    "modelId": "claude-sonnet-5-20251002",
    "apiKey": "${ANTHROPIC_API_KEY}"
  },
  "agents": {
    "default": {
      "model": "claude-sonnet-5-20251002",
      "maxTokens": 8192
    },
    "smol": {
      "model": "claude-sonnet-4-5-20250514",
      "maxTokens": 4096
    },
    "slow": {
      "model": "claude-opus-4-7-20250731",
      "maxTokens": 16384
    },
    "advisor": {
      "model": "claude-opus-4-7-20250731",
      "maxTokens": 8192
    }
  },
  "teammateMode": "auto",
  "defaultTeammateModel": "claude-sonnet-4-5-20250514",
  "autoCompact": true,
  "compactThreshold": 0.95,
  "permissionMode": "auto",
  "shell": {
    "path": "/bin/bash",
    "args": ["-l"]
  },
  "lsp": {
    "typescript": {
      "disabled": false,
      "command": "typescript-language-server",
      "args": ["--stdio"]
    },
    "python": {
      "disabled": false,
      "command": "pyright-langserver",
      "args": ["--stdio"]
    }
  },
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  },
  "memory": {
    "backend": "sqlite",
    "path": "~/.jean/memory.db"
  },
  "execution": {
    "backend": "local",
    "docker": {
      "image": "node:20-slim",
      "security": {
        "readOnlyRoot": true,
        "dropCapabilities": true,
        "pidLimit": 100
      }
    }
  },
  "debug": false
}
```

### 24.2 Local Config

Project-local config: `.jean.json` in the project root. Overrides global config for that project only.

```json
{
  "agents": {
    "default": {
      "model": "claude-opus-4-7-20250731"
    }
  },
  "permissionMode": "full",
  "lsp": {
    "go": {
      "disabled": false,
      "command": "gopls"
    }
  }
}
```

### 24.3 Environment Variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GOOGLE_API_KEY` | Google API key |
| `LOCAL_ENDPOINT` | Self-hosted model endpoint |
| `JEAN_EXECUTION` | Default execution backend |
| `JEAN_PERMISSION_MODE` | Default permission mode |
| `SHELL` | Default shell to use |

### 24.4 Import Compatibility

Jean Code reads config from 8 formats on first run — no migration script needed:

| Format | Source |
|---|---|
| `.jean/` | Jean Code native |
| `.claude/` | Claude Code |
| `.cursor/` | Cursor |
| `.windsurf/` | Windsurf |
| `.gemini/` | Gemini CLI |
| `.codex/` | Codex CLI |
| `.cline/` | Cline |
| `.github/copilot` | GitHub Copilot |
| `.vscode/` | VS Code settings |

Rules, skills, and MCP servers are inherited automatically.

---

## 25. CLI Reference

### 25.1 Main Commands

```bash
# Start Jean Code (focus mode — default)
jean

# Start in focus mode explicitly
jean focus

# Start in autonomous mode
jean autonomous "Add rate limiting to all public API routes"

# Start in swarm mode
jean swarm "Refactor the entire authentication system"

# One-shot prompt (non-interactive)
jean -p "Explain the architecture of this codebase"

# One-shot with JSON output
jean -p "List all TypeScript files" -f json

# One-shot quiet (no spinner)
jean -p "Count lines of code" -q

# Start gateway
jean gateway start

# Gateway setup wizard
jean gateway setup

# Gateway status
jean gateway status

# Install as system service
jean gateway install

# Collab join
jean collab join <link>

# Resume a previous session
jean resume

# List sessions
jean sessions

# Update Jean Code
jean update

# Diagnose issues
jean doctor

# View version
jean --version
```

### 25.2 Flags

| Flag | Short | Description |
|---|---|---|
| `--model <provider:model>` | `-m` | Set model for this session |
| `--execution <backend>` | `-e` | Set execution backend |
| `--permission-mode <mode>` | `-p` | Set permission mode |
| `--teammate-mode <mode>` | `-t` | Set teammate display mode |
| `--config <file>` | `-c` | Use custom config file |
| `--output-format <format>` | `-f` | Output format for non-interactive mode (text, json) |
| `--quiet` | `-q` | Suppress spinner in non-interactive mode |
| `--debug` | | Enable debug logging |
| `--no-session` | | Run without creating a session |
| `--mode rpc` | | Run in RPC mode (JSON-RPC over stdio) |
| `--mode acp` | | Run in ACP mode (Agent Client Protocol) |

### 25.3 Completion Scripts

Jean Code generates its own completion scripts for bash, zsh, and fish from live command/flag metadata — they never drift from the actual CLI:

```bash
# zsh
eval "$(jean completions zsh)"

# bash
eval "$(jean completions bash)"

# fish
jean completions fish | source
```

Subcommands, flags, and enum values complete statically. Model names (`--model`, `--smol`, `--slow`, `--plan`) resolve against the bundled model catalog. `--resume` resolves against on-disk sessions.

---

## 26. Slash Commands

### 26.1 Mode Commands

| Command | Description |
|---|---|
| `/focus` | Switch to focus mode (single agent) |
| `/autonomous` | Switch to autonomous mode (multi-agent pipeline) |
| `/swarm` | Switch to swarm mode (agent teams) |

### 26.2 Session Commands

| Command | Description |
|---|---|
| `/clear` | Clear conversation context |
| `/compress` | Compress conversation context |
| `/rewind` | Resume from before last `/clear` |
| `/fork` | Copy conversation into new background session |
| `/cd <path>` | Move session to new directory without rebuilding cache |
| `/resume` | Resume a previous session |
| `/new` | Start fresh conversation |
| `/reset` | Start fresh conversation (alias for `/new`) |
| `/retry` | Retry the last turn |
| `/undo` | Undo the last turn |
| `/stop` | Interrupt current work |

### 26.3 Model Commands

| Command | Description |
|---|---|
| `/model [provider:model]` | Change model mid-session |
| `/effort [fast\|normal\|high\|xhigh]` | Set reasoning effort level |
| `/usage` | Show token usage and context stats |
| `/insights [--days N]` | Cross-session insights |

### 26.4 Agent Commands

| Command | Description |
|---|---|
| `/advisor` | Toggle advisor layer on/off |
| `/review` | Spawn reviewer subagents for code review |
| `/vibe` | Director mode — drive persistent worker sessions |
| `/fresh` | Reset provider stream state |
| `/goal <condition>` | Keep working until completion condition holds |
| `/loop [interval]` | Self-pacing agent loop |
| `/autofix-pr <pr-number>` | Auto-fix issues in a PR |
| `/code-review` | Generate correctness bug report |
| `/powerup` | Interactive lessons and tips |

### 26.5 Team Commands

| Command | Description |
|---|---|
| `/spawn <role> <prompt>` | Spawn a teammate with a specific role |
| `/tasks` | View shared task list |
| `/mailbox` | View mailbox messages |
| `/shutdown <teammate>` | Gracefully shutdown a teammate |

### 26.6 Configuration Commands

| Command | Description |
|---|---|
| `/config key=value` | Set any setting from prompt |
| `/config` | View current configuration |
| `/personality <name>` | Set agent personality |
| `/platforms` | List connected platforms |
| `/status` | Show platform-specific status |
| `/sethome` | Set home platform |

### 26.7 Collaboration Commands

| Command | Description |
|---|---|
| `/collab` | Share session via link + QR (read-write) |
| `/collab view` | Share session via link + QR (read-only) |
| `/team-onboarding` | Package setup into replayable guide |

### 26.8 Plugin Commands

| Command | Description |
|---|---|
| `/reload-plugins` | Reload all plugins without restart |
| `/plugin install <path>` | Install a plugin |
| `/plugin list` | List installed plugins |
| `/plugin remove <name>` | Remove a plugin |

---

## 27. Internal URL Schemes

Jean Code uses 16 internal URL schemes that resolve transparently inside every filesystem-shaped tool the agent already calls. `read pr://1428` returns the same shape as `read src/foo.ts`. `grep` walks a diff like a directory.

| Scheme | Resolves To | Example |
|---|---|---|
| `pr://` | Pull request files and diff | `read pr://1428` |
| `issue://` | Issue description and comments | `read issue://42` |
| `agent://` | Subagent output by path | `read agent://reviewer/findings.0.path` |
| `skill://` | Skill definition files | `read skill://github-review` |
| `ssh://` | Remote server files | `read ssh://deploy@server:/var/log/app.log` |
| `conflict://` | Merge conflict resolution | `edit conflict://1` |
| `file://` | Local files (explicit) | `read file://src/index.ts` |
| `memory://` | Stored memory entries | `read memory://auth-pattern` |
| `archive://` | Archive entries | `read archive://backup.zip:src/config.yaml` |
| `sqlite://` | SQLite database queries | `read sqlite://app.db:SELECT * FROM users` |
| `commit://` | Commit diff | `read commit://abc123` |
| `branch://` | Branch file tree | `read branch://feature-x` |
| `tag://` | Tagged release | `read tag://v1.0.0` |
| `diff://` | Unified diff | `read diff://main...feature-x` |
| `stash://` | Git stash | `read stash://0` |
| `worktree://` | Worktree files | `read worktree://subagent-1/src/index.ts` |

### Conflict Resolution Schemes

| Scheme | Description |
|---|---|
| `conflict://N` | Specific conflict by number |
| `conflict://*` | All conflicts (bulk resolution) |
| `@theirs` | Accept their version |
| `@ours` | Keep our version |
| `@base` | Fall back to base version |

---## 28. Tech Stack

### 28.1 Core Technologies

| Layer | Technology | Rationale |
|---|---|---|
| **Core Engine** | Rust | Performance-critical paths: file ops, shell, LSP, DAP, grep, glob, hashline, tree-sitter. Zero fork/exec. |
| **Agent Framework** | TypeScript | Rapid iteration, generator functions, async/await, massive ecosystem for LLM integration |
| **TUI** | Rust (ratatui) + TypeScript (React TUI) | Differential rendering in Rust, complex components in React |
| **Desktop App** | Tauri (Rust backend + web frontend) | Smaller than Electron, native performance, Rust backend integration |
| **Web IDE** | React + TypeScript + Monaco | Full browser experience with code editor |
| **Messaging Gateway** | TypeScript | Single process, 20+ platforms, WebSocket + REST |
| **Database** | SQLite (local) + optional PostgreSQL (team) | Lightweight, full-text search via FTS5, zero config |
| **IPC** | JSON-RPC over stdio + WebSocket | ACP-compatible, cross-process, cross-platform |
| **Build System** | Cargo (Rust) + Turborepo (TypeScript monorepo) | Parallel builds, shared config, incremental |
| **FFI** | Neon or N-API | Rust → TypeScript bindings for core operations |

### 28.2 Key Rust Crates

| Crate | Purpose | Dependencies |
|---|---|---|
| `pi-shell` | Embedded bash (brush fork) | brush-core |
| `pi-ast` | Tree-sitter-based code summarizer (50+ grammars) | tree-sitter, tree-sitter-highlight |
| `pi-iso` | Task isolation (APFS, btrfs, zfs, overlayfs, projfs) | libc |
| `pi-voice` | Audio capture/playback, Opus codecs, WebRTC | symphonia, cpal |
| `pi-walker` | Parallel ignore-aware filesystem walker | ignore, globset, tokio |
| `brush-core` | Bash parser and executor | nom, thiserror |
| `pi-builtins` | 58 coreutils implementations | serde, regex |
| `hashline` | Line-anchored patch language and applier | sha2, diff |
| `snapcompact` | Bitmap-frame context compression | bitvec, serde |
| `pi-mnemopi` | Memory backend for Mnemopi | sqlite, fts5 |
| `pi-natives` | N-API bindings (aggregates all crates) | neon / napi |

### 28.3 Key TypeScript Packages

| Package | Purpose | Dependencies |
|---|---|---|
| `@jean/core` | Agent loop, orchestrator, context management | eventstore, zod |
| `@jean/teams` | Agent Teams implementation | fs-lock, json-rpc |
| `@jean/subagents` | Sub-agent fan-out, worktree isolation | child_process, zod |
| `@jean/tools` | Tool registry, browser, computer, search | puppeteer, playwright |
| `@jean/model` | Model layer, 60+ providers, streaming | openai, @anthropic-ai/sdk, axios |
| `@jean/tui` | React TUI components | react, ink, ratatui bindings |
| `@jean/gateway` | Multi-platform gateway | telegraf, discord.js, @slack/bolt |
| `@jean/memory` | Memory system, SQLite/FTS5 | better-sqlite3, fts5 |
| `@jean/skills` | Skill engine, auto-gen, hub | front-matter, yaml |
| `@jean/mcp` | MCP stdio + SSE | @modelcontextprotocol/sdk |
| `@jean/sdk` | Embeddable SDK | typescript, zod |
| `@jean/evals` | Evaluation framework | jest, playwright |

### 28.4 Monorepo Structure

```
jean-code/
├── Cargo.toml                    # Rust workspace
├── Cargo.lock
├── package.json                  # TypeScript workspace (Turborepo)
├── turbo.json
├── tsconfig.json
├── crates/                       # Rust crates
│   ├── pi-shell/
│   ├── pi-ast/
│   ├── pi-iso/
│   ├── pi-voice/
│   ├── pi-walker/
│   ├── brush-core/
│   ├── pi-builtins/
│   ├── hashline/
│   ├── snapcompact/
│   ├── pi-mnemopi/
│   └── pi-natives/               # N-API bindings
├── packages/                     # TypeScript packages
│   ├── core/                     # jean-core (agent loop)
│   ├── agent/                    # jean-agent (orchestrator)
│   ├── teams/                    # jean-teams
│   ├── subagents/                # jean-subagents
│   ├── advisor/                  # jean-advisor
│   ├── tools/                    # jean-tools
│   ├── git/                      # jean-git
│   ├── memory/                   # jean-memory
│   ├── skills/                   # jean-skills
│   ├── mcp/                      # jean-mcp
│   ├── plugins/                  # jean-plugins
│   ├── model/                    # jean-model
│   ├── tui/                      # jean-tui
│   ├── desktop/                  # jean-desktop (Tauri)
│   ├── web/                      # jean-web
│   ├── gateway/                  # jean-gateway
│   ├── execution/                # jean-execution
│   ├── scheduler/                # jean-scheduler
│   ├── collab/                   # jean-collab
│   ├── cli/                      # jean-cli
│   ├── config/                   # jean-config
│   ├── acp/                      # jean-acp
│   ├── sdk/                      # jean-sdk
│   ├── projects/                 # jean-projects
│   └── evals/                    # jean-evals
├── skills/                       # 40+ built-in SKILL.md files
├── tests/                        # Integration + e2e tests
├── docs/                         # Documentation
└── scripts/                      # Build, test, deploy scripts
```

---

## 29. Directory Structure

### 29.1 Rust Core (`crates/`)

```
crates/
├── pi-shell/                     # Embedded bash
│   └── src/
│       ├── parser.rs             # Bash parser
│       ├── executor.rs           # Command executor
│       ├── session.rs            # Session state management
│       ├── pty.rs                # PTY support
│       └── background.rs         # Background job dispatch
│
├── pi-ast/                       # Tree-sitter code analysis
│   └── src/
│       ├── summarizer.rs         # Code summarizer
│       ├── symbols.rs            # Symbol extraction
│       ├── grammars/             # 50+ language grammars
│       └── navigation.rs         # Definition, references, etc.
│
├── pi-iso/                       # Task isolation
│   └── src/
│       ├── apfs.rs               # APFS clones (macOS)
│       ├── btrfs.rs              # Btrfs reflinks (Linux)
│       ├── zfs.rs                # ZFS reflinks
│       ├── overlayfs.rs          # OverlayFS (Linux)
│       ├── projfs.rs             # ProjFS (Windows)
│       └── rcopy.rs              # Fallback full copy
│
├── pi-voice/                     # Audio processing
│   └── src/
│       ├── capture.rs            # Audio capture
│       ├── playback.rs           # Audio playback
│       ├── opus.rs               # Opus codec
│       └── webrtc.rs             # WebRTC streaming
│
├── pi-walker/                    # Filesystem walker
│   └── src/
│       ├── walker.rs             # Parallel FS walker
│       ├── cache.rs              # Scan cache
│       └── ignore.rs             # Gitignore-aware filtering
│
├── brush-core/                   # Bash core utilities
│   └── src/
│       ├── ls.rs
│       ├── sed.rs
│       ├── sort.rs
│       ├── xargs.rs
│       ├── jq.rs
│       ├── grep.rs
│       ├── find.rs
│       └── ...                   # 52 more utilities
│
├── hashline/                     # Hashline patch system
│   └── src/
│       ├── anchor.rs             # Content-hash anchors
│       ├── patch.rs              # Patch language
│       ├── applier.rs            # Patch applier with recovery
│       └── stale.rs              # Stale-anchor recovery
│
├── snapcompact/                  # Context compression
│   └── src/
│       ├── bitmap.rs             # Bitmap-frame compression
│       ├── summarizer.rs         # Non-lossy summarization
│       └── eval.rs               # SQuAD evaluation suite
│
├── pi-mnemopi/                   # Memory backend
│   └── src/
│       ├── sqlite.rs             # SQLite storage
│       ├── fts5.rs               # Full-text search
│       └── vector.rs             # Vector search
│
└── pi-natives/                   # N-API bindings
    └── src/
        ├── lib.rs                # Aggregate all crates
        ├── file_ops.rs           # FFI: read, write, edit
        ├── shell.rs              # FFI: bash, coreutils
        ├── lsp.rs                # FFI: LSP operations
        ├── dap.rs                # FFI: DAP operations
        ├── grep.rs               # FFI: grep
        ├── glob.rs               # FFI: glob
        └── ...                   # More FFI bindings
```

### 29.2 TypeScript Packages (`packages/`)

```
packages/
├── core/                         # jean-core — Agent loop
│   └── src/
│       ├── eventstore.ts         # EventStore (single source of truth)
│       ├── loop.ts               # Multi-turn agent loop
│       ├── compaction.ts         # Auto-compact, smart compaction
│       └── context.ts            # Context window management
│
├── agent/                        # jean-agent — Orchestrator
│   └── src/
│       ├── orchestrator/
│       │   ├── index.ts          # Main orchestrator
│       │   ├── pipeline.ts       # Specialized agent pipeline
│       │   └── selector.ts       # Best-of-N selection
│       ├── agents/
│       │   ├── editor.ts         # Code editing agent
│       │   ├── reviewer.ts       # Code review agent
│       │   ├── researcher.ts     # Web search agent
│       │   ├── thinker.ts        # Deep analysis agent
│       │   ├── file-picker.ts    # File discovery agent
│       │   ├── basher.ts         # Terminal command agent
│       │   ├── code-searcher.ts  # Pattern matching agent
│       │   └── planner.ts        # Task breakdown agent
│       ├── contract/
│       │   ├── criteria.ts       # Acceptance criteria
│       │   └── verifier.ts       # Contract verification
│       ├── generator/
│       │   └── handle-steps.ts   # Generator function control
│       └── structured/
│           └── output.ts         # JSON Schema output
│
├── teams/                        # jean-teams — Agent Teams
│   └── src/
│       ├── lead/
│       │   ├── spawn.ts          # Spawn teammates
│       │   ├── assign.ts         # Task assignment
│       │   ├── monitor.ts        # Progress monitoring
│       │   └── synthesize.ts     # Result synthesis
│       ├── teammate/
│       │   ├── lifecycle.ts      # Teammate lifecycle
│       │   ├── claim.ts          # Task claiming
│       │   └── execute.ts        # Task execution
│       ├── tasklist/
│       │   ├── index.ts          # Shared task list
│       │   ├── lock.ts           # File locking
│       │   └── dependency.ts     # Dependency tracking
│       ├── mailbox/
│       │   ├── index.ts          # Inter-agent messaging
│       │   └── validate.ts       # Message validation
│       ├── approval/
│       │   ├── plan.ts           # Plan submission
│       │   └── review.ts         # Plan review/reject
│       ├── hooks/
│       │   ├── idle.ts           # TeammateIdle hook
│       │   ├── created.ts        # TaskCreated hook
│       │   └── completed.ts      # TaskCompleted hook
│       └── display/
│           ├── in-process.ts     # In-process display
│           └── split-pane.ts     # Split pane display
│
├── subagents/                    # jean-subagents
│   └── src/
│       ├── fanout.ts             # Parallel spawning
│       ├── schema.ts             # JSON Schema validation
│       ├── worktree.ts           # Worktree isolation
│       ├── context.ts            # Context inheritance
│       ├── nesting.ts            # Arbitrary nesting
│       └── rpc.ts                # RPC pipeline collapse
│
├── advisor/                      # jean-advisor
│   └── src/
│       ├── watcher.ts            # Monitor main agent turns
│       ├── injector.ts           # Inline note/blocker injection
│       ├── config.ts             # Advisor configuration
│       └── escalation.ts         # Hard blocker escalation
│
├── tools/                        # jean-tools
│   └── src/
│       ├── registry.ts           # Central tool registry
│       ├── browser/              # Browser tool
│       │   ├── chromium.ts       # Headless Chromium
│       │   ├── cdp.ts            # CDP attach
│       │   └── relay.ts          # Chrome relay extension
│       ├── computer/             # Computer tool
│       │   ├── windows.ts        # Window enumeration
│       │   ├── screenshot.ts     # Screenshot capture
│       │   ├── input.ts          # Native input
│       │   ├── ax-tree.ts        # Accessibility tree
│       │   └── clipboard.ts      # Clipboard
│       ├── web-search/           # Web search chain
│       │   ├── chain.ts          # 23-provider chain
│       │   └── providers/        # Individual providers
│       ├── runtime/              # Runtime workers
│       │   ├── python.ts         # Python kernel
│       │   ├── bun.ts            # Bun kernel
│       │   └── loopback.ts       # Loopback bridge
│       ├── security.ts           # Security scan
│       ├── image-gen.ts          # Image generation
│       ├── tts.ts                # Text-to-speech
│       ├── rewind.ts             # Context rewind
│       ├── inspect-image.ts      # Vision AI
│       └── voice.ts              # Voice mode
│
├── git/                          # jean-git
│   └── src/
│       ├── git.ts                # Core git operations
│       ├── github.ts             # GitHub API
│       ├── gitlab.ts             # GitLab API
│       ├── sourcegraph.ts        # Sourcegraph integration
│       ├── atomic.ts             # Atomic commits
│       ├── conflict.ts           # Conflict resolution
│       └── review.ts             # PR review
│
├── memory/                       # jean-memory
│   └── src/
│       ├── retain.ts             # Store facts
│       ├── learn.ts              # Extract patterns
│       ├── recall.ts             # FTS5 search
│       ├── reflect.ts            # Self-reflection
│       ├── edit.ts               # Manual editing
│       └── backends/
│           ├── sqlite.ts         # SQLite + FTS5
│           ├── hindsight.ts      # Hindsight compatibility
│           └── mnemopi.ts        # Mnemopi compatibility
│
├── skills/                       # jean-skills
│   └── src/
│       ├── engine.ts             # Skill execution
│       ├── autogen.ts            # Automated skill creation
│       ├── hub.ts                # agentskills.io integration
│       ├── builtin/              # 40+ built-in skills
│       └── improve.ts            # Skill self-improvement
│
├── mcp/                          # jean-mcp
│   └── src/
│       ├── stdio.ts              # Stdio MCP
│       ├── sse.ts                # SSE MCP
│       ├── permissions.ts        # Permission system
│       ├── filter.ts             # Tool filtering
│       └── registry.ts           # MCP tool registration
│
├── plugins/                      # jean-plugins
│   └── src/
│       ├── loader.ts             # .zip/URL loading
│       ├── path.ts               # PATH injection
│       ├── api.ts                # Extension API
│       ├── commands.ts           # Slash-command registry
│       └── hotkeys.ts            # Hotkey table
│
├── model/                        # jean-model
│   └── src/
│       ├── providers/            # 60+ provider implementations
│       ├── catalog.ts            # Model catalog
│       ├── streaming.ts          # Streaming + mid-token rules
│       ├── fallback.ts           # Fallback chain
│       ├── roles.ts              # 10 model roles
│       ├── compaction.ts         # Auto-compact
│       └── thinking.ts           # Adaptive thinking, effort
│
├── tui/                          # jean-tui
│   └── src/
│       ├── render/               # Differential rendering (Rust)
│       ├── cards/                # Tool call cards
│       ├── preview/              # Edit previews
│       ├── input/                # Vim-mode input
│       ├── hub/                  # Agent Hub TUI
│       ├── panes/                # Split panes
│       ├── accessibility/        # Screen reader mode
│       ├── react/                # React TUI components
│       ├── sixel/                # Terminal image rendering
│       └── theme/                # Theme system
│
├── desktop/                      # jean-desktop (Tauri)
│   └── src/
│       ├── tauri/                # Tauri backend
│       ├── mission-control/      # Mission Control view
│       ├── browser/              # In-app browser
│       ├── workspaces/           # Shadow workspaces
│       ├── agents-view/          # Multi-agent view
│       ├── notifications/        # Desktop notifications
│       ├── settings/             # Settings UI
│       └── updates/              # Auto-update
│
├── web/                          # jean-web
│   └── src/
│       ├── ide/                  # Web IDE
│       ├── projects/             # Project overview
│       ├── stats/                # Stats panel
│       ├── terminal/             # Integrated terminal
│       ├── notifications/        # Event log
│       ├── agents/               # Agent management
│       └── settings/             # Settings UI
│
├── gateway/                      # jean-gateway
│   └── src/
│       ├── core/                 # Gateway core
│       ├── telegram/             # Telegram bot
│       ├── discord/              # Discord bot
│       ├── slack/                # Slack bot
│       ├── whatsapp/             # WhatsApp bot
│       ├── signal/               # Signal bot
│       ├── matrix/               # Matrix bot
│       ├── email/                # Email integration
│       ├── sms/                  # SMS integration
│       ├── voice/                # Voice mode
│       └── platforms/            # Additional platforms
│
├── execution/                    # jean-execution
│   └── src/
│       ├── local.ts              # Local terminal
│       ├── docker.ts             # Docker sandbox
│       ├── ssh.ts                # SSH remote
│       ├── daytona.ts            # Daytona serverless
│       ├── modal.ts              # Modal cloud
│       ├── singularity.ts        # Singularity HPC
│       └── security.ts           # Security hardening
│
├── scheduler/                    # jean-scheduler
│   └── src/
│       ├── cron.ts               # Cron scheduling
│       ├── oneoff.ts             # One-off scheduling
│       ├── triggers.ts           # Trigger-based
│       ├── always-on.ts          # Always-on agents
│       └── push.ts               # Mobile push
│
├── collab/                       # jean-collab
│   └── src/
│       ├── relay.ts              # Session relay
│       ├── host.ts               # Host session
│       ├── guest.ts              # Guest client
│       └── security.ts           # Client-side sealing
│
├── cli/                          # jean-cli
│   └── src/
│       ├── commands/             # CLI commands
│       ├── flags/                # Flag parsing
│       ├── non-interactive/      # Non-interactive mode
│       ├── custom/               # Custom commands
│       ├── hooks/                # Pre/post hooks
│       └── config/               # CLI configuration
│
├── config/                       # jean-config
│   └── src/
│       ├── parser.ts             # Config parsing
│       ├── import/               # 8-format import
│       ├── settings.ts           # Settings management
│       └── env.ts                # Environment variables
│
├── acp/                          # jean-acp
│   └── src/
│       ├── protocol.ts           # JSON-RPC protocol
│       ├── editor/               # Editor integration
│       │   ├── vscode.ts         # VS Code
│       │   ├── jetbrains.ts      # JetBrains
│       │   └── zed.ts            # Zed
│       └── permissions.ts        # Permission gating
│
├── sdk/                          # jean-sdk
│   └── src/
│       ├── core.ts               # SDK core
│       ├── agents.ts             # Custom agent definition
│       ├── generator.ts          # Generator functions
│       └── types.ts              # TypeScript types
│
├── projects/                     # jean-projects
│   └── src/
│       ├── knowledge.ts          # Knowledge base
│       ├── rag.ts                # RAG (10x expansion)
│       ├── sharing.ts            # Project sharing
│       ├── connectors/           # Connectors
│       └── search.ts             # Enterprise search
│
└── evals/                        # jean-evals
    └── src/
        ├── bench/                # BuffBench-style evals
        ├── batch/                # Batch processing
        ├── export/               # Trajectory export
        ├── rl/                   # RL training
        └── harness/              # Benchmark runners
```

---

## 30. Build & Test Strategy

### 30.1 Build Commands

```bash
# Install dependencies
bun setup                    # Installs Bun workspaces + builds Rust crates

# Development mode
bun dev                      # Watch mode, hot reload

# Build production
bun build                    # Full production build

# Rebuild Rust natives only
bun run build:native         # After changing Rust crates

# Build for distribution
bun run dist                 # Create distributable packages
```

### 30.2 Test Strategy

| Test Type | Tool | Scope | LOC |
|---|---|---|---|
| **Unit tests** | Vitest (TS) + Cargo test (Rust) | Individual functions, modules | 15,000 |
| **Integration tests** | Vitest | Cross-module interactions | 8,000 |
| **E2E tests** | Playwright | Full agent workflows | 5,000 |
| **Agent evals** | BuffBench | 175+ real implementation tasks | 2,000 |

```bash
# Run all tests
bun test

# Run Rust tests
cargo test

# Run agent evals
bun run eval

# Run e2e tests
bun run e2e
```

### 30.3 CI/CD

| Stage | Tool | Description |
|---|---|---|
| **Lint** | ESLint + Biome + Clippy | Code quality checks |
| **Type check** | TypeScript | Type safety |
| **Test** | Vitest + Cargo test | Unit + integration tests |
| **E2E** | Playwright | End-to-end tests |
| **Build** | Turborepo + Cargo | Production build |
| **Publish** | npm + Cargo | Package publishing |

---

## 31. LOC Budget

### 31.1 Module Breakdown

| Module | Language | LOC | Percentage |
|---|---|---|---|
| **jean-core** (Rust) | Rust | 45,000 | 15.0% |
| **jean-agent** | TypeScript | 40,000 | 13.3% |
| **jean-tools** | TypeScript | 25,000 | 8.3% |
| **jean-tui** | Rust + TS | 25,000 | 8.3% |
| **jean-desktop** | Tauri + React | 20,000 | 6.7% |
| **jean-model** | TypeScript | 15,000 | 5.0% |
| **jean-teams** | TypeScript | 15,000 | 5.0% |
| **jean-gateway** | TypeScript | 15,000 | 5.0% |
| **jean-web** | React | 15,000 | 5.0% |
| **jean-memory** | TypeScript | 12,000 | 4.0% |
| **jean-subagents** | TypeScript | 12,000 | 4.0% |
| **jean-git** | TypeScript | 10,000 | 3.3% |
| **jean-skills** | TypeScript | 10,000 | 3.3% |
| **jean-execution** | TypeScript | 10,000 | 3.3% |
| **jean-cli** | TypeScript | 10,000 | 3.3% |
| **jean-projects** | TypeScript | 10,000 | 3.3% |
| **jean-evals** | TypeScript | 10,000 | 3.3% |
| **jean-advisor** | TypeScript | 5,000 | 1.7% |
| **jean-mcp** | TypeScript | 8,000 | 2.7% |
| **jean-plugins** | TypeScript | 8,000 | 2.7% |
| **jean-scheduler** | TypeScript | 8,000 | 2.7% |
| **jean-collab** | TypeScript | 8,000 | 2.7% |
| **jean-config** | TypeScript | 8,000 | 2.7% |
| **jean-sdk** | TypeScript | 8,000 | 2.7% |
| **jean-acp** | TypeScript | 5,000 | 1.7% |
| **Tests** | Mixed | 30,000 | 10.0% |
| **Docs** | Markdown | 15,000 | 5.0% |
| **TOTAL** | | **300,000** | **100%** |

### 31.2 Language Distribution

| Language | LOC | Percentage |
|---|---|---|
| **TypeScript** | 226,000 | 75.3% |
| **Rust** | 45,000 | 15.0% |
| **Tests** | 30,000 | 10.0% |
| **Markdown (docs)** | 15,000 | 5.0% |
| **React (JSX)** | Included in TypeScript | — |
| **TOTAL** | **300,000** | **100%** |

### 31.3 Rust vs. TypeScript Split

| Concern | Language | Why |
|---|---|---|
| File I/O | Rust | In-process, zero fork/exec, memory safety |
| Shell execution | Rust | Embedded bash, 58 coreutils, no shelling out |
| LSP client | Rust | Protocol parsing, performance |
| DAP client | Rust | Debugger protocol, real-time |
| Grep/Glob | Rust | ripgrep in-process, parallel walker |
| Hashline patches | Rust | Content-hash computation, patch application |
| Tree-sitter | Rust | 50+ language grammars, AST parsing |
| TUI rendering | Rust | Differential rendering, ratatui |
| Audio processing | Rust | Opus codecs, WebRTC streaming |
| Agent loop | TypeScript | Rapid iteration, async/await, generator functions |
| Orchestrator | TypeScript | Complex logic, easy to modify |
| Tools (browser, computer, search) | TypeScript | Puppeteer, Playwright, HTTP clients |
| Model layer | TypeScript | 60+ providers, streaming, HTTP |
| Memory/Skills | TypeScript | SQLite, file-based, easy to extend |
| Gateway | TypeScript | 20+ platform SDKs, WebSocket |
| TUI components | TypeScript | React components, complex UI |
| Desktop app | TypeScript | Tauri + React, web frontend |
| Web IDE | TypeScript | React + Monaco, full browser app |

---

## 32. Performance Targets

### 32.1 Latency Targets

| Operation | Target | Measurement |
|---|---|---|
| **First token** | < 500ms | Time from prompt to first streamed token |
| **File read** | < 1ms | In-process, no fork/exec |
| **File edit** | < 5ms | Hashline patch application |
| **Grep** | < 10ms | ripgrep in-process |
| **Glob** | < 50ms | Parallel walker with cache |
| **LSP diagnostic** | < 100ms | Language server response |
| **Bash command** | < 10ms | Embedded bash, no fork/exec |
| **Sub-agent spawn** | < 100ms | Worktree isolation + context setup |
| **Team spawn** | < 500ms | 4 teammates + task list + mailbox |
| **Auto-compact** | < 2s | Summarize + new session |

### 32.2 Throughput Targets

| Operation | Target |
|---|---|
| **Tokens per second** | 100+ (streaming) |
| **Concurrent sub-agents** | 16+ |
| **Concurrent teammates** | 8+ |
| **Gateway platforms** | 20+ (single process) |
| **Memory entries** | 100,000+ (FTS5 search < 10ms) |
| **Skills** | 1,000+ (load time < 100ms) |

### 32.3 Resource Targets

| Resource | Target |
|---|---|
| **Memory (focus mode)** | < 500MB |
| **Memory (autonomous mode)** | < 2GB |
| **Memory (swarm mode, 4 teammates)** | < 4GB |
| **Disk (installation)** | < 200MB |
| **Disk (memory + sessions)** | < 1GB (default) |
| **CPU (idle)** | < 1% |
| **CPU (active, focus)** | < 20% |
| **CPU (active, swarm)** | < 60% |

---

## 33. Comparison Matrix

### 33.1 Feature Coverage

| Feature | Jean Code | Claude Code | Oh My Pi | Codebuff | OpenFox | OpenCode | Codex | Cursor | Hermes |
|---|---|---|---|---|---|---|---|---|---|
| **Hashline edits** | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Multi-agent pipeline** | ✅ | ❌ | Partial | ✅ | ❌ | ❌ | ❌ | Partial | ❌ |
| **Agent Teams** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Contract-driven exec** | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Embedded bash + 58 utils** | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **LSP wired into writes** | ✅ | ❌ | ✅ | ❌ | ❌ | Partial | ❌ | ❌ | ❌ |
| **DAP debugger** | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Persistent memory** | ✅ | Partial | Partial | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Auto-compact** | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ |
| **Smart compaction** | ✅ | ❌ | Partial | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Multi-platform gateway** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Desktop control** | ✅ | Partial | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | Partial |
| **Browser tool** | ✅ | Partial | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | Partial |
| **Atomic commits** | ✅ | Partial | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Advisor layer** | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **16 internal URL schemes** | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Skill auto-creation** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **40+ built-in skills** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Plan approval** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Effort slider** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Fallback models** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Vim-mode TUI** | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| **Codebase indexing** | ✅ | Partial | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| **Custom commands** | ✅ | Partial | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| **Mission Control** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| **Cloud agents** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| **Tab autocomplete** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| **60+ providers** | ✅ | ❌ | ✅ | Partial | Partial | Partial | ❌ | Partial | Partial |
| **1000+ models** | ✅ | ❌ | ✅ | Partial | Partial | Partial | ❌ | Partial | Partial |
| **10 model roles** | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Mid-token rules** | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Collab mode** | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Scheduler** | ✅ | Partial | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **RL training** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **MCP stdio + SSE** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| **ACP protocol** | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Extension system** | ✅ | Partial | ✅ | ✅ | Partial | ❌ | ❌ | ❌ | Partial |
| **Import 8 config formats** | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **3 modes** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Best-of-N selection** | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Arbitrary nesting** | ✅ | Partial | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Runtime workers** | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Loopback bridge** | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **23-provider search** | ✅ | Partial | ✅ | Partial | ❌ | Partial | ❌ | ❌ | Partial |
| **Security hardening** | ✅ | Partial | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| **Zero telemetry** | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ |
| **Open source** | ✅ | ❌ | ✅ | Partial | ✅ | ✅ | Partial | ❌ | ✅ |

### 33.2 Summary

Jean Code is the **only** coding agent that combines:

1. **Hashline edits** (Oh My Pi) — 61% fewer tokens, lands on first attempt
2. **Multi-agent pipeline** (Codebuff) — specialized agents, best-of-N selection
3. **Agent Teams** (Claude Code) — direct inter-agent messaging, shared task list
4. **Contract-driven execution** (OpenFox) — immutable acceptance criteria
5. **Embedded bash + 58 coreutils** (Oh My Pi) — zero fork/exec
6. **LSP + DAP wired in** (Oh My Pi) — 14 LSP ops + 28 DAP ops
7. **Persistent memory** (Hermes) — retain/learn/recall, FTS5 search
8. **Multi-platform gateway** (Hermes) — 20+ platforms, single process
9. **Advisor layer** (Oh My Pi) — second model watches every turn
10. **16 internal URL schemes** (Oh My Pi) — one interface for everything
11. **Skill auto-creation** (Hermes) — writes SKILL.md from hard problems
12. **3 intelligent modes** (Jean Code original) — focus, autonomous, swarm
13. **60+ providers, 1000+ models** (Oh My Pi) — zero lock-in
14. **Open source, zero telemetry** (Jean Code principle) — fully auditable

No single existing agent has even half of these features. Jean Code has all of them.

---

## Appendix A: Glossary

| Term | Definition |
|---|---|
| **Hashline** | Content-hash anchored patch system. Uses SHA-256 hashes of surrounding lines as anchors instead of line numbers. Prevents whitespace battles and string-not-found loops. |
| **Snapcompact** | Bitmap-frame context compression. Preserves key information while reducing token count. Evaluated against SQuAD benchmarks. |
| **Brush** | Embedded bash shell. Fork of brush-shell, compiled into Jean Code. Sessions survive across calls. |
| **Loopback bridge** | Mechanism for Python/Bun kernels to call back into agent tools from within code. |
| **Agent Teams** | Multi-agent coordination system with shared task list, mailbox messaging, and file locking. |
| **Mailbox** | Direct inter-agent messaging via JSON files. Teammates message each other without routing through the lead. |
| **Advisor** | Second model that watches every turn the main agent takes, injecting notes, concerns, or blockers. |
| **MCP** | Model Context Protocol — standardized protocol for connecting external tools to AI agents. |
| **ACP** | Agent Client Protocol — JSON-RPC over stdio for editor integration. |
| **FTS5** | Full-Text Search version 5 — SQLite extension for fast text search. |
| **DAP** | Debug Adapter Protocol — standardized protocol for debugger integration. |
| **LSP** | Language Server Protocol — standardized protocol for code intelligence. |
| **Tree-sitter** | Incremental parsing library — used for code analysis across 50+ languages. |
| **Worktree** | Isolated git working tree — each sub-agent runs in its own worktree. |
| **Best-of-N** | Multiple editors run in parallel on the same task; a selector picks the best implementation. |
| **Orchestrator pattern** | Main agent has no tools except spawning other agents. Stays context-clean. |
| **Contract-driven execution** | Acceptance criteria serve as an immutable contract. Agent loops until all criteria pass. |
| **Auto-compact** | Automatic context summarization at 95% of context window limit. |
| **Smart compaction** | Non-lossy summarization after 5 minutes of idle (prompt cache expired). |
| **Mid-token rules** | System reminders injected mid-token if regex detects off-script behavior. |
| **Magic keywords** | Inline prompt modifiers: `ultrathink`, `orchestrate`, `workflowz`, `deep-review`, `plan-first`. |

---

## Appendix B: Internal URL Scheme Reference

| Scheme | Read | Write | Edit | Grep | Glob |
|---|---|---|---|---|---|
| `pr://` | ✅ | ❌ | ❌ | ✅ | ✅ |
| `issue://` | ✅ | ❌ | ❌ | ✅ | ❌ |
| `agent://` | ✅ | ❌ | ❌ | ✅ | ❌ |
| `skill://` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `ssh://` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `conflict://` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `file://` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `memory://` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `archive://` | ✅ | ✅ | ❌ | ❌ | ✅ |
| `sqlite://` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `commit://` | ✅ | ❌ | ❌ | ✅ | ❌ |
| `branch://` | ✅ | ❌ | ❌ | ✅ | ✅ |
| `tag://` | ✅ | ❌ | ❌ | ✅ | ✅ |
| `diff://` | ✅ | ❌ | ❌ | ✅ | ❌ |
| `stash://` | ✅ | ❌ | ❌ | ✅ | ❌ |
| `worktree://` | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## Appendix C: 40+ Built-in Skills

| Category | Skills |
|---|---|
| **MLOps** | `model-train`, `model-eval`, `model-deploy`, `model-monitor`, `dataset-curate`, `hyperparam-tune` |
| **GitHub** | `pr-create`, `pr-review`, `issue-triage`, `actions-debug`, `release-manage`, `code-search` |
| **Diagramming** | `arch-diagram`, `sequence-diagram`, `flowchart`, `er-diagram`, `class-diagram` |
| **Notes** | `note-create`, `note-search`, `note-organize`, `note-export` |
| **Documentation** | `api-docs`, `readme-gen`, `changelog`, `tutorial-write`, `doc-audit` |
| **Testing** | `test-gen`, `test-runner`, `coverage-report`, `e2e-setup`, `mock-create` |
| **Security** | `vuln-scan`, `dep-audit`, `secret-scan`, `sast`, `threat-model` |
| **DevOps** | `docker-build`, `k8s-deploy`, `ci-cd-setup`, `infra-as-code`, `monitor-setup` |
| **Database** | `schema-design`, `migration`, `query-optimize`, `seed-data`, `backup` |
| **API** | `rest-design`, `graphql-schema`, `grpc-define`, `openapi-gen`, `api-test` |
| **Frontend** | `component-gen`, `css-optim`, `accessibility-audit`, `perf-audit`, `responsive-design` |
| **Backend** | `api-route`, `middleware`, `auth-setup`, `cache-layer`, `queue-worker` |
| **Data** | `etl-pipeline`, `data-clean`, `analytics-query`, `dashboard-create`, `report-gen` |
| **Mobile** | `screen-gen`, `navigation-setup`, `state-manage`, `api-integrate`, `test-mobile` |
| **General** | `debug`, `refactor`, `migrate`, `optimize`, `cleanup` |

---

## Appendix D: Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `JEAN_HOME` | `~/.jean` | Base directory for Jean Code data |
| `JEAN_CONFIG` | `~/.jean/config.json` | Path to config file |
| `JEAN_MEMORY` | `~/.jean/memory.db` | Path to memory database |
| `JEAN_SESSIONS` | `~/.jean/sessions/` | Directory for session data |
| `JEAN_TEAMS` | `~/.jean/teams/` | Directory for team data |
| `JEAN_SKILLS` | `~/.jean/skills/` | Directory for skills |
| `JEAN_PLUGINS` | `~/.jean/plugins/` | Directory for plugins |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `GOOGLE_API_KEY` | — | Google API key |
| `LOCAL_ENDPOINT` | — | Self-hosted model endpoint |
| `JEAN_EXECUTION` | `local` | Default execution backend |
| `JEAN_PERMISSION_MODE` | `auto` | Default permission mode |
| `JEAN_DEBUG` | `false` | Enable debug logging |
| `SHELL` | `/bin/bash` | Default shell |
| `TMPDIR` | `/tmp` | Temporary directory |
| `NODE_PATH` | — | Node.js module path |
| `PATH` | System default | Executable search path |

---

## Appendix E: Keyboard Shortcuts Reference

### TUI Shortcuts

| Key | Action |
|---|---|
| `Enter` | Send message |
| `Esc` | Close overlay / return to previous mode |
| `Ctrl+C` | Interrupt current work |
| `Ctrl+E` | Open external editor |
| `Ctrl+K` | Open command dialog |
| `Ctrl+T` | View task list (swarm mode) |
| `Alt+A` | Open Agent Hub |
| `Alt+M` | Switch model |
| `Alt+P` | Toggle permission mode |
| `Alt+S` | View session list |
| `Alt+R` | Resume session |
| `Alt+L` | View logs |
| `Alt+G` | View git status |
| `Alt+F` | Toggle file tree |
| `Alt+T` | Toggle terminal |
| `Alt+D` | Toggle debug mode |
| `Alt+V` | Toggle vim mode |
| `Alt+H` | View help |
| `Alt+Q` | Quit Jean Code |

### Vim Mode

| Key | Action |
|---|---|
| `i` | Insert mode |
| `Esc` | Normal mode |
| `h/j/k/l` | Navigate left/down/up/right |
| `w/b` | Word navigation |
| `0/$` | Line start/end |
| `gg/G` | File start/end |
| `dd` | Delete line |
| `yy` | Yank line |
| `p/P` | Paste after/before |
| `u` | Undo |
| `Ctrl+R` | Redo |
| `:` | Command mode |
| `/` | Search forward |
| `?` | Search backward |
| `n/N` | Next/previous search result |
| `x` | Delete character |
| `o/O` | Insert line below/above |
| `a/A` | Append after/at end of line |
| `I` | Insert at start of line |

### Agent Hub (`Alt+A`)

| Key | Action |
|---|---|
| `↑/↓` | Select agent |
| `Enter` | View agent details |
| `x` | Stop selected agent |
| `k` | Kill selected agent |
| `r` | Restart selected agent |
| `s` | Steer selected agent (send message) |
| `Esc` | Close Agent Hub |

---

*Jean Code — A coding agent that grows smarter every day.*
*Terminal-first. Everywhere-accessible. Open by default.*
*300,000 lines of code. 9 agents studied. 200+ features extracted. One deadly monster.*