/**
 * The channel between the agent's `ask` tool and the questionnaire on screen.
 *
 * The problem it solves: the tool is called deep inside the agent loop and has
 * to *block* until a person answers, while the answer arrives through React
 * state in a component that knows nothing about the loop. Neither side can
 * import the other without a cycle.
 *
 * So this sits between them. The tool calls `request()` and awaits; the hook
 * subscribes, renders the questions, and calls `submit()`. One pending request
 * at a time, because two questionnaires on one screen have no sensible layout
 * and no way for the user to tell which answer went where.
 */

export interface AskQuestion {
  question: string
  options?: (string | { label: string; description?: string })[]
  multiSelect?: boolean
}

export interface AskRequest {
  toolCallId: string
  questions: AskQuestion[]
}

export interface AskAnswer {
  questionIndex: number
  selectedOption?: string
  selectedOptions?: string[]
  otherText?: string
}

export interface AskResponse {
  answers?: AskAnswer[]
  skipped?: boolean
}

type Listener = (request: AskRequest | null) => void

const listeners = new Set<Listener>()

/** The request currently on screen, and who is waiting on it. */
let pending: { request: AskRequest; resolve: (response: AskResponse) => void } | null = null

export const AskUserBridge = {
  /**
   * Renders a question and waits for the answer.
   *
   * Called from the tool. Resolves when the user submits or skips.
   */
  request(toolCallId: string, questions: AskQuestion[]): Promise<AskResponse> {
    // A second question while one is open would replace it on screen and leave
    // the first caller waiting forever. Refusing is the honest outcome, and the
    // agent can ask again once the first is answered.
    if (pending) {
      return Promise.resolve({ skipped: true })
    }

    if (questions.length === 0) {
      return Promise.resolve({ skipped: true })
    }

    return new Promise<AskResponse>((resolve) => {
      const request: AskRequest = { toolCallId, questions }
      pending = { request, resolve }

      for (const listener of listeners) listener(request)
    })
  },

  /** Answers the open request. Called from the UI. */
  submit(response: AskResponse): void {
    const current = pending
    // Cleared first: a listener that re-renders synchronously must not see a
    // request that has already been answered.
    pending = null

    for (const listener of listeners) listener(null)

    current?.resolve(response)
  },

  /**
   * Watches for questions. Returns an unsubscribe.
   *
   * A subscriber that arrives while a request is open is told about it
   * immediately — otherwise a remount mid-question loses the questionnaire and
   * the agent hangs on a promise nothing can resolve.
   */
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    if (pending) listener(pending.request)

    return () => {
      listeners.delete(listener)
    }
  },

  /** Whether a question is waiting, for the status line. */
  isPending(): boolean {
    return pending !== null
  },

  /**
   * Abandons the open request.
   *
   * For an interrupted turn: the tool's promise has to settle or the loop never
   * unwinds and the session cannot be ended.
   */
  cancel(): void {
    const current = pending
    pending = null
    for (const listener of listeners) listener(null)
    current?.resolve({ skipped: true })
  },
}
