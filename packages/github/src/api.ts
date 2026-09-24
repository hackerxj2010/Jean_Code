import type { GitHubClient, Repo } from './client.ts'

/**
 * Typed GitHub operations (architecture §17.2).
 *
 * Each returns the fields an agent actually reasons about, not the API's full
 * payload. A pull request response is ~120 fields; passing all of them to a
 * model spends thousands of tokens on `node_id` and a dozen URL variants.
 */

export interface PullRequest {
  number: number
  title: string
  state: string
  draft: boolean
  author: string
  branch: string
  baseBranch: string
  body: string
  url: string
  createdAt: string
  updatedAt: string
  mergeable?: boolean | null
  additions?: number
  deletions?: number
  changedFiles?: number
}

export interface Issue {
  number: number
  title: string
  state: string
  author: string
  body: string
  labels: string[]
  url: string
  createdAt: string
  comments: number
}

export interface Comment {
  author: string
  body: string
  createdAt: string
  /** Set for review comments anchored to a line. */
  path?: string
  line?: number
}

export interface WorkflowRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  branch: string
  event: string
  url: string
  createdAt: string
}

export interface CheckRun {
  name: string
  status: string
  conclusion: string | null
  url: string
}

export interface FileChange {
  path: string
  status: string
  additions: number
  deletions: number
  /** The patch, when the file is not binary and the diff is not enormous. */
  patch?: string
}

function repoPath(repo: Repo): string {
  return `/repos/${repo.owner}/${repo.name}`
}

function toPullRequest(raw: Record<string, unknown>): PullRequest {
  const pr = raw as {
    number: number
    title: string
    state: string
    draft?: boolean
    user?: { login?: string }
    head?: { ref?: string }
    base?: { ref?: string }
    body?: string
    html_url: string
    created_at: string
    updated_at: string
    mergeable?: boolean | null
    additions?: number
    deletions?: number
    changed_files?: number
  }

  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft ?? false,
    author: pr.user?.login ?? 'unknown',
    branch: pr.head?.ref ?? '',
    baseBranch: pr.base?.ref ?? '',
    body: pr.body ?? '',
    url: pr.html_url,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    mergeable: pr.mergeable,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
  }
}

export async function listPullRequests(
  client: GitHubClient,
  repo: Repo,
  options: { state?: 'open' | 'closed' | 'all'; limit?: number } = {},
): Promise<PullRequest[]> {
  const raw = await client.paginate<Record<string, unknown>>(
    `${repoPath(repo)}/pulls?state=${options.state ?? 'open'}&sort=updated&direction=desc`,
    options.limit ?? 20,
  )
  return raw.map(toPullRequest)
}

export async function getPullRequest(
  client: GitHubClient,
  repo: Repo,
  number: number,
): Promise<PullRequest> {
  return toPullRequest(
    await client.request<Record<string, unknown>>(`${repoPath(repo)}/pulls/${number}`),
  )
}

/** A pull request's unified diff. */
export async function getPullRequestDiff(
  client: GitHubClient,
  repo: Repo,
  number: number,
): Promise<string> {
  return client.request<string>(`${repoPath(repo)}/pulls/${number}`, {
    accept: 'application/vnd.github.diff',
  })
}

export async function getPullRequestFiles(
  client: GitHubClient,
  repo: Repo,
  number: number,
): Promise<FileChange[]> {
  const raw = await client.paginate<{
    filename: string
    status: string
    additions: number
    deletions: number
    patch?: string
  }>(`${repoPath(repo)}/pulls/${number}/files`, 300)

  return raw.map((file) => ({
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
  }))
}

/**
 * Every comment on a pull request.
 *
 * Two endpoints, because GitHub stores conversation comments and line-anchored
 * review comments separately — reading only one loses half the discussion,
 * which is exactly the half an agent needs to act on review feedback.
 */
export async function getPullRequestComments(
  client: GitHubClient,
  repo: Repo,
  number: number,
): Promise<Comment[]> {
  const [conversation, review] = await Promise.all([
    client.paginate<{ user?: { login?: string }; body: string; created_at: string }>(
      `${repoPath(repo)}/issues/${number}/comments`,
      100,
    ),
    client.paginate<{
      user?: { login?: string }
      body: string
      created_at: string
      path?: string
      line?: number
    }>(`${repoPath(repo)}/pulls/${number}/comments`, 100),
  ])

  const comments: Comment[] = [
    ...conversation.map((c) => ({
      author: c.user?.login ?? 'unknown',
      body: c.body,
      createdAt: c.created_at,
    })),
    ...review.map((c) => ({
      author: c.user?.login ?? 'unknown',
      body: c.body,
      createdAt: c.created_at,
      path: c.path,
      line: c.line,
    })),
  ]

  return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function createPullRequest(
  client: GitHubClient,
  repo: Repo,
  options: { title: string; body: string; head: string; base: string; draft?: boolean },
): Promise<PullRequest> {
  return toPullRequest(
    await client.request<Record<string, unknown>>(`${repoPath(repo)}/pulls`, {
      method: 'POST',
      body: options,
    }),
  )
}

export async function commentOnIssue(
  client: GitHubClient,
  repo: Repo,
  number: number,
  body: string,
): Promise<void> {
  await client.request(`${repoPath(repo)}/issues/${number}/comments`, {
    method: 'POST',
    body: { body },
  })
}

export async function listIssues(
  client: GitHubClient,
  repo: Repo,
  options: { state?: 'open' | 'closed' | 'all'; labels?: string[]; limit?: number } = {},
): Promise<Issue[]> {
  const params = new URLSearchParams({
    state: options.state ?? 'open',
    sort: 'updated',
    direction: 'desc',
  })
  if (options.labels?.length) params.set('labels', options.labels.join(','))

  const raw = await client.paginate<{
    number: number
    title: string
    state: string
    user?: { login?: string }
    body?: string
    labels?: { name: string }[]
    html_url: string
    created_at: string
    comments: number
    pull_request?: unknown
  }>(`${repoPath(repo)}/issues?${params}`, options.limit ?? 20)

  // The issues endpoint returns pull requests too; an agent asking for issues
  // does not mean pull requests.
  return raw
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      author: issue.user?.login ?? 'unknown',
      body: issue.body ?? '',
      labels: (issue.labels ?? []).map((l) => l.name),
      url: issue.html_url,
      createdAt: issue.created_at,
      comments: issue.comments,
    }))
}

