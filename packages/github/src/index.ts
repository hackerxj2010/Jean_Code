/**
 * `@jean/github` — GitHub integration (architecture §17.2).
 *
 * Spoken over the REST API rather than through the `gh` CLI: `gh` is absent on
 * most machines, its output format shifts between versions, and recovering
 * structured data from a CLI's prose breaks silently. A stored `gh` credential
 * is still used when one exists.
 */

export {
  detectRepo,
  GitHubClient,
  GitHubError,
  parseRemote,
  type ClientOptions,
  type Repo,
} from './client.ts'

export {
  commentOnIssue,
  createIssue,
  createPullRequest,
  getCheckRuns,
  getIssue,
  getJobLogs,
  getPullRequest,
  getPullRequestComments,
  getPullRequestDiff,
  getPullRequestFiles,
  getRunFailures,
  listIssues,
  listPullRequests,
  listWorkflowRuns,
  searchCode,
  type CheckRun,
  type Comment,
  type FileChange,
  type Issue,
  type PullRequest,
  type WorkflowRun,
} from './api.ts'

export { createGitHubTools } from './tools.ts'
export { createGitHubReadSource, parseGitHubPath } from './read-source.ts'
