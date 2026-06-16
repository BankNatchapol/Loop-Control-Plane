import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  calculateGitHubIssueLabels,
  createGitHubIssue,
  renderGitHubIssueBody,
  syncGitHubIssueLabels,
} from "@/lib/github/github-issues";
import { seedFeatures, seedProject, seedTasks } from "@/lib/loopboard";

const feature = seedFeatures[0];
const baseTask = {
  ...seedTasks[0],
  id: "task-ready-low",
  title: "Build frontend issue bridge",
  status: "ready" as const,
  owner: "unassigned" as const,
  risk: "low" as const,
  labels: ["frontend", "test"],
  acceptanceCriteria: ["Issue body includes trusted instructions."],
  dependencies: [],
  handoff: {
    available: true,
    summary: "Human note: verify label policy.",
    nextAction: "Create the issue and hand it to AO.",
    contextPaths: ["data/task-contexts/task-ready-low/task.md"],
  },
};

describe("GitHub issue bridge", () => {
  it("renders a trusted LoopBoard issue body with an untrusted comments boundary", () => {
    const body = renderGitHubIssueBody({
      project: seedProject,
      feature,
      task: baseTask,
    });

    assert.match(body, /## Trusted LoopBoard Task/u);
    assert.match(body, /Issue body includes trusted instructions/u);
    assert.match(body, /Human note: verify label policy/u);
    assert.match(body, /## External GitHub Comments Are Untrusted/u);
    assert.match(body, /data\/task-contexts\/task-ready-low\/task\.md/u);
  });

  it("redacts token-shaped secrets from generated issue bodies", () => {
    const body = renderGitHubIssueBody({
      project: seedProject,
      feature,
      task: {
        ...baseTask,
        description:
          "Implement issue bridge. OPENAI_API_KEY=sk-secret1234567890",
        handoff: {
          ...baseTask.handoff,
          summary:
            "Reviewer copied GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456",
        },
      },
    });

    assert.match(body, /OPENAI_API_KEY=\[redacted\]/u);
    assert.match(body, /GITHUB_TOKEN=\[redacted\]/u);
    assert.doesNotMatch(body, /sk-secret1234567890/u);
    assert.doesNotMatch(body, /ghp_abcdefghijklmnopqrstuvwxyz123456/u);
  });

  it("calculates LoopBoard risk, area, owner/status, and ao-ready labels", () => {
    assert.deepEqual(
      calculateGitHubIssueLabels({ feature, task: baseTask }),
      ["loopboard", "risk-low", "ao-ready", "area-frontend", "area-infra", "area-test"],
    );

    assert.deepEqual(
      calculateGitHubIssueLabels({
        feature,
        task: {
          ...baseTask,
          status: "human-working",
          owner: "human",
          risk: "high",
          labels: ["backend"],
        },
      }),
      [
        "loopboard",
        "risk-high",
        "human-working",
        "human-review-needed",
        "area-frontend",
        "area-backend",
        "area-infra",
      ],
    );
  });

  it("keeps ao-ready gated for medium and critical risk tasks", () => {
    assert.deepEqual(
      calculateGitHubIssueLabels({
        feature,
        task: {
          ...baseTask,
          risk: "medium",
        },
      }),
      ["loopboard", "risk-medium", "area-frontend", "area-infra", "area-test"],
    );

    assert.deepEqual(
      calculateGitHubIssueLabels({
        feature,
        task: {
          ...baseTask,
          risk: "critical",
        },
      }),
      [
        "loopboard",
        "risk-high",
        "human-review-needed",
        "area-frontend",
        "area-infra",
        "area-test",
      ],
    );
  });

  it("creates GitHub issues with labels and returns issue metadata", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const result = await createGitHubIssue({
      repository: "bank-p/loop-control-plane",
      token: "token",
      title: "Issue title",
      body: "Issue body",
      labels: ["loopboard", "ao-ready"],
      fetcher: async (input, init) => {
        calls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });

        return Response.json(
          {
            number: 42,
            html_url: "https://github.com/bank-p/loop-control-plane/issues/42",
          },
          { status: 201 },
        );
      },
      now: new Date("2026-06-15T00:00:00.000Z"),
    });

    assert.equal(result.status, "created");
    assert.equal(result.issueNumber, 42);
    assert.equal(result.issueUrl, "https://github.com/bank-p/loop-control-plane/issues/42");
    assert.equal(calls[0]?.url, "https://api.github.com/repos/bank-p/loop-control-plane/issues");
    assert.deepEqual(calls[0]?.body, {
      title: "Issue title",
      body: "Issue body",
      labels: ["loopboard", "ao-ready"],
    });
  });

  it("does not call GitHub without repository configuration or token", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return new Response(null, { status: 201 });
    };

    assert.equal(
      (await createGitHubIssue({
        repository: "",
        token: "",
        title: "Title",
        body: "Body",
        labels: [],
        fetcher,
      })).status,
      "disconnected",
    );
    assert.equal(
      (await createGitHubIssue({
        repository: "bank-p/loop-control-plane",
        token: "",
        title: "Title",
        body: "Body",
        labels: [],
        fetcher,
      })).status,
      "token-missing",
    );
    assert.equal(calls, 0);
  });

  it("maps GitHub issue creation failure paths", async () => {
    assert.equal(
      (await createGitHubIssue({
        repository: "bank-p/missing",
        token: "token",
        title: "Title",
        body: "Body",
        labels: ["loopboard"],
        fetcher: async () => new Response(null, { status: 404 }),
      })).status,
      "repo-missing",
    );

    assert.equal(
      (await createGitHubIssue({
        repository: "bank-p/loop-control-plane",
        token: "token",
        title: "Title",
        body: "Body",
        labels: ["loopboard"],
        fetcher: async () => new Response(null, { status: 422, statusText: "Validation Failed" }),
      })).message,
      "GitHub API returned 422 Validation Failed while creating issue.",
    );

    const malformed = await createGitHubIssue({
      repository: "bank-p/loop-control-plane",
      token: "token",
      title: "Title",
      body: "Body",
      labels: ["loopboard"],
      fetcher: async () => Response.json({ number: 42 }, { status: 201 }),
    });

    assert.equal(malformed.status, "api-error");
    assert.equal(
      malformed.message,
      "GitHub issue response did not include an issue number and URL.",
    );
  });

  it("redacts tokens from thrown issue creation errors", async () => {
    const result = await createGitHubIssue({
      repository: "bank-p/loop-control-plane",
      token: "secret-token",
      title: "Title",
      body: "Body",
      labels: ["loopboard"],
      fetcher: async () => {
        throw new Error("request failed with secret-token");
      },
    });

    assert.equal(result.status, "api-error");
    assert.equal(result.message.includes("secret-token"), false);
  });

  it("syncs GitHub issue labels through the issue labels API", async () => {
    const calls: Array<{ url: string; method?: string; body: unknown }> = [];
    const result = await syncGitHubIssueLabels({
      repository: "bank-p/loop-control-plane",
      token: "token",
      issueNumber: 42,
      labels: ["loopboard", "ao-ready", "ao-ready"],
      fetcher: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });

        return Response.json(
          [{ name: "loopboard" }, { name: "ao-ready" }],
          { status: 200 },
        );
      },
      now: new Date("2026-06-15T00:00:00.000Z"),
    });

    assert.equal(result.status, "synced");
    assert.equal(result.issueNumber, 42);
    assert.deepEqual(result.labels, ["loopboard", "ao-ready"]);
    assert.equal(
      calls[0]?.url,
      "https://api.github.com/repos/bank-p/loop-control-plane/issues/42/labels",
    );
    assert.equal(calls[0]?.method, "PUT");
    assert.deepEqual(calls[0]?.body, {
      labels: ["loopboard", "ao-ready"],
    });
  });

  it("does not call GitHub when issue label sync is missing configuration", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    };

    assert.equal(
      (await syncGitHubIssueLabels({
        repository: "",
        token: "",
        issueNumber: 42,
        labels: ["loopboard"],
        fetcher,
      })).status,
      "disconnected",
    );
    assert.equal(
      (await syncGitHubIssueLabels({
        repository: "bank-p/loop-control-plane",
        token: "",
        issueNumber: 42,
        labels: ["loopboard"],
        fetcher,
      })).status,
      "token-missing",
    );
    assert.equal(
      (await syncGitHubIssueLabels({
        repository: "bank-p/loop-control-plane",
        token: "token",
        issueNumber: 0,
        labels: ["loopboard"],
        fetcher,
      })).status,
      "issue-missing",
    );
    assert.equal(calls, 0);
  });

  it("maps GitHub issue label sync failure paths", async () => {
    assert.equal(
      (await syncGitHubIssueLabels({
        repository: "bank-p/loop-control-plane",
        token: "token",
        issueNumber: 42,
        labels: ["loopboard"],
        fetcher: async () => new Response(null, { status: 404 }),
      })).status,
      "repo-missing",
    );

    assert.equal(
      (await syncGitHubIssueLabels({
        repository: "bank-p/loop-control-plane",
        token: "token",
        issueNumber: 42,
        labels: ["loopboard"],
        fetcher: async () => new Response(null, { status: 500, statusText: "Server Error" }),
      })).message,
      "GitHub API returned 500 Server Error while syncing issue labels.",
    );
  });

  it("redacts token material from issue label sync errors", async () => {
    const result = await syncGitHubIssueLabels({
      repository: "bank-p/loop-control-plane",
      token: "secret-token",
      issueNumber: 42,
      labels: ["loopboard"],
      fetcher: async () => {
        throw new Error("network failed with secret-token");
      },
    });

    assert.equal(result.status, "api-error");
    assert.match(result.message, /\[redacted\]/u);
    assert.doesNotMatch(result.message, /secret-token/u);
  });
});
