import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { executeMerge } from "@/lib/engine/executors/merge-executor";
import type { ProcessRunResult } from "@/lib/engine/process-runner";

const result = (stdout: string, args: string[]): ProcessRunResult => ({
  success: true,
  exitCode: 0,
  stdout,
  stderr: "",
  stdoutSummary: stdout,
  stderrSummary: "",
  timedOut: false,
  durationMs: 1,
  commandSummary: `gh ${args.join(" ")}`,
  profile: "gh",
  command: "gh",
  args,
});

describe("merge-executor", () => {
  it("squash merges the exact PR and verifies merged state", async () => {
    const calls: string[][] = [];
    const prUrl = "https://github.com/bank-p/loop-control-plane/pull/51";
    const merged = await executeMerge({
      workflowRunId: "run-merge",
      projectRepoPath: process.cwd(),
      repository: "bank-p/loop-control-plane",
      defaultBranch: "main",
      inputArtifacts: [{ name: "pull-request", path: prUrl, required: true }],
      outputArtifacts: [
        {
          name: "merged-branch",
          path: "git://{repository}/{defaultBranch}",
          required: true,
        },
      ],
      processRunner: {
        run: async ({ args = [] }) => {
          calls.push(args);
          return result(
            args[1] === "view"
              ? JSON.stringify({
                  state: calls.length === 1 ? "OPEN" : "MERGED",
                  mergedAt:
                    calls.length === 1 ? null : "2026-06-18T00:00:00Z",
                  url: prUrl,
                  baseRefName: "main",
                })
              : "",
            args,
          );
        },
      },
    });

    assert.equal(merged.success, true);
    assert.deepEqual(calls[1], ["pr", "merge", prUrl, "--squash", "--delete-branch"]);
    assert.equal(
      merged.outputArtifacts?.[0]?.path,
      "git://bank-p/loop-control-plane/main",
    );
  });
});
