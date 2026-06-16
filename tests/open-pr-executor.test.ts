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

describe("open-pr-executor", () => {
  it("syncs an existing pull request and marks the output artifact untrusted", async () => {
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
        token: "token",
        useGhCreateFallback: false,
        syncPullRequest: async () => ({
          status: "synced",
          repository: "bank-p/loop-control-plane",
          message: "Synced GitHub pull request #7.",
          syncedAt: "2026-06-16T00:00:00.000Z",
          github: {
            issueNumber: undefined,
            issueUrl: undefined,
            pullRequestNumber: 7,
            pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/7",
            pullRequestBranch: "feature/pr-flow",
            pullRequestState: "open",
          },
          linkedIssueNumbers: [],
        }),
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

  it("falls back to gh pr create when discovery does not find a pull request", async () => {
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
        token: "token",
        useGhCreateFallback: true,
        syncPullRequest: async () => ({
          status: "not-found",
          repository: "bank-p/loop-control-plane",
          message: "No linked GitHub pull request was found for this task.",
          syncedAt: "2026-06-16T00:00:00.000Z",
          linkedIssueNumbers: [],
        }),
        processRunner: {
          run: async () =>
            ({
              success: true,
              exitCode: 0,
              stdout:
                "https://github.com/bank-p/loop-control-plane/pull/99\n",
              stderr: "",
              stdoutSummary: "https://github.com/bank-p/loop-control-plane/pull/99",
              stderrSummary: "",
              timedOut: false,
              durationMs: 1,
              commandSummary: "gh pr create",
              profile: "gh",
              command: "gh",
              args: ["pr", "create"],
            }) satisfies ProcessRunResult,
        },
      });

      assert.equal(result.success, true);
      assert.equal(result.result?.pullRequestNumber, 99);
      assert.equal(repository.getTask(taskId).github.pullRequestNumber, 99);
    });
  });
});
