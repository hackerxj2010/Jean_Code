import type { ModelRole } from '@jean/config'

/**
 * Specialized agents (architecture §6.2).
 *
 * An agent definition is a name, a role, a tool surface, and a prompt. That is
 * the whole abstraction — the unit of composition is an agent, not an LLM call,
 * and defining a new one costs a few lines rather than a new code path.
 *
 * ## Why there are six and not nine
 *
 * A sub-agent is only worth its cost when it *saves* context. Spawning one
 * loads a fresh system prompt, re-reads whatever it needs, and returns a
 * summary the parent must then reconcile with what it already knew. That trade
 * pays when the sub-agent reads a great deal and reports a little — searching a
 * large tree, sweeping the web, driving a browser through ten pages.
 *
 * It does not pay for editing, reasoning, or running a command. An `editor`
 * sub-agent re-reads the file the parent had already read, makes the edit the
 * parent had already decided on, and reports back what the parent already knew
 * — two context loads to do one thing. Same for a `thinker` that reasons about
 * a problem the parent understands better, and a `basher` that runs a command
 * whose output the parent then has to be told about anyway.
 *
 * So `editor`, `thinker`, `basher`, `planner`, and the old `reviewer` are gone.
 * The main agent does that work itself. What remains is the set whose job is to
 * read widely and report narrowly.
 *
 * The tool surface matters as much as the prompt. A librarian that cannot write
 * files cannot "helpfully" fix what it was asked to review.
 */

export interface AgentDefinition {
  name: string
  /** One line, shown to the parent agent when it picks who to spawn. */
  purpose: string
  /** Model role this agent runs on. */
  role: ModelRole
  /** Tool names this agent may use. `*` means every tool the parent has. */
  tools: string[] | '*'
  /** Appended to the sub-agent system prompt. */
  instructions: string
  /** Turn cap. Sub-agents should be bounded much more tightly than the main loop. */
  maxTurns: number
  /** When true, the agent may spawn its own sub-agents. */
  canSpawn?: boolean
  /** An explicit model id, overriding the role's model (custom agents). */
  model?: string
  /** Where a custom agent was defined; absent for built-ins. */
  source?: string
}

const READ_ONLY = ['read', 'glob', 'grep']

/** Reading the tree, plus the structural tools that make it cheaper. */
const EXPLORE = [
  ...READ_ONLY,
  'ast_grep',
  'codemap_overview',
  'codemap_outline',
  'codemap_symbol',
  'codemap_find',
  'codemap_importers',
  'lsp_definition',
  'lsp_references',
  'lsp_symbols',
]

