import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { applyMigrations } from "@/db/migrate";
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { executeCreateGitHubIssues } from "@/lib/engine/executors/create-github-issues-executor";
import { defaultAutomationSettings } from "@/lib/policies/automation-policy";
import { externalUntrustedPrefix } from "@/lib/security/safe-context";
import type { WorkflowArtifact } from "@/lib/loopboard";

const withGitHubIssueFixture = async (
  test: (input: {
    repository: LoopBoardRepository;
    featureId: string;
    projectId: string;
  }) => Promise<void> | void,
) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "loopboard-github-exec-"));
  const repoPath = join(tempDirectory, "repo");
  const database = new DatabaseSync(join(tempDirectory, "loopboard.sqlite"));

  try {
    mkdirSync(repoPath, { recursive: true });
    applyMigrations(database);
    const repository = new LoopBoardRepository(database);
    const project = repository.createProject({
      id: "project-checkout",
      name: "Checkout",
      repoPath,
      specKitRoot: "specs",
      githubRepository: "bank-p/loop-control-plane",
      automationPolicy: {
        allowLowRiskAutoIssueCreation: true,
        allowLowRiskAutoAoReadyLabeling: false,
        mediumRiskRequiresReview: true,
        highRiskManualOnly: true,
      },
      createdAt: "2026-06-14T08:00:00.000Z",
    });
    const feature = repository.createFeature({
      id: "feature-checkout",
      projectId: project.id,
      name: "Checkout Flow",
      source: "manual",
      status: "tasks-ready",
      createdAt: "2026-06-14T08:10:00.000Z",
    });

    repository.createTask({
      id: "task-checkout-ui",
      projectId: project.id,
      featureId: feature.id,
      title: "Polish sidebar spacing",
      description: "Adjust padding on the settings sidebar panel.",
      status: "ready",
      owner: "ai",
      mode: "execute",
      risk: "low",
      source: "manual",
      createdAt: "2026-06-14T08:20:00.000Z",
    });

    await test({
      repository,
      featureId: feature.id,
      projectId: project.id,
    });
  } finally {
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
};

describe("create-github-issues-executor", () => {
  it("creates GitHub issues for low-risk tasks and marks output artifacts untrusted", async () => {
    await withGitHubIssueFixture(async ({ repository, featureId }) => {
      const outputArtifacts: WorkflowArtifact[] = [
        {
          name: "github-issues",
          path: "https://github.com/{repository}/issues",
          required: true,
        },
      ];

      const result = await executeCreateGitHubIssues({
        repository,
        featureId,
        workflowRunId: "run-001",
        outputArtifacts,
        token: "token",
        automationSettings: {
          ...defaultAutomationSettings,
          globalAutoRunEnabled: true,
        },
        createIssue: async ({ title }) => ({
          status: "created",
          repository: "bank-p/loop-control-plane",
          message: `Created GitHub issue for ${title}.`,
          issueNumber: 42,
          issueUrl: "https://github.com/bank-p/loop-control-plane/issues/42",
          labels: ["loopboard", "risk-low"],
          createdAt: "2026-06-16T00:00:00.000Z",
        }),
      });

      assert.equal(result.success, true);
      assert.equal(result.result?.createdCount, 1);
      assert.ok(result.outputArtifacts?.[0]?.description?.startsWith(externalUntrustedPrefix));
      assert.equal(
        result.outputArtifacts?.[0]?.path,
        "https://github.com/bank-p/loop-control-plane/issues",
      );

      const tasks = repository
        .listBoardData("project-checkout")
        .tasks.filter((task) => task.featureId === featureId);
      assert.equal(tasks[0]?.github.issueNumber, 42);
    });
  });

  it("skips existing GitHub issues on retry without creating duplicates", async () => {
    await withGitHubIssueFixture(async ({ repository, featureId }) => {
      const outputArtifacts: WorkflowArtifact[] = [
        {
          name: "github-issues",
          path: "https://github.com/{repository}/issues",
          required: true,
        },
      ];
      const createIssue = async ({ title }: { title: string }) => ({
        status: "created" as const,
        repository: "bank-p/loop-control-plane",
        message: `Created GitHub issue for ${title}.`,
        issueNumber: 42,
        issueUrl: "https://github.com/bank-p/loop-control-plane/issues/42",
        labels: ["loopboard", "risk-low"],
        createdAt: "2026-06-16T00:00:00.000Z",
      });

      const first = await executeCreateGitHubIssues({
        repository,
        featureId,
        workflowRunId: "run-001",
        outputArtifacts,
        token: "token",
        automationSettings: {
          ...defaultAutomationSettings,
          globalAutoRunEnabled: true,
        },
        createIssue,
      });
      const retry = await executeCreateGitHubIssues({
        repository,
        featureId,
        workflowRunId: "run-001",
        outputArtifacts,
        token: "token",
        automationSettings: {
          ...defaultAutomationSettings,
          globalAutoRunEnabled: true,
        },
        createIssue: async () => {
          throw new Error("createIssue should not run when issues already exist.");
        },
      });

      assert.equal(first.success, true);
      assert.equal(first.result?.createdCount, 1);
      assert.equal(retry.success, true);
      assert.equal(retry.result?.createdCount, 0);
      assert.equal(retry.result?.skippedExistingCount, 1);
    });
  });

  it("fails when automation policy blocks low-risk auto issue creation", async () => {
    await withGitHubIssueFixture(async ({ repository, featureId, projectId }) => {
      const project = repository.getProject(projectId);
      repository.updateProject(project.id, {
        automationPolicy: {
          ...project.automationPolicy,
          allowLowRiskAutoIssueCreation: false,
        },
      });

      const result = await executeCreateGitHubIssues({
        repository,
        featureId,
        outputArtifacts: [
          {
            name: "github-issues",
            path: "https://github.com/{repository}/issues",
            required: true,
          },
        ],
        token: "token",
        automationSettings: {
          ...defaultAutomationSettings,
          globalAutoRunEnabled: true,
        },
        createIssue: async () => ({
          status: "created",
          repository: "bank-p/loop-control-plane",
          message: "Created",
          issueNumber: 42,
          issueUrl: "https://github.com/bank-p/loop-control-plane/issues/42",
          labels: ["loopboard"],
          createdAt: "2026-06-16T00:00:00.000Z",
        }),
      });

      assert.equal(result.success, false);
      assert.equal(result.errorCode, "create_github_issues_policy_blocked");
    });
  });
});
