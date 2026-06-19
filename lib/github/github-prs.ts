import type { PersistedTask } from "@/lib/db/loopboard-repository";
import { redactGitHubToken } from "@/lib/github/github-connection";
import type {
  CiStatus,
  GitHubState,
  MergeStatus,
  PullRequestState,
  ReviewStatus,
} from "@/lib/loopboard";
import { normalizeGitHubDeliveryStatus } from "@/lib/loopboard";
import { normalizeGitHubRepository } from "@/lib/projects/project-repository-health";
import { sanitizeExternalSummary } from "@/lib/security/safe-context";

type FetchLike = typeof fetch;

export type GitHubPullRequestSyncStatus =
  | "disconnected"
  | "token-missing"
  | "repo-missing"
  | "not-found"
  | "synced"
  | "api-error";

export type GitHubPullRequestSyncResult = {
  status: GitHubPullRequestSyncStatus;
  repository: string;
  message: string;
  syncedAt: string;
  github?: GitHubState;
  linkedIssueNumbers: number[];
};

type GitHubPullRequestPayload = {
  number?: unknown;
  html_url?: unknown;
  state?: unknown;
  draft?: unknown;
  merged?: unknown;
  mergeable?: unknown;
  mergeable_state?: unknown;
  head?: {
    ref?: unknown;
    sha?: unknown;
  };
  requested_reviewers?: unknown;
  requested_teams?: unknown;
  updated_at?: unknown;
};

type GitHubTimelineEvent = {
  event?: unknown;
  source?: {
    issue?: {
      number?: unknown;
      html_url?: unknown;
      pull_request?: unknown;
    };
  };
};

type GitHubReviewPayload = {
  state?: unknown;
  submitted_at?: unknown;
  html_url?: unknown;
};

type GitHubCheckRunPayload = {
  name?: unknown;
  html_url?: unknown;
  status?: unknown;
  conclusion?: unknown;
};

type GitHubCheckRunsPayload = {
  check_runs?: unknown;
};

type GitHubCommitStatusPayload = {
  state?: unknown;
  statuses?: unknown;
};

type GitHubStatusPayload = {
  context?: unknown;
  target_url?: unknown;
  state?: unknown;
};

type CiCheck = {
  name: string;
  url: string;
  state: "pending" | "passing" | "failing" | "neutral";
};

const githubApiHeaders = (token: string) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "User-Agent": "Loop Control Plane",
  "X-GitHub-Api-Version": "2022-11-28",
});