export const AGENTS: AgentDefinition[] = [
  {
    name: 'explorer',
    purpose: 'Search the codebase and report what is there, without loading it into the main context',
    role: 'smol',
    tools: EXPLORE,
    maxTurns: 18,
    instructions: `Investigate the codebase and report what you found.

Search first, read second. Use \`grep\`, \`glob\`, and \`ast_grep\` to narrow down, \`codemap_outline\` to see a file's shape without reading it whole, and only read a file when you need to confirm what it contains. You exist so the main agent does not have to load the whole tree — returning twenty files' contents defeats the purpose.

Report:
- The paths that matter, each with one line on why.
- How the pieces connect: what calls what, what imports what.
- The conventions you noticed, if the task will have to match them.

Cite \`path:line\` for anything specific. If the thing being asked about does not exist, say so and say where it would go — a confident wrong answer is worse than none, because the main agent will act on it.`,
  },

  {
    name: 'websearcher',
    purpose: 'Search the web and report what it says, with sources',
    role: 'smol',
    tools: ['web_search', 'web_fetch', 'web_providers', 'read', 'glob', 'grep'],
    maxTurns: 14,
    instructions: `Answer the question from the web and cite where each part came from.

Check the project's own dependencies and documentation first — the version actually installed here matters more than the latest release notes, and the answer is often already in \`node_modules\` or a lockfile.

When you do search: read more than one source before concluding, and say when they disagree rather than picking one silently. Quote the sentence that answers the question, with its URL.

Say what you could not verify. "The docs do not cover this" is a useful answer; a plausible invention is not, because the main agent cannot tell the difference.`,
  },

  {
    name: 'browser-use',
    purpose: 'Drive a real browser: navigate, inspect, and report what a page actually does',
    role: 'default',
    tools: ['browser_open', 'browser_act', 'browser_inspect', 'web_fetch', 'read'],
    maxTurns: 20,
    instructions: `Drive the browser to answer the question, and report what you observed.

Prefer \`browser_inspect\` over a screenshot: the DOM, the console, and the network log say precisely what happened, and a screenshot needs interpreting. Reach for a screenshot when the question is about layout or appearance.

Report what you did, in order, and what each step produced. Include the console errors and failed requests you saw even if they seem unrelated — they usually are not.

If the page did not behave as the task assumed, stop and say so with the evidence. Do not keep clicking to make it work.`,
  },

  {
    name: 'verifier',
    purpose: 'Check whether a change actually does what it was supposed to, and report pass or fail',
    role: 'default',
    tools: ['read', 'glob', 'grep', 'bash', 'bash_output', 'lsp_diagnostics', 'review'],
    maxTurns: 18,
    instructions: `Verify each criterion you were given against what is actually in the tree. Report pass or fail for each, with evidence.

For a criterion that requires code, read the changed files and check the implementation. Run the tests or the type checker when that is what would settle it. For a criterion that is conceptual and needs no code, judge it from the description and move on — exploring the codebase to verify "the change is documented" wastes a turn.

Rules that matter:
- **Run the check, do not reason about it.** "This should pass" is not verification. If a test exists, run it and quote the result.
- **Fail on evidence, not suspicion.** A criterion fails when you can name what is missing or what breaks. Say which.
- **Do not fix anything.** You are checking, not building. Report the gap and stop.
- **Quote the part of the output that decided it** — the failing assertion, the error line — not the whole log.

End with a list: each criterion, pass or fail, and one line of why.`,
  },

  {
    name: 'librarian',
    purpose: 'Review a change for what is actually wrong with it, and track findings across re-reviews',
    role: 'default',
    tools: ['read', 'glob', 'grep', 'bash', 'bash_output', 'review', 'lsp_diagnostics'],
    maxTurns: 18,
    instructions: `Review the change. Read the **diff** rather than the whole files — what changed is what can have broken.

Two questions, in this order:

1. **Does it work?** Logic that breaks on an edge case, error paths that swallow failures, resource leaks, race conditions, assumptions that do not hold, a rename that missed a call site.
2. **Does it belong here?** Does it follow the conventions already in this repository, is it maintainable, and does it add weight the project did not need?

You are not looking for perfection. You are looking for the things that will bite.

For each finding, give:
- \`path:line\`
- What breaks.
- The input or state that triggers it.

Mark a finding speculative if you cannot name the trigger. Do not pad the review with style opinions, and do not restate what the code does — **an empty review is a valid and useful result**, and inventing a finding to look thorough costs the main agent a wasted edit.

On a re-review, say which earlier findings are now fixed, which still stand, and which turned out not to matter. That list is the point of coming back.`,
  },

  {
    name: 'general',
    purpose: 'A capable general-purpose agent for a self-contained task that does not fit the others',
    role: 'default',
    tools: '*',
    maxTurns: 30,
    canSpawn: false,
    instructions: `Complete the task you were given and report what you did.

You have the same tools as the main agent. Stay inside the task — you are one part of a larger job, and work outside it lands in a tree the caller did not expect to change.

Report what you changed, what you could not do, and anything you found that the caller should know about.`,
  },
]

export function findAgent(name: string): AgentDefinition | undefined {
  return AGENTS.find((agent) => agent.name === name)
}

export function agentNames(): string[] {
  return AGENTS.map((agent) => agent.name)
}

/** The catalog as prompt text, for the parent's `spawn` tool description. */
export function describeAgents(): string {
  return AGENTS.map((agent) => `- \`${agent.name}\` — ${agent.purpose}`).join('\n')
}
