import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { applyMigrations } from "@/db/migrate";
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { executeOpenPr } from "@/lib/engine/executors/open-pr-executor";
import type { ProcessRunResult } from "@/lib/engine/process-runner";
import { externalUntrustedPrefix } from "@/lib/security/safe-context";
import type { WorkflowArtifact } from "@/lib/loopboard";

const withOpenPrFixture = async (
  test: (input: {
    repository: LoopBoardRepository;
    featureId: string;
    taskId: string;
  }) => Promise<void> | void,
) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "loopboard-open-pr-exec-"));
  const repoPath = join(tempDirectory, "repo");
  const database = new DatabaseSync(join(tempDirectory, "loopboard.sqlite"));

  try {
    mkdirSync(repoPath, { recursive: true });
    applyMigrations(database);
    const repository = new LoopBoardRepository(database);
    const project = repository.createProject({
      id: "project-pr",
      name: "PR Project",
      repoPath,
      githubRepository: "bank-p/loop-control-plane",
      createdAt: "2026-06-14T08:00:00.000Z",
    });
    const feature = repository.createFeature({
      id: "feature-pr",
      projectId: project.id,
      name: "PR Feature",
      source: "manual",
      status: "in-execution",
      createdAt: "2026-06-14T08:10:00.000Z",
    });
    const task = repository.createTask({
      id: "task-pr",
      projectId: project.id,
      featureId: feature.id,
      title: "Implement PR flow",
      description: "Open a pull request.",
      source: "manual",
      status: "ready",
      owner: "ai",
      mode: "execute",
      risk: "low",
      branch: "feature/pr-flow",
      createdAt: "2026-06-14T08:20:00.000Z",
    });

    await test({
      repository,
      featureId: feature.id,
      taskId: task.id,
    });
  } finally {
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
};

const processResult = (
  stdout: string,
  args: string[],
): ProcessRunResult => ({
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

describe("open-pr-executor", () => {
  it("reuses only the open pull request whose head matches the integrated branch", async () => {
    await withOpenPrFixture(async ({ repository, featureId, taskId }) => {
      const inputArtifacts: WorkflowArtifact[] = [
        {
          name: "implementation-branch",
          path: "git://bank-p/loop-control-plane/feature/pr-flow",
          required: true,
        },
      ];
      const outputArtifacts: WorkflowArtifact[] = [
        {
          name: "pull-request",
          path: "https://github.com/{repository}/pulls",
          required: true,
        },
      ];

      const result = await executeOpenPr({
        repository,
        featureId,
        workflowRunId: "run-001",
        inputArtifacts,
        outputArtifacts,
        projectRepoPath: repository.getProject("project-pr").repoPath,
        processRunner: {
          run: async ({ args = [] }) =>
            processResult(
              JSON.stringify([
                {
                  number: 7,
                  url: "https://github.com/bank-p/loop-control-plane/pull/7",
                  headRefName: "feature/pr-flow",
                },
              ]),
              args,
            ),
        },
      });

      assert.equal(result.success, true);
      assert.equal(
        result.outputArtifacts?.[0]?.path,
        "https://github.com/bank-p/loop-control-plane/pull/7",
      );
      assert.ok(result.outputArtifacts?.[0]?.description?.startsWith(externalUntrustedPrefix));

      const task = repository.getTask(taskId);
      assert.equal(task.github.pullRequestNumber, 7);
    });
  });

  it("creates the final PR when branch-matched discovery is empty", async () => {
    await withOpenPrFixture(async ({ repository, featureId, taskId }) => {
      const result = await executeOpenPr({
        repository,
        featureId,
        inputArtifacts: [
          {
            name: "implementation-branch",
            path: "git://bank-p/loop-control-plane/feature/pr-flow",
            required: true,
          },
        ],
        outputArtifacts: [
          {
            name: "pull-request",
            path: "https://github.com/{repository}/pulls",
            required: true,
          },
        ],
        projectRepoPath: repository.getProject("project-pr").repoPath,
        processRunner: {
          run: async ({ args = [] }) =>
            args[1] === "list"
              ? processResult("[]", args)
              : processResult(
                  "https://github.com/bank-p/loop-control-plane/pull/99\n",
                  args,
                ),
        },
      });

      assert.equal(result.success, true);
      assert.equal(result.result?.pullRequestNumber, 99);
      assert.equal(repository.getTask(taskId).github.pullRequestNumber, 99);
    });
  });
});
