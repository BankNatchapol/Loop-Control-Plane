import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { executeSpecKitActions } from "@/lib/engine/executors/spec-kit-actions-executor";
import type { ProcessRunResult } from "@/lib/engine/process-runner";
import type { WorkflowArtifact } from "@/lib/loopboard";

const createMockProcessRunner = (
  onRun?: (args: string[]) => void,
  outcome: Partial<ProcessRunResult> = {},
) => ({
  run: async (request: { args?: string[] }) => {
    const args = request.args ?? [];
    onRun?.(args);
    return {
      success: true,
      exitCode: 0,
      stdout: "generated",
      stderr: "",
      stdoutSummary: "generated",
      stderrSummary: "",
      timedOut: false,
      durationMs: 1,
      commandSummary: args.join(" "),
      profile: "spec-kit" as const,
      command: "spec-kit",
      args,
      ...outcome,
    } satisfies ProcessRunResult;
  },
});

describe("spec-kit-actions-executor", () => {
  it("resolves feature brief input and verifies generated outputs", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-spec-kit-exec-"));
    const featureFolder = join(repoPath, "specs", "feature-a");
    mkdirSync(featureFolder, { recursive: true });
    writeFileSync(join(featureFolder, "PRD.md"), "# Brief\n", "utf8");

    const inputArtifacts: WorkflowArtifact[] = [
      {
        name: "feature-brief",
        path: "specs/feature-a/PRD.md",
        required: true,
      },
    ];
    const outputArtifacts: WorkflowArtifact[] = [
      { name: "spec", path: "specs/feature-a/spec.md", required: true },
      { name: "plan", path: "specs/feature-a/plan.md", required: true },
      { name: "tasks", path: "specs/feature-a/tasks.md", required: true },
    ];

    const spawned: string[][] = [];
    const runner = createMockProcessRunner((args) => {
      spawned.push(args);
      const outputPath = args.at(-1);
      if (typeof outputPath === "string") {
        writeFileSync(join(repoPath, outputPath), `# ${args[0]}\n`, "utf8");
      }
    });

    try {
      const result = await executeSpecKitActions({
        projectRepoPath: repoPath,
        inputArtifacts,
        outputArtifacts,
        processRunner: runner,
      });

      assert.equal(result.success, true);
      assert.equal(spawned.length, 3);
      assert.deepEqual(
        spawned.map((entry) => entry[0]),
        ["spec", "plan", "tasks"],
      );
      assert.equal(spawned[0]?.[1], "specs/feature-a/PRD.md");
      assert.equal(spawned[1]?.[1], "specs/feature-a/spec.md");
      assert.equal(spawned[2]?.[1], "specs/feature-a/plan.md");
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("fails with structured error when required outputs are missing", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-spec-kit-missing-"));
    const featureFolder = join(repoPath, "specs", "feature-a");
    mkdirSync(featureFolder, { recursive: true });
    writeFileSync(join(featureFolder, "PRD.md"), "# Brief\n", "utf8");

    const runner = createMockProcessRunner();

    try {
      const result = await executeSpecKitActions({
        projectRepoPath: repoPath,
        inputArtifacts: [
          {
            name: "feature-brief",
            path: "specs/feature-a/PRD.md",
            required: true,
          },
        ],
        outputArtifacts: [
          { name: "spec", path: "specs/feature-a/spec.md", required: true },
          { name: "plan", path: "specs/feature-a/plan.md", required: true },
          { name: "tasks", path: "specs/feature-a/tasks.md", required: true },
        ],
        actions: ["spec"],
        processRunner: runner,
      });

      assert.equal(result.success, false);
      assert.equal(result.errorCode, "spec_kit_output_missing");
      assert.match(result.error ?? "", /spec\.md/u);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("reports process failures for retry handling", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-spec-kit-fail-"));
    mkdirSync(join(repoPath, "specs", "feature-a"), { recursive: true });
    writeFileSync(join(repoPath, "specs/feature-a/PRD.md"), "# Brief\n", "utf8");

    const runner = createMockProcessRunner(undefined, {
      success: false,
      exitCode: 1,
      stderr: "spec generation failed",
      stderrSummary: "spec generation failed",
    });

    try {
      const result = await executeSpecKitActions({
        projectRepoPath: repoPath,
        inputArtifacts: [
          {
            name: "feature-brief",
            path: "specs/feature-a/PRD.md",
            required: true,
          },
        ],
        outputArtifacts: [
          { name: "spec", path: "specs/feature-a/spec.md", required: true },
        ],
        actions: ["spec"],
        processRunner: runner,
      });

      assert.equal(result.success, false);
      assert.equal(result.errorCode, "spec_kit_process_failed");
      assert.match(result.error ?? "", /exited with code 1/u);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
