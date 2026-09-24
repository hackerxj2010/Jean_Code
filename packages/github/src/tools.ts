import { ToolError, type Tool, type ToolResult } from '@jean/tools'
import {
  commentOnIssue,
  createIssue,
  createPullRequest,
  getCheckRuns,
  getIssue,
  getPullRequest,
  getPullRequestComments,
  getPullRequestDiff,
  getPullRequestFiles,
  getRunFailures,
  listIssues,
  listPullRequests,
  listWorkflowRuns,
  searchCode,
} from './api.ts'
import { detectRepo, GitHubClient, type Repo } from './client.ts'

/**
 * GitHub tools (architecture §17.2).
 *
 * Shaped around what an agent is actually asked to do — "why is CI failing",
 * "address the review comments", "open a PR for this" — rather than mirroring
 * the API surface. `gh_checks` returns only failures, because a green run
 * contains nothing to act on and a matrix build's successes are pure noise.
 *
 * Everything that writes is gated: opening a pull request or commenting is
 * visible to other people and cannot be undone by an `edit`.
 */

export function createGitHubTools(client: GitHubClient = new GitHubClient()): Tool[] {
  /** Resolves the repository, or explains why it could not. */
  async function repoOf(cwd: string, override?: string): Promise<Repo> {
    if (override) {
      const [owner, name] = override.split('/')
      if (!owner || !name) {
        throw new ToolError(`"${override}" is not owner/name.`)
      }
      return { owner, name }
    }

    const detected = await detectRepo(cwd)
    if (!detected) {
      throw new ToolError(
        'This directory has no GitHub remote.',
        'Pass `repo` as "owner/name", or run from a clone with an origin remote.',
      )
    }
    return detected
  }

  const prTool: Tool<{
    action: 'list' | 'view' | 'diff' | 'comments' | 'files'
    number?: number
    repo?: string
    state?: 'open' | 'closed' | 'all'
  }> = {
    name: 'gh_pr',
    risk: 'read',
    description: [
      'Read pull requests: list them, view one, read its diff, its changed files, or its comments.',
      '',
      'Use `comments` before acting on review feedback — it merges the conversation',
      'thread with line-anchored review comments, which GitHub stores separately.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'view', 'diff', 'comments', 'files'] },
        number: { type: 'integer', description: 'PR number, for anything but `list`.' },
        repo: { type: 'string', description: 'owner/name. Defaults to this repository.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
      },
      required: ['action'],
    },
    summarize: (args) => `gh pr ${args.action}${args.number ? ` #${args.number}` : ''}`,

    async execute(args, context): Promise<ToolResult> {
      const repo = await repoOf(context.cwd, args.repo)

      if (args.action === 'list') {
        const prs = await listPullRequests(client, repo, { state: args.state })
        if (prs.length === 0) return { output: `No ${args.state ?? 'open'} pull requests.` }

        const lines = prs.map(
          (pr) =>
            `  #${String(pr.number).padEnd(5)} ${pr.draft ? '[draft] ' : ''}${pr.title}\n      ${pr.author} · ${pr.branch} → ${pr.baseBranch}`,
        )
        return { output: `${prs.length} pull requests:\n\n${lines.join('\n')}` }
      }

      if (!args.number) throw new ToolError(`\`${args.action}\` needs a PR \`number\`.`)

      switch (args.action) {
        case 'view': {
          const pr = await getPullRequest(client, repo, args.number)
          return {
            output: [
              `#${pr.number} ${pr.title}`,
              `${pr.state}${pr.draft ? ' (draft)' : ''} · ${pr.author} · ${pr.branch} → ${pr.baseBranch}`,
              pr.changedFiles !== undefined
                ? `${pr.changedFiles} files, +${pr.additions} −${pr.deletions}`
                : '',
              pr.mergeable === false ? 'Has conflicts with the base branch.' : '',
              '',
              pr.body || '(no description)',
              '',
              pr.url,
            ]
              .filter(Boolean)
              .join('\n'),
          }
        }

        case 'diff': {
          const diff = await getPullRequestDiff(client, repo, args.number)
          const truncated =
            diff.length > 60_000
              ? `${diff.slice(0, 60_000)}\n\n[diff truncated — use \`files\` to see it per file]`
              : diff
          return { output: truncated, display: { kind: 'git-diff', diff } }
        }

        case 'files': {
          const files = await getPullRequestFiles(client, repo, args.number)
          const lines = files.map(
            (file) => `  ${file.status.padEnd(9)} +${file.additions} −${file.deletions}  ${file.path}`,
          )
          return { output: `${files.length} changed files:\n\n${lines.join('\n')}` }
        }

        case 'comments': {
          const comments = await getPullRequestComments(client, repo, args.number)
          if (comments.length === 0) return { output: 'No comments.' }

          const lines = comments.map((comment) => {
            const where = comment.path ? ` on ${comment.path}:${comment.line ?? '?'}` : ''
            return `  ${comment.author}${where}\n${comment.body
              .split('\n')
              .map((l) => `      ${l}`)
              .join('\n')}`
          })
          return { output: `${comments.length} comments:\n\n${lines.join('\n\n')}` }
        }

        default:
          throw new ToolError(`Unknown action "${args.action}".`)
      }
    },
  }

  const issueTool: Tool<{
    action: 'list' | 'view'
    number?: number
    repo?: string
    state?: 'open' | 'closed' | 'all'
    labels?: string[]
  }> = {
    name: 'gh_issue',
    risk: 'read',
    description: 'List or read GitHub issues.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'view'] },
        number: { type: 'integer', description: 'Issue number, for `view`.' },
        repo: { type: 'string', description: 'owner/name. Defaults to this repository.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        labels: { type: 'array', items: { type: 'string' }, description: 'Filter by label.' },
      },
      required: ['action'],
    },
    summarize: (args) => `gh issue ${args.action}${args.number ? ` #${args.number}` : ''}`,

    async execute(args, context): Promise<ToolResult> {
      const repo = await repoOf(context.cwd, args.repo)

      if (args.action === 'view') {
        if (!args.number) throw new ToolError('`view` needs an issue `number`.')
        const issue = await getIssue(client, repo, args.number)
        return {
          output: [
            `#${issue.number} ${issue.title}`,
            `${issue.state} · ${issue.author}${issue.labels.length ? ` · ${issue.labels.join(', ')}` : ''}`,
            '',
            issue.body || '(no description)',
            '',
            issue.url,
          ].join('\n'),
        }
      }

      const issues = await listIssues(client, repo, { state: args.state, labels: args.labels })
      if (issues.length === 0) return { output: `No ${args.state ?? 'open'} issues.` }

      const lines = issues.map(
        (issue) =>
          `  #${String(issue.number).padEnd(5)} ${issue.title}\n      ${issue.author}${issue.labels.length ? ` · ${issue.labels.join(', ')}` : ''}`,
      )
      return { output: `${issues.length} issues:\n\n${lines.join('\n')}` }
    },
  }

  const checksTool: Tool<{ ref?: string; repo?: string; runId?: number }> = {
    name: 'gh_checks',
    risk: 'read',
    description: [
      'See why CI is failing.',
      '',
      'Returns the failing jobs and steps for a branch or run — not the passing',
      'ones, which contain nothing to act on. Use this before guessing at a CI',
      'failure from the code.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Branch or commit. Defaults to the current branch.' },
        runId: { type: 'integer', description: 'A specific workflow run.' },
        repo: { type: 'string', description: 'owner/name. Defaults to this repository.' },
      },
    },
    summarize: (args) => `gh checks${args.ref ? ` ${args.ref}` : ''}`,

    async execute(args, context): Promise<ToolResult> {
      const repo = await repoOf(context.cwd, args.repo)

      if (args.runId) {
        const failures = await getRunFailures(client, repo, args.runId)
        if (failures.length === 0) return { output: `Run ${args.runId} has no failing jobs.` }

        const lines = failures.map(
          (failure) =>
            `  ${failure.job}\n      failing steps: ${failure.steps.join(', ') || 'unknown'}\n      ${failure.url}`,
        )
        return { output: `${failures.length} failing jobs:\n\n${lines.join('\n')}` }
      }

      const branch = args.ref ?? (await currentBranch(context.cwd))
      const runs = await listWorkflowRuns(client, repo, { branch, limit: 5 })

      if (runs.length === 0) {
        return { output: `No workflow runs for ${branch ?? 'this branch'}.` }
      }

      const sections: string[] = []
      for (const run of runs.slice(0, 3)) {
        const state = run.conclusion ?? run.status
        sections.push(`  ${run.name} — ${state}  ${run.url}`)

        if (run.conclusion === 'failure') {
          for (const failure of await getRunFailures(client, repo, run.id)) {
            sections.push(`      ${failure.job}: ${failure.steps.join(', ') || 'see logs'}`)
          }
        }
      }

      const checks = branch ? await getCheckRuns(client, repo, branch).catch(() => []) : []
      const failedChecks = checks.filter((c) => c.conclusion === 'failure')
      if (failedChecks.length > 0) {
        sections.push('', 'Failing checks:')
        for (const check of failedChecks) sections.push(`  ${check.name}  ${check.url}`)
      }

      return { output: sections.join('\n') }
    },
  }

  const searchTool: Tool<{ query: string; repo?: string; global?: boolean }> = {
    name: 'gh_search',
    risk: 'read',
    description: [
      'Search code on GitHub.',
      '',
      'Scoped to this repository by default. Set `global: true` to search all of',
      'GitHub — useful for finding how a library is actually used in the wild,',
      'which its documentation often does not show.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'GitHub code search query.' },
        repo: { type: 'string', description: 'owner/name to search.' },
        global: { type: 'boolean', description: 'Search all of GitHub.' },
      },
      required: ['query'],
    },
    summarize: (args) => `gh search ${args.query.slice(0, 50)}`,

    async execute(args, context): Promise<ToolResult> {
      const repo = args.global ? undefined : await repoOf(context.cwd, args.repo)
      const results = await searchCode(client, args.query, repo)

      if (results.length === 0) return { output: `No code matches "${args.query}".` }

      const lines = results.map((result) => `  ${result.repo}  ${result.path}\n      ${result.url}`)
      return { output: `${results.length} matches:\n\n${lines.join('\n')}` }
    },
  }

  const writeTool: Tool<{
    action: 'comment' | 'create_pr' | 'create_issue'
    number?: number
    title?: string
    body?: string
    head?: string
    base?: string
    draft?: boolean
    repo?: string
  }> = {
    name: 'gh_write',
    risk: 'write',
    description: [
      'Comment on an issue or pull request, or open a new one.',
      '',
      'These are visible to other people and cannot be undone by editing a file,',
      'so they are confirmed before running.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['comment', 'create_pr', 'create_issue'] },
        number: { type: 'integer', description: 'Issue or PR number, for `comment`.' },
        title: { type: 'string', description: 'Title, when creating.' },
        body: { type: 'string', description: 'Comment or description text.' },
        head: { type: 'string', description: 'Source branch, for `create_pr`.' },
        base: { type: 'string', description: 'Target branch, for `create_pr`.' },
        draft: { type: 'boolean', description: 'Open the PR as a draft.' },
        repo: { type: 'string', description: 'owner/name. Defaults to this repository.' },
      },
      required: ['action'],
    },
    summarize: (args) => `gh ${args.action}${args.number ? ` #${args.number}` : ''}`,

    async execute(args, context): Promise<ToolResult> {
      const repo = await repoOf(context.cwd, args.repo)

      // Confirmed here rather than left to the registry's risk gate: the gate
      // asks about writing *files*, and this writes to a public conversation.
      if (context.confirm) {
        const approved = await context.confirm({
          tool: 'gh_write',
          risk: 'write',
          summary: `${args.action.replace('_', ' ')} on ${repo.owner}/${repo.name}${args.number ? ` #${args.number}` : ''}`,
          detail: args.title ? `${args.title}\n\n${args.body ?? ''}` : args.body,
        })
        if (!approved) throw new ToolError('The user declined. Do not retry.')
      } else {
        throw new ToolError(
          'Writing to GitHub needs confirmation and this session is non-interactive.',
          'Re-run interactively, or make the change yourself.',
        )
      }

      switch (args.action) {
        case 'comment': {
          if (!args.number || !args.body) {
            throw new ToolError('`comment` needs `number` and `body`.')
          }
          await commentOnIssue(client, repo, args.number, args.body)
          return { output: `Commented on #${args.number}.` }
        }

        case 'create_pr': {
          if (!args.title || !args.head || !args.base) {
            throw new ToolError('`create_pr` needs `title`, `head`, and `base`.')
          }
          const pr = await createPullRequest(client, repo, {
            title: args.title,
            body: args.body ?? '',
            head: args.head,
            base: args.base,
            draft: args.draft,
          })
          return { output: `Opened #${pr.number}: ${pr.url}` }
        }

        case 'create_issue': {
          if (!args.title) throw new ToolError('`create_issue` needs a `title`.')
          const issue = await createIssue(client, repo, {
            title: args.title,
            body: args.body ?? '',
          })
          return { output: `Opened #${issue.number}: ${issue.url}` }
        }

        default:
          throw new ToolError(`Unknown action "${args.action}".`)
      }
    },
  }

  return [prTool as Tool, issueTool as Tool, checksTool as Tool, searchTool as Tool, writeTool as Tool]
}

async function currentBranch(cwd: string): Promise<string | undefined> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeout: 5000,
    })
    return stdout.trim()
  } catch {
    return undefined
  }
}
