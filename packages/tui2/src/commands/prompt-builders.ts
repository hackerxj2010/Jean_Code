/**
 * Centralized prompt builders for /plan and /review commands.
 * This ensures consistent behavior regardless of entry path.
 */

// Base prompt for plan command - always gathers context first. The tools and
// agents named are Jean's own: `spawn` starts `explorer` for wide searches.
export const PLAN_BASE_PROMPT = 'Gather the relevant context first — read the code involved, and spawn `explorer` agents for searches that span the repository. Then write a step-by-step implementation plan: the files to change, what changes in each, the order, the risks, and how to verify the result. Do not change any code yet. Plan how to implement:'

// Base prompt for review command - the `review` tool shows the whole change and
// its mechanical problems; the `review` agent gives a second opinion.
export const REVIEW_BASE_PROMPT = 'Review the following. Run the `review` tool to see the whole diff and the mechanical problems in it, read the code around each change, and spawn the `review` agent for a second opinion on anything subtle. Report the problems by severity with file:line, then say whether it is ready. Review:'

/**
 * Build a plan prompt from user input.
 * @param input - The user's plan request (e.g., "add OAuth login")
 * @returns The full prompt to send to the agent
 */
export function buildPlanPrompt(input: string): string {
  const trimmedInput = input.trim()
  if (!trimmedInput) {
    return PLAN_BASE_PROMPT
  }
  return `${PLAN_BASE_PROMPT}\n\n${trimmedInput}`
}

// Base prompt for interview command - asks clarifying questions before acting
export const INTERVIEW_BASE_PROMPT = 'Interview me to better understand my request and then create a spec file. First, gather any relevant context (read files, do research, etc.). Then, use several rounds of the ask tool to ask non-obvious clarifying questions — things you cannot easily infer from the codebase or my initial message. Ask about edge cases, preferences, constraints, and design decisions. All questions should be directed through the ask tool -- not written out as text. Keep coming up with new questions that get at unique aspects of the request. Aim for at least **3 rounds** with multiple questions each round. When satisfied, write a [INSERT_REQUEST_SHORT_NAME]-spec.md file with all the information you have gathered about the request. Aim for as much detail as possible. You should NOT make any code changes yet. Stop after creating the spec file. End with a short list of ways the spec could be fleshed out. Here is my request:'

/**
 * Build an interview prompt from user input.
 * @param input - The user's request to be interviewed about
 * @returns The full prompt to send to the agent
 */
export function buildInterviewPrompt(input: string): string {
  const trimmedInput = input.trim()
  if (!trimmedInput) {
    return INTERVIEW_BASE_PROMPT
  }
  return `${INTERVIEW_BASE_PROMPT}\n\n${trimmedInput}`
}

/**
 * Review scope presets for the review screen.
 */
type ReviewScope = 'conversation' | 'uncommitted' | 'branch' | 'custom'

/**
 * Get the default text for a review scope preset.
 */
function getReviewScopeText(scope: ReviewScope): string {
  switch (scope) {
    case 'conversation':
      return 'all changes made in this conversation'
    case 'uncommitted':
      return 'uncommitted changes'
    case 'branch':
      return 'this branch compared to main'
    case 'custom':
      return ''
  }
}

/**
 * Build a review prompt from scope or custom input.
 * @param scope - The selected review scope (conversation, uncommitted, branch, or custom)
 * @param customInput - Optional custom review focus (when scope is 'custom')
 * @returns The full prompt to send to the agent
 */
export function buildReviewPrompt(scope: ReviewScope, customInput?: string): string {
  const scopeText = getReviewScopeText(scope)
  
  // For custom input, append the user's specific focus
  if (scope === 'custom' && customInput?.trim()) {
    return `${REVIEW_BASE_PROMPT} ${customInput.trim()}`
  }
  
  // For preset scopes, use the scope text
  if (scopeText) {
    return `${REVIEW_BASE_PROMPT} ${scopeText}`
  }
  
  // Fallback for custom with no input
  return REVIEW_BASE_PROMPT
}

/**
 * Build a review prompt from direct argument (e.g., /review foo).
 * This is used when the user provides review text directly after the command.
 * @param input - The user's review request
 * @returns The full prompt to send to the agent
 */
export function buildReviewPromptFromArgs(input: string): string {
  const trimmedInput = input.trim()
  // Use the same format as preset scopes for consistency
  return `${REVIEW_BASE_PROMPT} ${trimmedInput}`
}