export const parseGitHubPullRequestNumber = (
  value: string | undefined,
  repository?: string,
): number | null => {
  if (!value) {
    return null;
  }

  const normalizedRepository = repository
    ? normalizeGitHubRepository(repository)
    : "";
  const pattern = normalizedRepository
    ? new RegExp(
        `^https://github\\.com/${normalizedRepository.replace("/", "\\/")}/pull/(\\d+)(?:[/?#].*)?$`,
        "u",
      )
    : /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:[/?#].*)?$/u;
  const match = pattern.exec(value.trim());
  const number = match ? Number(match[1]) : Number.NaN;

  return Number.isInteger(number) && number > 0 ? number : null;
};

const prUrl = (repository: string, pullRequestNumber: number): string =>
  `https://github.com/${repository}/pull/${pullRequestNumber}`;

const apiUrl = (repository: string, path: string): string =>
  `https://api.github.com/repos/${repository}${path}`;

const fetchJson = async <T>(
  fetcher: FetchLike,
  url: string,
  token: string,
): Promise<{ status: number; ok: boolean; statusText: string; payload: T | null }> => {
  const response = await fetcher(url, {
    headers: githubApiHeaders(token),
  });

  return {
    status: response.status,
    ok: response.ok,
    statusText: response.statusText,
    payload: (await response.json().catch(() => null)) as T | null,
  };
};

const uniquePositiveNumbers = (items: Array<number | null | undefined>): number[] =>
  Array.from(
    new Set(
      items.filter(
        (item): item is number =>
          typeof item === "number" && Number.isInteger(item) && item > 0,
      ),
    ),
  );

const extractTimelinePullRequestNumbers = (
  timeline: GitHubTimelineEvent[] | null,
  repository: string,
): number[] => {
  if (!Array.isArray(timeline)) {
    return [];
  }

  return uniquePositiveNumbers(
    timeline.map((item) => {
      const issue = item.source?.issue;
      if (!issue?.pull_request) {
        return null;
      }

      if (typeof issue.number === "number") {
        return issue.number;
      }

      return parseGitHubPullRequestNumber(
        typeof issue.html_url === "string" ? issue.html_url : undefined,
        repository,
      );
    }),
  );
};

const pullRequestNumber = (payload: GitHubPullRequestPayload): number | null =>
  typeof payload.number === "number" && Number.isInteger(payload.number) && payload.number > 0
    ? payload.number
    : null;

const pullRequestUpdatedAt = (payload: GitHubPullRequestPayload): string =>
  typeof payload.updated_at === "string" ? payload.updated_at : "";

const normalizePullRequestState = (
  payload: GitHubPullRequestPayload,
): PullRequestState => {
  if (payload.merged === true) {
    return "merged";
  }

  if (payload.draft === true) {
    return "draft";
  }

  return payload.state === "closed" ? "closed" : "open";
};

const normalizeMergeStatus = (payload: GitHubPullRequestPayload): MergeStatus => {
  if (payload.merged === true) {
    return "merged";
  }

  if (
    payload.mergeable === false ||
    payload.mergeable_state === "dirty" ||
    payload.mergeable_state === "blocked"
  ) {
    return "conflicting";
  }

  return payload.mergeable === true ? "mergeable" : "unknown";
};

const requestedReviewCount = (payload: GitHubPullRequestPayload): number => {
  const reviewers = Array.isArray(payload.requested_reviewers)
    ? payload.requested_reviewers
    : [];
  const teams = Array.isArray(payload.requested_teams)
    ? payload.requested_teams
    : [];

  return reviewers.length + teams.length;
};

const normalizeReviewStatus = (
  pullRequest: GitHubPullRequestPayload,
  reviews: GitHubReviewPayload[] | null,
): ReviewStatus => {
  const latestRelevantReview = Array.isArray(reviews)
    ? [...reviews]
        .filter(
          (review) =>
            review.state === "APPROVED" || review.state === "CHANGES_REQUESTED",
        )
        .sort((left, right) =>
          String(right.submitted_at ?? "").localeCompare(String(left.submitted_at ?? "")),
        )[0]
    : undefined;

  if (latestRelevantReview?.state === "CHANGES_REQUESTED") {
    return "changes-requested";
  }

  if (latestRelevantReview?.state === "APPROVED") {
    return "approved";
  }

  return requestedReviewCount(pullRequest) > 0 ? "requested" : "not-requested";
};

const latestRelevantReviewUrl = (
  reviews: GitHubReviewPayload[] | null,
): string | undefined => {
  const latestReview = Array.isArray(reviews)
    ? [...reviews]
        .filter(
          (review) =>
            review.state === "APPROVED" || review.state === "CHANGES_REQUESTED",
        )
        .sort((left, right) =>
          String(right.submitted_at ?? "").localeCompare(String(left.submitted_at ?? "")),
        )[0]
    : undefined;

  return typeof latestReview?.html_url === "string"
    ? latestReview.html_url
    : undefined;
};

const normalizeCheckRunState = (
  checkRun: GitHubCheckRunPayload,
): CiCheck["state"] => {
  if (
    checkRun.status === "queued" ||
    checkRun.status === "in_progress" ||
    checkRun.status === "requested" ||
    checkRun.status === "waiting" ||
    checkRun.status === "pending"
  ) {
    return "pending";
  }

  if (checkRun.conclusion === "success") {
    return "passing";
  }

  if (
    checkRun.conclusion === "failure" ||
    checkRun.conclusion === "cancelled" ||
    checkRun.conclusion === "timed_out" ||
    checkRun.conclusion === "action_required"
  ) {
    return "failing";
  }

  return "neutral";
};

const normalizeCommitStatusState = (
  status: GitHubStatusPayload,
): CiCheck["state"] => {
  if (status.state === "pending") {
    return "pending";
  }

  if (status.state === "success") {
    return "passing";
  }

  if (status.state === "failure" || status.state === "error") {
    return "failing";
  }

  return "neutral";
};

const normalizeCiStatus = (checks: CiCheck[]): CiStatus => {
  if (checks.length === 0) {
    return "not-started";
  }

  if (checks.some((check) => check.state === "failing")) {
    return "failing";
  }

  if (checks.some((check) => check.state === "pending")) {
    return "pending";
  }

  return checks.some((check) => check.state === "passing")
    ? "passing"
    : "not-started";
};

const ciFailureSummary = (checks: CiCheck[]): string | undefined => {
  const failingChecks = checks.filter((check) => check.state === "failing").slice(0, 5);

  if (failingChecks.length === 0) {
    return undefined;
  }

  const summary = failingChecks
    .map((check) => (check.url ? `${check.name} (${check.url})` : check.name))
    .join("; ");

  const externalSummary =
    checks.filter((check) => check.state === "failing").length > failingChecks.length
      ? `${summary}; plus more failing checks`
      : summary;

  return sanitizeExternalSummary(externalSummary);
};

const checksFromCheckRuns = (
  checkRuns: GitHubCheckRunsPayload | null,
): CiCheck[] => {
  const runs = Array.isArray(checkRuns?.check_runs) ? checkRuns.check_runs : [];

  return runs
    .filter((run): run is GitHubCheckRunPayload => Boolean(run))
    .map((run) => ({
      name: typeof run.name === "string" && run.name.trim() ? run.name.trim() : "check",
      url: typeof run.html_url === "string" ? run.html_url : "",
      state: normalizeCheckRunState(run),
    }));
};

const checksFromCommitStatuses = (
  commitStatus: GitHubCommitStatusPayload | null,
): CiCheck[] => {
  const statuses = Array.isArray(commitStatus?.statuses)
    ? commitStatus.statuses
    : [];

  return statuses
    .filter((status): status is GitHubStatusPayload => Boolean(status))
    .map((status) => ({
      name:
        typeof status.context === "string" && status.context.trim()
          ? status.context.trim()
          : "status check",
      url: typeof status.target_url === "string" ? status.target_url : "",
      state: normalizeCommitStatusState(status),
    }));
};

const fetchPullRequestCiChecks = async ({
  repository,
  token,
  headSha,
  fetcher,
}: {
  repository: string;
  token: string;
  headSha: string | undefined;
  fetcher: FetchLike;
}): Promise<{ ciStatus?: CiStatus; ciFailureSummary?: string }> => {
  if (!headSha) {
    return {};
  }

  const [checkRuns, commitStatus] = await Promise.all([
    fetchJson<GitHubCheckRunsPayload>(
      fetcher,
      apiUrl(repository, `/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`),
      token,
    ),
    fetchJson<GitHubCommitStatusPayload>(
      fetcher,
      apiUrl(repository, `/commits/${encodeURIComponent(headSha)}/status`),
      token,
    ),
  ]);
  const checks = [
    ...(checkRuns.ok ? checksFromCheckRuns(checkRuns.payload) : []),
    ...(commitStatus.ok ? checksFromCommitStatuses(commitStatus.payload) : []),
  ];

  return {
    ciStatus: normalizeCiStatus(checks),
    ciFailureSummary: ciFailureSummary(checks),
  };
};

const taskBranchCandidates = (task: PersistedTask): string[] =>
  Array.from(
    new Set(
      [task.github.pullRequestBranch, task.branch]
        .filter((branch): branch is string => typeof branch === "string")
        .map((branch) => branch.trim())
        .filter(Boolean),
    ),
  );

const discoverPullRequestNumbers = async ({
  repository,
  token,
  task,
  explicitPullRequestUrl,
  fetcher,
}: {
  repository: string;
  token: string;
  task: PersistedTask;
  explicitPullRequestUrl?: string;
  fetcher: FetchLike;
}): Promise<{ numbers: number[]; repoMissing: boolean }> => {
  const [owner] = repository.split("/");
  const explicitNumber =
    parseGitHubPullRequestNumber(explicitPullRequestUrl, repository) ??
    task.github.pullRequestNumber ??
    parseGitHubPullRequestNumber(task.github.pullRequestUrl, repository);
  const numbers = new Set(uniquePositiveNumbers([explicitNumber]));
  let repoMissing = false;

  if (numbers.size === 0 && task.github.issueNumber) {
    const timeline = await fetchJson<GitHubTimelineEvent[]>(
      fetcher,
      apiUrl(
        repository,
        `/issues/${task.github.issueNumber}/timeline?per_page=100`,
      ),
      token,
    );

    if (timeline.status === 404) {
      repoMissing = true;
    } else if (timeline.ok) {
      for (const number of extractTimelinePullRequestNumbers(
        timeline.payload,
        repository,
      )) {
        numbers.add(number);
      }
    }
  }

  if (numbers.size === 0) {
    for (const branch of taskBranchCandidates(task)) {
      const pullRequests = await fetchJson<GitHubPullRequestPayload[]>(
        fetcher,
        apiUrl(
          repository,
          `/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=10`,
        ),
        token,
      );

      if (pullRequests.status === 404) {
        repoMissing = true;
        continue;
      }

      if (!pullRequests.ok || !Array.isArray(pullRequests.payload)) {
        continue;
      }

      for (const pullRequest of pullRequests.payload) {
        const number = pullRequestNumber(pullRequest);
        if (number) {
          numbers.add(number);
        }
      }
    }
  }

  return { numbers: [...numbers], repoMissing };
};

const fetchPullRequest = async ({
  repository,
  token,
  number,
  fetcher,
}: {
  repository: string;
  token: string;
  number: number;
  fetcher: FetchLike;
}) =>
  fetchJson<GitHubPullRequestPayload>(
    fetcher,
    apiUrl(repository, `/pulls/${number}`),
    token,
  );

const fetchPullRequestReviews = async ({
  repository,
  token,
  number,
  fetcher,
}: {
  repository: string;
  token: string;
  number: number;
  fetcher: FetchLike;
}) =>
  fetchJson<GitHubReviewPayload[]>(
    fetcher,
    apiUrl(repository, `/pulls/${number}/reviews?per_page=100`),
    token,
  );

export const syncGitHubPullRequest = async ({
  repository,
  token,
  task,
  explicitPullRequestUrl,
  fetcher = fetch,
  now = new Date(),
}: {
  repository: string;
  token: string;
  task: PersistedTask;
  explicitPullRequestUrl?: string;
  fetcher?: FetchLike;
  now?: Date;
}): Promise<GitHubPullRequestSyncResult> => {
  const normalizedRepository = normalizeGitHubRepository(repository);
  const syncedAt = now.toISOString();

  if (!normalizedRepository) {
    return {
      status: "disconnected",
      repository: "",
      message: "No GitHub repository is configured for this project.",
      syncedAt,
      linkedIssueNumbers: [],
    };
  }

  if (!token) {
    return {
      status: "token-missing",
      repository: normalizedRepository,
      message:
        "Set LOOPBOARD_GITHUB_TOKEN or GITHUB_TOKEN in the server environment to sync GitHub pull requests.",
      syncedAt,
      linkedIssueNumbers: [],
    };
  }

  try {
    const discovery = await discoverPullRequestNumbers({
      repository: normalizedRepository,
      token,
      task,
      explicitPullRequestUrl,
      fetcher,
    });

    if (discovery.repoMissing) {
      return {
        status: "repo-missing",
        repository: normalizedRepository,
        message:
          "GitHub repository was not found or the configured token cannot read pull requests in it.",
        syncedAt,
        linkedIssueNumbers: task.github.issueNumber ? [task.github.issueNumber] : [],
      };
    }

    if (discovery.numbers.length === 0) {
      const github: GitHubState = {
        ...task.github,
        deliveryStatus: "no-pr",
        prCiLastSyncedAt: syncedAt,
      };

      return {
        status: "not-found",
        repository: normalizedRepository,
        message: "No linked GitHub pull request was found for this task.",
        syncedAt,
        github,
        linkedIssueNumbers: task.github.issueNumber ? [task.github.issueNumber] : [],
      };
    }

    const pullRequests = (
      await Promise.all(
        discovery.numbers.map(async (number) => {
          const response = await fetchPullRequest({
            repository: normalizedRepository,
            token,
            number,
            fetcher,
          });

          return response.ok && response.payload ? response.payload : null;
        }),
      )
    ).filter((item): item is GitHubPullRequestPayload => item !== null);

    if (pullRequests.length === 0) {
      return {
        status: "not-found",
        repository: normalizedRepository,
        message: "Discovered pull request references could not be loaded.",
        syncedAt,
        linkedIssueNumbers: task.github.issueNumber ? [task.github.issueNumber] : [],
      };
    }

    const pullRequest = [...pullRequests].sort((left, right) => {
      const leftState = normalizePullRequestState(left);
      const rightState = normalizePullRequestState(right);

      if (leftState !== "closed" && rightState === "closed") {
        return -1;
      }

      if (leftState === "closed" && rightState !== "closed") {
        return 1;
      }

      return pullRequestUpdatedAt(right).localeCompare(pullRequestUpdatedAt(left));
    })[0];
    const number = pullRequestNumber(pullRequest);

    if (!number) {
      return {
        status: "api-error",
        repository: normalizedRepository,
        message: "GitHub pull request response did not include a PR number.",
        syncedAt,
        linkedIssueNumbers: task.github.issueNumber ? [task.github.issueNumber] : [],
      };
    }

    const reviews = await fetchPullRequestReviews({
      repository: normalizedRepository,
      token,
      number,
      fetcher,
    });
    const ci = await fetchPullRequestCiChecks({
      repository: normalizedRepository,
      token,
      headSha: typeof pullRequest.head?.sha === "string" ? pullRequest.head.sha : undefined,
      fetcher,
    });
    const pullRequestState = normalizePullRequestState(pullRequest);
    const github: GitHubState = {
      ...task.github,
      issueNumber: task.github.issueNumber,
      issueUrl: task.github.issueUrl,
      pullRequestNumber: number,
      pullRequestUrl:
        typeof pullRequest.html_url === "string"
          ? pullRequest.html_url
          : prUrl(normalizedRepository, number),
      pullRequestBranch:
        typeof pullRequest.head?.ref === "string"
          ? pullRequest.head.ref
          : task.github.pullRequestBranch,
      pullRequestState,
      mergeStatus: normalizeMergeStatus(pullRequest),
      ciStatus:
        pullRequestState === "closed" || pullRequestState === "merged"
          ? task.github.ciStatus
          : ci.ciStatus ?? task.github.ciStatus,
      reviewStatus:
        pullRequestState === "closed" || pullRequestState === "merged"
          ? task.github.reviewStatus ?? "not-requested"
          : normalizeReviewStatus(pullRequest, reviews.payload),
      reviewUrl:
        pullRequestState === "closed" || pullRequestState === "merged"
          ? task.github.reviewUrl
          : latestRelevantReviewUrl(reviews.payload),
      prCiLastSyncedAt: syncedAt,
    };
    if (pullRequestState !== "closed" && pullRequestState !== "merged") {
      github.ciFailureSummary = ci.ciFailureSummary;
    }
    github.deliveryStatus = normalizeGitHubDeliveryStatus(github);

    return {
      status: "synced",
      repository: normalizedRepository,
      message: `Synced GitHub pull request #${number}.`,
      syncedAt,
      github,
      linkedIssueNumbers: task.github.issueNumber ? [task.github.issueNumber] : [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub API error.";

    return {
      status: "api-error",
      repository: normalizedRepository,
      message: redactGitHubToken(message, token),
      syncedAt,
      linkedIssueNumbers: task.github.issueNumber ? [task.github.issueNumber] : [],
    };
  }
};
