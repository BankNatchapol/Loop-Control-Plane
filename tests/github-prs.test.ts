import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseGitHubPullRequestNumber,
  syncGitHubPullRequest,
} from "@/lib/github/github-prs";
import { seedTasks } from "@/lib/loopboard";

const baseTask = {
  ...seedTasks[0],
  id: "task-pr-sync",
  branch: "feature/pr-sync",
  github: {
    issueNumber: 42,
    issueUrl: "https://github.com/bank-p/loop-control-plane/issues/42",
  },
  dependencies: [],
};

const prPayload = ({
  number,
  state = "open",
  draft = false,
  merged = false,
  mergeable = true,
  headSha = "abc123",
  requestedReviewers = [],
  updatedAt = "2026-06-15T00:00:00.000Z",
}: {
  number: number;
  state?: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean;
  headSha?: string;
  requestedReviewers?: unknown[];
  updatedAt?: string;
}) => ({
  number,
  html_url: `https://github.com/bank-p/loop-control-plane/pull/${number}`,
  state,
  draft,
  merged,
  mergeable,
  head: {
    ref: "feature/pr-sync",
    sha: headSha,
  },
  requested_reviewers: requestedReviewers,
  requested_teams: [],
  updated_at: updatedAt,
});

describe("GitHub pull request sync", () => {
  it("parses repository-scoped pull request URLs", () => {
    assert.equal(
      parseGitHubPullRequestNumber(
        "https://github.com/bank-p/loop-control-plane/pull/123",
        "bank-p/loop-control-plane",
      ),
      123,
    );
    assert.equal(
      parseGitHubPullRequestNumber(
        "https://github.com/other/repo/pull/123",
        "bank-p/loop-control-plane",
      ),
      null,
    );
  });

  it("discovers pull requests from issue timeline references and reviews", async () => {
    const calls: string[] = [];
    const result = await syncGitHubPullRequest({
      repository: "bank-p/loop-control-plane",
      token: "token",
      task: baseTask,
      fetcher: async (input) => {
        const url = String(input);
        calls.push(url);

        if (url.endsWith("/issues/42/timeline?per_page=100")) {
          return Response.json([
            {
              source: {
                issue: {
                  number: 77,
                  html_url:
                    "https://github.com/bank-p/loop-control-plane/pull/77",
                  pull_request: {},
                },
              },
            },
          ]);
        }

        if (url.endsWith("/pulls/77")) {
          return Response.json({
            number: 77,
            html_url: "https://github.com/bank-p/loop-control-plane/pull/77",
            state: "open",
            draft: false,
            merged: false,
            mergeable: true,
            head: {
              ref: "feature/pr-sync",
              sha: "abc123",
            },
            requested_reviewers: [{ login: "reviewer" }],
            requested_teams: [],
            updated_at: "2026-06-15T00:00:00.000Z",
          });
        }

        if (url.endsWith("/pulls/77/reviews?per_page=100")) {
          return Response.json([]);
        }

        if (url.endsWith("/commits/abc123/check-runs?per_page=100")) {
          return Response.json({
            check_runs: [
              {
                name: "unit tests",
                html_url:
                  "https://github.com/bank-p/loop-control-plane/actions/runs/1/job/2",
                status: "completed",
                conclusion: "success",
              },
            ],
          });
        }

        if (url.endsWith("/commits/abc123/status")) {
          return Response.json({
            state: "success",
            statuses: [],
          });
        }

        return new Response(null, { status: 404 });
      },
      now: new Date("2026-06-15T01:00:00.000Z"),
    });

    assert.equal(result.status, "synced");
    assert.equal(result.github?.pullRequestNumber, 77);
    assert.equal(result.github?.pullRequestState, "open");
    assert.equal(result.github?.mergeStatus, "mergeable");
    assert.equal(result.github?.ciStatus, "passing");
    assert.equal(result.github?.reviewStatus, "requested");
    assert.equal(result.github?.deliveryStatus, "review-requested");
    assert.deepEqual(result.linkedIssueNumbers, [42]);
    assert.equal(calls.length, 5);
  });

  it("discovers pull requests from branch names when issue timeline has none", async () => {
    const result = await syncGitHubPullRequest({
      repository: "bank-p/loop-control-plane",
      token: "token",
      task: {
        ...baseTask,
        github: {},
      },
      fetcher: async (input) => {
        const url = String(input);

        if (
          url.endsWith(
            "/pulls?state=all&head=bank-p%3Afeature%2Fpr-sync&per_page=10",
          )
        ) {
          return Response.json([
            {
              number: 78,
              html_url: "https://github.com/bank-p/loop-control-plane/pull/78",
              state: "open",
              draft: false,
              merged: false,
              mergeable: true,
              head: { ref: "feature/pr-sync" },
              requested_reviewers: [],
              requested_teams: [],
              updated_at: "2026-06-15T00:00:00.000Z",
            },
          ]);
        }

        if (url.endsWith("/pulls/78")) {
          return Response.json({
            number: 78,
            html_url: "https://github.com/bank-p/loop-control-plane/pull/78",
            state: "open",
            draft: false,
            merged: false,
            mergeable: true,
            head: { ref: "feature/pr-sync" },
            requested_reviewers: [],
            requested_teams: [],
            updated_at: "2026-06-15T00:00:00.000Z",
          });
        }

        if (url.endsWith("/pulls/78/reviews?per_page=100")) {
          return Response.json([
            {
              state: "APPROVED",
              submitted_at: "2026-06-15T00:30:00.000Z",
              html_url:
                "https://github.com/bank-p/loop-control-plane/pull/78#pullrequestreview-1",
            },
          ]);
        }

        return new Response(null, { status: 404 });
      },
      now: new Date("2026-06-15T01:00:00.000Z"),
    });

    assert.equal(result.status, "synced");
    assert.equal(result.github?.pullRequestNumber, 78);
    assert.equal(result.github?.reviewStatus, "approved");
    assert.equal(
      result.github?.reviewUrl,
      "https://github.com/bank-p/loop-control-plane/pull/78#pullrequestreview-1",
    );
    assert.equal(result.github?.deliveryStatus, "approved");
  });

  it("reports no PR without requiring an issue link", async () => {
    const result = await syncGitHubPullRequest({
      repository: "bank-p/loop-control-plane",
      token: "token",
      task: {
        ...baseTask,
        github: {},
      },
      fetcher: async () => Response.json([]),
      now: new Date("2026-06-15T01:00:00.000Z"),
    });

    assert.equal(result.status, "not-found");
    assert.equal(result.github?.deliveryStatus, "no-pr");
    assert.equal(result.github?.prCiLastSyncedAt, "2026-06-15T01:00:00.000Z");
  });

  it("normalizes failing CI checks and stores concise check links", async () => {
    const result = await syncGitHubPullRequest({
      repository: "bank-p/loop-control-plane",
      token: "token",
      task: {
        ...baseTask,
        github: {
          pullRequestNumber: 79,
          pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/79",
        },
      },
      fetcher: async (input) => {
        const url = String(input);

        if (url.endsWith("/pulls/79")) {
          return Response.json({
            number: 79,
            html_url: "https://github.com/bank-p/loop-control-plane/pull/79",
            state: "open",
            draft: false,
            merged: false,
            mergeable: true,
            head: { ref: "feature/pr-sync", sha: "def456" },
            requested_reviewers: [],
            requested_teams: [],
            updated_at: "2026-06-15T00:00:00.000Z",
          });
        }

        if (url.endsWith("/pulls/79/reviews?per_page=100")) {
          return Response.json([]);
        }

        if (url.endsWith("/commits/def456/check-runs?per_page=100")) {
          return Response.json({
            check_runs: [
              {
                name: "unit tests",
                html_url:
                  "https://github.com/bank-p/loop-control-plane/actions/runs/2/job/3",
                status: "completed",
                conclusion: "failure",
              },
              {
                name: "lint",
                html_url:
                  "https://github.com/bank-p/loop-control-plane/actions/runs/2/job/4",
                status: "completed",
                conclusion: "success",
              },
            ],
          });
        }

        if (url.endsWith("/commits/def456/status")) {
          return Response.json({
            state: "success",
            statuses: [
              {
                context: "deploy preview",
                target_url: "https://checks.example.test/deploy-preview",
                state: "success",
              },
            ],
          });
        }

        return new Response(null, { status: 404 });
      },
      now: new Date("2026-06-15T01:00:00.000Z"),
    });

    assert.equal(result.status, "synced");
    assert.equal(result.github?.ciStatus, "failing");
    assert.match(result.github?.ciFailureSummary ?? "", /unit tests/u);
    assert.match(
      result.github?.ciFailureSummary ?? "",
      /https:\/\/github\.com\/bank-p\/loop-control-plane\/actions\/runs\/2\/job\/3/u,
    );
    assert.doesNotMatch(result.github?.ciFailureSummary ?? "", /lint/u);
  });

  it("normalizes mocked GitHub PR, CI, review, merge, and closed scenarios", async () => {
    const scenarios = [
      {
        name: "open PR with running CI",
        number: 81,
        pullRequest: prPayload({ number: 81 }),
        reviews: [],
        checkRuns: [
          {
            name: "unit tests",
            html_url:
              "https://github.com/bank-p/loop-control-plane/actions/runs/81/job/1",
            status: "in_progress",
          },
        ],
        commitStatuses: [],
        existingGithub: {},
        expected: {
          pullRequestState: "open",
          ciStatus: "pending",
          reviewStatus: "not-requested",
          deliveryStatus: "ci-running",
          reviewUrl: undefined,
        },
      },
      {
        name: "review requested",
        number: 82,
        pullRequest: prPayload({
          number: 82,
          requestedReviewers: [{ login: "reviewer" }],
        }),
        reviews: [],
        checkRuns: [
          {
            name: "unit tests",
            html_url:
              "https://github.com/bank-p/loop-control-plane/actions/runs/82/job/1",
            status: "completed",
            conclusion: "success",
          },
        ],
        commitStatuses: [],
        existingGithub: {},
        expected: {
          pullRequestState: "open",
          ciStatus: "passing",
          reviewStatus: "requested",
          deliveryStatus: "review-requested",
          reviewUrl: undefined,
        },
      },
      {
        name: "changes requested",
        number: 83,
        pullRequest: prPayload({ number: 83 }),
        reviews: [
          {
            state: "CHANGES_REQUESTED",
            submitted_at: "2026-06-15T00:30:00.000Z",
            html_url:
              "https://github.com/bank-p/loop-control-plane/pull/83#pullrequestreview-1",
          },
        ],
        checkRuns: [
          {
            name: "unit tests",
            html_url:
              "https://github.com/bank-p/loop-control-plane/actions/runs/83/job/1",
            status: "completed",
            conclusion: "success",
          },
        ],
        commitStatuses: [],
        existingGithub: {},
        expected: {
          pullRequestState: "open",
          ciStatus: "passing",
          reviewStatus: "changes-requested",
          deliveryStatus: "changes-requested",
          reviewUrl:
            "https://github.com/bank-p/loop-control-plane/pull/83#pullrequestreview-1",
        },
      },
      {
        name: "approved with passing commit status",
        number: 84,
        pullRequest: prPayload({ number: 84 }),
        reviews: [
          {
            state: "APPROVED",
            submitted_at: "2026-06-15T00:30:00.000Z",
            html_url:
              "https://github.com/bank-p/loop-control-plane/pull/84#pullrequestreview-1",
          },
        ],
        checkRuns: [],
        commitStatuses: [
          {
            context: "lint",
            target_url: "https://checks.example.test/lint",
            state: "success",
          },
        ],
        existingGithub: {},
        expected: {
          pullRequestState: "open",
          ciStatus: "passing",
          reviewStatus: "approved",
          deliveryStatus: "approved",
          reviewUrl:
            "https://github.com/bank-p/loop-control-plane/pull/84#pullrequestreview-1",
        },
      },
      {
        name: "merged PR",
        number: 85,
        pullRequest: prPayload({
          number: 85,
          state: "closed",
          merged: true,
        }),
        reviews: [
          {
            state: "APPROVED",
            submitted_at: "2026-06-15T00:30:00.000Z",
          },
        ],
        checkRuns: [
          {
            name: "unit tests",
            status: "completed",
            conclusion: "failure",
          },
        ],
        commitStatuses: [],
        existingGithub: {
          ciStatus: "passing",
          reviewStatus: "approved",
        },
        expected: {
          pullRequestState: "merged",
          ciStatus: "passing",
          reviewStatus: "approved",
          deliveryStatus: "merged",
          reviewUrl: undefined,
        },
      },
      {
        name: "closed PR",
        number: 86,
        pullRequest: prPayload({
          number: 86,
          state: "closed",
          merged: false,
        }),
        reviews: [],
        checkRuns: [
          {
            name: "unit tests",
            status: "completed",
            conclusion: "failure",
          },
        ],
        commitStatuses: [],
        existingGithub: {
          ciStatus: "passing",
          reviewStatus: "not-requested",
        },
        expected: {
          pullRequestState: "closed",
          ciStatus: "passing",
          reviewStatus: "not-requested",
          deliveryStatus: "closed",
          reviewUrl: undefined,
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      const result = await syncGitHubPullRequest({
        repository: "bank-p/loop-control-plane",
        token: "token",
        task: {
          ...baseTask,
          github: {
            ...baseTask.github,
            ...scenario.existingGithub,
            pullRequestNumber: scenario.number,
            pullRequestUrl: `https://github.com/bank-p/loop-control-plane/pull/${scenario.number}`,
          },
        },
        fetcher: async (input) => {
          const url = String(input);

          if (url.endsWith(`/pulls/${scenario.number}`)) {
            return Response.json(scenario.pullRequest);
          }

          if (url.endsWith(`/pulls/${scenario.number}/reviews?per_page=100`)) {
            return Response.json(scenario.reviews);
          }

          if (url.includes("/check-runs?per_page=100")) {
            return Response.json({ check_runs: scenario.checkRuns });
          }

          if (url.endsWith("/status")) {
            return Response.json({
              state: scenario.commitStatuses.some((status) => status.state !== "success")
                ? "failure"
                : "success",
              statuses: scenario.commitStatuses,
            });
          }

          return new Response(null, { status: 404 });
        },
        now: new Date("2026-06-15T01:00:00.000Z"),
      });

      assert.equal(result.status, "synced", scenario.name);
      assert.equal(
        result.github?.pullRequestState,
        scenario.expected.pullRequestState,
        scenario.name,
      );
      assert.equal(result.github?.ciStatus, scenario.expected.ciStatus, scenario.name);
      assert.equal(
        result.github?.reviewStatus,
        scenario.expected.reviewStatus,
        scenario.name,
      );
      assert.equal(
        result.github?.deliveryStatus,
        scenario.expected.deliveryStatus,
        scenario.name,
      );
      assert.equal(result.github?.reviewUrl, scenario.expected.reviewUrl, scenario.name);
    }
  });
});
