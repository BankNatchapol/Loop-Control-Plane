import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { executePrReview } from "@/lib/engine/executors/pr-review-executor";

const baseInput = {
  featureId: "feature-review",
  workflowRunId: "run-review",
  projectRepoPath: process.cwd(),
  repository: "bank-p/loop-control-plane",
  plugin: "claude-code",
  model: "claude-sonnet-4-6",
  inputArtifacts: [
    {
      name: "pull-request",
      path: "https://github.com/bank-p/loop-control-plane/pull/51",
      required: true,
    },
  ],
  outputArtifacts: [
    {
      name: "review-comments",
      path: "loopboard://runs/{run}/review-comments",
      required: true,
    },
  ],
};

describe("pr-review-executor", () => {
  it("returns approved only for a valid clean structured review", async () => {
    const result = await executePrReview({
      ...baseInput,
      readHeadSha: () => "abc123",
      runReview: async () => ({
        success: true,
        verdict: "approved",
        summary: "key_issues_to_review: []\nsecurity_concerns: No",
      }),
    });

    assert.equal(result.success, true);
    assert.equal(result.branchLabel, "approved");
    assert.equal(result.result?.reviewedHeadSha, "abc123");
  });

  it("fails closed when PR-Agent output is malformed", async () => {
    const result = await executePrReview({
      ...baseInput,
      readHeadSha: () => "abc123",
      runReview: async () => ({ success: false, error: "malformed" }),
    });

    assert.equal(result.success, false);
    assert.equal(result.errorCode, "pr_review_failed_closed");
  });

  it("rejects an otherwise clean review when the PR head changes mid-review", async () => {
    let readCount = 0;
    const result = await executePrReview({
      ...baseInput,
      readHeadSha: () => (++readCount === 1 ? "old-sha" : "new-sha"),
      runReview: async () => ({
        success: true,
        verdict: "approved",
        summary: "key_issues_to_review: []\nsecurity_concerns: No",
      }),
    });

    assert.equal(result.success, false);
    assert.equal(result.errorCode, "pr_review_head_changed");
  });
});