export async function getIssue(client: GitHubClient, repo: Repo, number: number): Promise<Issue> {
  const raw = await client.request<{
    number: number
    title: string
    state: string
    user?: { login?: string }
    body?: string
    labels?: { name: string }[]
    html_url: string
    created_at: string
    comments: number
  }>(`${repoPath(repo)}/issues/${number}`)

  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    author: raw.user?.login ?? 'unknown',
    body: raw.body ?? '',
    labels: (raw.labels ?? []).map((l) => l.name),
    url: raw.html_url,
    createdAt: raw.created_at,
    comments: raw.comments,
  }
}

export async function createIssue(
  client: GitHubClient,
  repo: Repo,
  options: { title: string; body: string; labels?: string[] },
): Promise<Issue> {
  const raw = await client.request<{ number: number; html_url: string }>(
    `${repoPath(repo)}/issues`,
    { method: 'POST', body: options },
  )
  return getIssue(client, repo, raw.number)
}

export async function listWorkflowRuns(
  client: GitHubClient,
  repo: Repo,
  options: { branch?: string; status?: string; limit?: number } = {},
): Promise<WorkflowRun[]> {
  const params = new URLSearchParams()
  if (options.branch) params.set('branch', options.branch)
  if (options.status) params.set('status', options.status)

  const raw = await client.request<{
    workflow_runs?: {
      id: number
      name: string
      status: string
      conclusion: string | null
      head_branch: string
      event: string
      html_url: string
      created_at: string
    }[]
  }>(`${repoPath(repo)}/actions/runs?${params}&per_page=${options.limit ?? 10}`)

  return (raw.workflow_runs ?? []).map((run) => ({
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    branch: run.head_branch,
    event: run.event,
    url: run.html_url,
    createdAt: run.created_at,
  }))
}

/**
 * The failing jobs and steps of a run.
 *
 * Only the failures: a green run has nothing an agent needs, and a large
 * matrix build has dozens of jobs whose success is not information.
 */
export async function getRunFailures(
  client: GitHubClient,
  repo: Repo,
  runId: number,
): Promise<{ job: string; steps: string[]; url: string }[]> {
  const raw = await client.request<{
    jobs?: {
      name: string
      conclusion: string | null
      html_url: string
      steps?: { name: string; conclusion: string | null }[]
    }[]
  }>(`${repoPath(repo)}/actions/runs/${runId}/jobs?per_page=100`)

  return (raw.jobs ?? [])
    .filter((job) => job.conclusion === 'failure')
    .map((job) => ({
      job: job.name,
      steps: (job.steps ?? [])
        .filter((step) => step.conclusion === 'failure')
        .map((step) => step.name),
      url: job.html_url,
    }))
}

/** A job's log text. */
export async function getJobLogs(
  client: GitHubClient,
  repo: Repo,
  jobId: number,
): Promise<string> {
  return client.request<string>(`${repoPath(repo)}/actions/jobs/${jobId}/logs`, {
    accept: 'application/vnd.github.raw',
  })
}

export async function getCheckRuns(
  client: GitHubClient,
  repo: Repo,
  ref: string,
): Promise<CheckRun[]> {
  const raw = await client.request<{
    check_runs?: { name: string; status: string; conclusion: string | null; html_url: string }[]
  }>(`${repoPath(repo)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`)

  return (raw.check_runs ?? []).map((check) => ({
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
    url: check.html_url,
  }))
}

/** Searches code, optionally scoped to one repository. */
export async function searchCode(
  client: GitHubClient,
  query: string,
  repo?: Repo,
  limit = 20,
): Promise<{ path: string; repo: string; url: string }[]> {
  const scoped = repo ? `${query} repo:${repo.owner}/${repo.name}` : query
  const raw = await client.request<{
    items?: { path: string; repository: { full_name: string }; html_url: string }[]
  }>(`/search/code?q=${encodeURIComponent(scoped)}&per_page=${limit}`)

  return (raw.items ?? []).map((item) => ({
    path: item.path,
    repo: item.repository.full_name,
    url: item.html_url,
  }))
}
