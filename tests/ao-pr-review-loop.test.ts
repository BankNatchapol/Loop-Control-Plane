import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAoPrReviewGate } from "@/lib/engine/ao-pr-review-loop";

describe("AO PR-Agent review loop", () => {
  it("sends findings once per SHA and reruns after the worker pushes", async () => {
    let sha = "sha-1";
    let reviewCalls = 0;
    const messages: string[] = [];
    const gate = createAoPrReviewGate({
      plugin: "codex",
      model: "gpt-5.5",
      maxIterations: 3,
      publishOutput: false,
      readHeadSha: async () => sha,
      runReview: async () => {
        reviewCalls += 1;
        return reviewCalls === 1
          ? { success: true, verdict: "needs changes", summary: "Fix the bug." }
          : { success: true, verdict: "approved", summary: "Clean." };
      },
      sendToWorker: (_sessionId, message) => {
        messages.push(message);
        return true;
      },
    });

    assert.equal(await gate({
      issueNumber: 2,
      sessionId: "worker-2",
      prUrl: "https://github.com/org/repo/pull/51",
    }), "hold");
    assert.equal(messages.length, 1);
    assert.equal(reviewCalls, 1);

    assert.equal(await gate({
      issueNumber: 2,
      sessionId: "worker-2",
      prUrl: "https://github.com/org/repo/pull/51",
    }), "hold");
    assert.equal(messages.length, 1);
    assert.equal(reviewCalls, 1);

    sha = "sha-2";
    assert.equal(await gate({
      issueNumber: 2,
      sessionId: "worker-2",
      prUrl: "https://github.com/org/repo/pull/51",
    }), "approved");
    assert.equal(reviewCalls, 2);
  });

  it("fails after the configured number of unsuccessful review iterations", async () => {
    let iteration = 0;
    const gate = createAoPrReviewGate({
      plugin: "codex",
      model: "gpt-5.5",
      maxIterations: 1,
      publishOutput: false,
      readHeadSha: async () => `sha-${iteration}`,
      runReview: async () => {
        iteration += 1;
        return { success: true, verdict: "needs changes", summary: "Still broken." };
      },
      sendToWorker: () => true,
    });

    assert.equal(await gate({
      issueNumber: 2,
      sessionId: "worker-2",
      prUrl: "https://github.com/org/repo/pull/51",
    }), "hold");
    assert.equal(await gate({
      issueNumber: 2,
      sessionId: "worker-2",
      prUrl: "https://github.com/org/repo/pull/51",
    }), "fail");
  });
});
