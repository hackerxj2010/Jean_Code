import { ToolError, type ReadSource } from '@jean/tools'
import { getIssue, getPullRequest, getPullRequestComments, getPullRequestFiles, type Comment } from './api.ts'
import { detectRepo, type GitHubClient, type Repo } from './client.ts'

/**
 * `read pr://123` and `read issue://owner/repo/45` — a pull request or an
 * issue as one document: what it says, where it stands, what changed, and
 * the discussion, newest last.
 *
 * `pr://123` means this checkout's repository (its `origin` remote);
 * `pr://owner/repo/123` names another. `pull://` and `issues://` are
 * accepted too, and so is `pr://owner/repo#123`.
 */

interface Target {
  kind: 'pr' | 'issue'
  repo?: Repo
  number: number
}

export function parseGitHubPath(path: string): Target | undefined {
  const match = /^(pr|pull|issue|issues):\/\/(?:([^/#\s]+)\/([^/#\s]+)[/#])?(\d+)\/?$/i.exec(path.trim())
  if (!match) return undefined
  const kind = match[1]!.toLowerCase().startsWith('p') ? 'pr' : 'issue'
  const repo = match[2] && match[3] ? { owner: match[2], name: match[3] } : undefined
  return { kind, repo, number: Number(match[4]) }
}

/** The discussion, capped: the oldest comments give way to the newest. */
function renderComments(comments: Comment[], limit = 30): string {
  if (comments.length === 0) return 'No comments.'
  const shown = comments.slice(-limit)
  const skipped = comments.length - shown.length
  const lines = shown.map((comment) => {
    const where = comment.path ? ` on ${comment.path}${comment.line ? `:${comment.line}` : ''}` : ''
    return `**${comment.author}**${where} (${comment.createdAt.slice(0, 10)}):\n${comment.body.trim()}`
  })
  return `${skipped > 0 ? `… ${skipped} earlier comments not shown\n\n` : ''}${lines.join('\n\n')}`
}

export function createGitHubReadSource(client: GitHubClient): ReadSource {
  return {
    name: 'github',
    matches: (path) => parseGitHubPath(path) !== undefined,
    async read(path, _args, context) {
      const target = parseGitHubPath(path)!
      const repo = target.repo ?? (await detectRepo(context.cwd))
      if (!repo) {
        throw new ToolError(`${path} names no repository, and this directory has no GitHub remote.`, 'Use the full form: pr://owner/repo/123.')
      }
      const slug = `${repo.owner}/${repo.name}`
      try {
        if (target.kind === 'issue') {
          const issue = await getIssue(client, repo, target.number)
          // An issue's comments live where a pull request's conversation does.
          const comments = issue.comments > 0 ? await getPullRequestComments(client, repo, target.number).catch(() => []) : []
          return {
            output: [
              `# ${slug}#${issue.number}: ${issue.title}`,
              `Issue · ${issue.state} · by ${issue.author} · ${issue.createdAt.slice(0, 10)}${issue.labels.length > 0 ? ` · labels: ${issue.labels.join(', ')}` : ''}`,
              issue.url,
              '',
              issue.body.trim() || '(no description)',
              '',
              '## Discussion',
              '',
              renderComments(comments),
            ].join('\n'),
            display: { kind: 'issue', repo: slug, number: issue.number },
          }
        }

        const [pr, files, comments] = await Promise.all([
          getPullRequest(client, repo, target.number),
          getPullRequestFiles(client, repo, target.number).catch(() => []),
          getPullRequestComments(client, repo, target.number).catch(() => []),
        ])
        const changed = files
          .slice(0, 100)
          .map((file) => `  ${file.status.padEnd(9)} +${String(file.additions).padEnd(5)} -${String(file.deletions).padEnd(5)} ${file.path}`)
        if (files.length > 100) changed.push(`  … ${files.length - 100} more`)
        return {
          output: [
            `# ${slug}#${pr.number}: ${pr.title}`,
            `Pull request · ${pr.draft ? 'draft · ' : ''}${pr.state} · ${pr.branch} → ${pr.baseBranch} · by ${pr.author} · ${pr.createdAt.slice(0, 10)}`,
            pr.url,
            '',
            pr.body.trim() || '(no description)',
            '',
            `## Files (${files.length}${pr.additions !== undefined ? `, +${pr.additions} −${pr.deletions}` : ''})`,
            '',
            changed.length > 0 ? changed.join('\n') : '  (none listed)',
            '',
            '## Discussion',
            '',
            renderComments(comments),
            '',
            `The diff itself: \`gh_pr\` with action \`diff\` and number ${pr.number}.`,
          ].join('\n'),
          display: { kind: 'pull-request', repo: slug, number: pr.number },
        }
      } catch (error) {
        throw new ToolError(
          `Could not read ${slug}#${target.number}: ${error instanceof Error ? error.message : String(error)}`,
          'A private repository needs GITHUB_TOKEN, or `gh auth login`.',
        )
      }
    },
  }
}
