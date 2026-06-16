import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { executeRunTests } from "@/lib/engine/executors/run-tests-executor";
import type { ProcessRunResult } from "@/lib/engine/process-runner";
import { externalUntrustedPrefix } from "@/lib/security/safe-context";
import type { WorkflowArtifact } from "@/lib/loopboard";

const createMockProcessRunner = (outcome: Partial<ProcessRunResult> = {}) => ({
  run: async () =>
    ({
      success: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      stdoutSummary: "ok",
      stderrSummary: "",
      timedOut: false,
      durationMs: 1,
      commandSummary: "npm test",
      profile: "npm-test",
      command: "npm",
      args: ["test"],
      ...outcome,
    }) satisfies ProcessRunResult,
});

describe("run-tests-executor", () => {
  it("runs npm test and writes an untrusted test-report artifact summary", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-run-tests-exec-"));

    try {
      const outputArtifacts: WorkflowArtifact[] = [
        {
          name: "test-report",
          path: "loopboard://runs/{run}/test-report",
          required: true,
        },
      ];

      const result = await executeRunTests({
        projectRepoPath: repoPath,
        workflowRunId: "run-tests-001",
        featureId: "feature-a",
        inputArtifacts: [
          {
            name: "implementation-branch",
            path: "git://repo/feature-a",
            required: true,
          },
        ],
        outputArtifacts,
        processRunner: createMockProcessRunner(),
      });

      assert.equal(result.success, true);
      assert.equal(
        result.outputArtifacts?.[0]?.path,
        "loopboard://runs/run-tests-001/test-report",
      );
      assert.ok(result.outputArtifacts?.[0]?.description?.startsWith(externalUntrustedPrefix));
      assert.equal(result.result?.passed, true);
      assert.match(String(result.result?.testReportSummary), /npm test/u);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("returns structured failure when tests fail", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-run-tests-fail-"));

    try {
      const result = await executeRunTests({
        projectRepoPath: repoPath,
        workflowRunId: "run-tests-002",
        inputArtifacts: [],
        outputArtifacts: [
          {
            name: "test-report",
            path: "loopboard://runs/{run}/test-report",
            required: true,
          },
        ],
        processRunner: createMockProcessRunner({
          success: false,
          exitCode: 1,
          stderr: "tests failed",
          stderrSummary: "tests failed",
        }),
      });

      assert.equal(result.success, false);
      assert.equal(result.errorCode, "run_tests_failed");
      assert.equal(result.result?.passed, false);
      assert.ok(result.outputArtifacts?.[0]?.description?.startsWith(externalUntrustedPrefix));
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
