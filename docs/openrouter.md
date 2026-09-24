# Using OpenRouter

OpenRouter is the recommended way to run Jean Code: one key reaches ~400 models across every major provider, so you can switch models without switching accounts.

## Setup

Create a `.env` file in your project root:

```
OPENROUTER_API_KEY=sk-or-v1-...
```

That is the whole setup. OpenRouter is already the default provider, so `jean` works immediately:

```bash
jean doctor          # confirms the key is found and which model is active
jean -p "hello"
```

The `.env` file is read automatically and never exported to shell history. Add it to `.gitignore` so it stays local:

```bash
echo .env >> .gitignore
```

For a global key (shared across all projects), put it in `~/.env` instead, or export it in your shell profile.

## Choosing a model

```bash
jean --model minimax/minimax-m3:free -p "explain this codebase"
```

Or set it durably:

```bash
jean config set model.modelId anthropic/claude-sonnet-4.5
```

Any model id OpenRouter serves works, whether or not it is in the bundled catalog. Ids not in the catalog just get conservative context-window defaults for auto-compaction.

## The one hard requirement: tool calling

**Jean Code's agent loop is built on tool calls.** A model that cannot call tools can answer questions but cannot read files, edit code, or run commands — the agent will talk about the work instead of doing it.

Before committing to a model, check it supports tools:

```bash
curl -s https://openrouter.ai/api/v1/models \
  | jq -r '.data[] | select(.supported_parameters | index("tools")) | .id' \
  | head -40
```

## Free models

A free-tier key (no credits) can only use `:free` models. As of this writing 18 of them support tool calling. Three that were verified working with Jean Code:

| Model | Context | Notes |
|---|---|---|
| `minimax/minimax-m3:free` | 1M | Best of the free tier in testing — clean tool calls, follows instructions |
| `poolside/laguna-s-2.1:free` | 262k | Solid, good fallback |
| `cohere/north-mini-code:free` | 256k | Code-focused; useful for the `smol` role |

Free models are rate-limited and sometimes return `429 Provider returned error` when busy. That is what the fallback chain is for:

```json
{
  "model": { "provider": "openrouter", "modelId": "minimax/minimax-m3:free" },
  "agents": {
    "default": {
      "fallbacks": ["poolside/laguna-s-2.1:free", "z-ai/glm-5.2:free"]
    }
  }
}
```

Jean Code tries each in order on a transport failure and reports which one served the request. It does **not** fall through on an auth error, since the next model would share the same key and silently burning the chain would hide the real problem.

Expect free models to be weaker at long multi-step tasks. They will read files and make edits correctly, but are more likely to stop early or produce truncated sub-agent reports. If a run stalls, raise `--max-turns` or move to a paid model.

## Routing roles to different models

The point of roles is that you pay for capability only where it matters:

```json
{
  "model": { "provider": "openrouter", "modelId": "anthropic/claude-sonnet-4.5" },
  "agents": {
    "default":  { "model": "anthropic/claude-sonnet-4.5" },
    "smol":     { "model": "openai/gpt-4o-mini" },
    "advisor":  { "model": "anthropic/claude-opus-4.1" },
    "commit":   { "model": "openai/gpt-4o-mini" }
  }
}
```

`smol` handles compaction summaries and cheap sub-agents; `advisor` is the second opinion that watches the main agent in autonomous mode.

## Mixing OpenRouter with direct providers

Prefix a model id with a provider name to route it directly, bypassing OpenRouter for that role:

```json
{
  "agents": {
    "default": { "model": "openrouter:anthropic/claude-sonnet-4.5" },
    "slow":    { "model": "anthropic:claude-opus-4-1" }
  }
}
```

`anthropic/claude-sonnet-4.5` is a model id; `anthropic:claude-opus-4-1` is a provider prefix plus an id. The colon is what distinguishes them.

## Checking your key

```bash
curl -s -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  https://openrouter.ai/api/v1/key | jq
```

`is_free_tier: true` with zero credits means `:free` models only.

## Privacy

Jean Code sends nothing anywhere except the model requests you configure. It attaches OpenRouter's two attribution headers (`HTTP-Referer` and `X-Title`) so requests are identified as coming from Jean Code on the public leaderboard; these carry nothing about you or your code. Everything else — sessions, memory, config — stays on your machine.
