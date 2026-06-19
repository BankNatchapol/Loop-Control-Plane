import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  executeAiReview,
  parseVerdictFromText,
} from "@/lib/engine/executors/ai-review-executor";
import { externalUntrustedPrefix } from "@/lib/security/safe-context";
import type { WorkflowArtifact } from "@/lib/loopboard";

describe("ai-review-executor", () => {
  it("maps explicit final-review findings to needs changes", () => {
    assert.equal(
      parseVerdictFromText("VERDICT: NEEDS_CHANGES\nISSUES:\n- broken behavior"),
      "needs changes",
    );
  });

  it("maps an explicit final-review approval to approved", () => {
    assert.equal(
      parseVerdictFromText("VERDICT: APPROVED\nISSUES: None"),
      "approved",
    );
  });

  it("fails closed when final-review output has no explicit verdict", () => {
    assert.equal(parseVerdictFromText("Looks fine to me."), "needs changes");
  });

  it("writes a stub review-notes artifact with branchLabel approved", async () => {
    const inputArtifacts: WorkflowArtifact[] = [
      {
        name: "implementation-branch",
        path: "git://repo/feature-branch",
        required: true,
      },
      {
        name: "test-report",
        path: "loopboard://runs/run-001/test-report",
        required: true,
      },
    ];
    const outputArtifacts: WorkflowArtifact[] = [
      {
        name: "review-notes",
        path: "loopboard://runs/{run}/review-notes",
        required: true,
      },
    ];

    const result = await executeAiReview({
      workflowRunId: "run-001",
      featureId: "feature-a",
      inputArtifacts,
      outputArtifacts,
    });

    assert.equal(result.success, true);
    assert.equal(result.branchLabel, "approved");
    assert.equal(
      result.outputArtifacts?.[0]?.path,
      "loopboard://runs/run-001/review-notes",
    );
    assert.ok(result.outputArtifacts?.[0]?.description?.startsWith(externalUntrustedPrefix));
    assert.equal(result.result?.reviewScope, "integrated-feature");
  });

  it("returns needs changes when the test report artifact indicates failure", async () => {
    const result = await executeAiReview({
      workflowRunId: "run-002",
      inputArtifacts: [
        {
          name: "implementation-branch",
          path: "git://repo/feature-branch",
          required: true,
        },
        {
          name: "test-report",
          path: "loopboard://runs/run-002/test-report",
          required: true,
          description: "Exit code: 1 tests failed",
        },
      ],
      outputArtifacts: [
        {
          name: "review-notes",
          path: "loopboard://runs/{run}/review-notes",
          required: true,
        },
      ],
    });

    assert.equal(result.success, true);
    assert.equal(result.branchLabel, "needs changes");
  });
});
