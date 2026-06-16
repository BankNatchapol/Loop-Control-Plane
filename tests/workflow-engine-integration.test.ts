import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { applyMigrations } from "@/db/migrate";
import { TaskContextService } from "@/lib/context/task-context-service";
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import {
  ExecutorRegistry,
  StubExecutor,
  type ExecutorContext,
  type ExecutorResult,
} from "@/lib/engine/executor-registry";
import { executeCreateGitHubIssues } from "@/lib/engine/executors/create-github-issues-executor";
import { dispatchWorkflowStepJob } from "@/lib/engine/executors/workflow-step-dispatcher";
import { parseWorkflowStepJobPayload } from "@/lib/engine/executors/workflow-step-types";
import { LoopScheduler } from "@/lib/engine/loop-scheduler";
import { discoverFeatureArtifacts } from "@/lib/features/feature-artifacts";
import { externalUntrustedPrefix } from "@/lib/security/safe-context";
import {
  runNextWorkflowStep,
  startWorkflowRun,
} from "@/lib/workflows/workflow-runner";

const toExecutorResult = (
  stepResult: Awaited<ReturnType<typeof executeCreateGitHubIssues>>,
): ExecutorResult => ({
  success: stepResult.success,
  error: stepResult.error,
  result: {
    ...stepResult.result,
    errorCode: stepResult.errorCode,
    branchLabel: stepResult.branchLabel,
    outputArtifacts: stepResult.outputArtifacts,
  },
  logs: stepResult.logs,
});

const createIntegrationExecutorRegistry = (
  repository: LoopBoardRepository,
): ExecutorRegistry =>
  new ExecutorRegistry([
    new StubExecutor({
      workflowStepHandler: async (context: ExecutorContext) => {
        const payload = parseWorkflowStepJobPayload(context.job.payload);
        if (payload?.nodeType === "create-github-issues") {
          const featureId =
            payload.featureId ??
            (typeof context.job.payload.featureId === "string"
              ? context.job.payload.featureId
              : undefined);

          if (!featureId) {
            return {
              success: false,
              error: "Missing featureId for create-github-issues workflow step.",
              logs: [],
            };
          }

          const stepResult = await executeCreateGitHubIssues({
            repository,
            featureId,
            workflowRunId: payload.workflowRunId,
            outputArtifacts: payload.outputArtifacts,
            token: "integration-test-token",
            automationSettings: {
              ...repository.getAutomationSettings(),
              globalAutoRunEnabled: true,
            },
            createIssue: async ({ title }) => ({
              status: "created",
              repository: "bank-p/loop-control-plane",
              message: `Created GitHub issue for ${title}.`,
              issueNumber: 101,
              issueUrl: "https://github.com/bank-p/loop-control-plane/issues/101",
              labels: ["loopboard", "risk-low"],
              createdAt: "2026-06-16T12:00:00.000Z",
            }),
          });

          return toExecutorResult(stepResult);
        }

        return dispatchWorkflowStepJob(context, {
          repository,
        });
      },
    }),
  ]);

const withIntegrationFixture = async (
  test: (input: {
    repository: LoopBoardRepository;
    featureId: string;
    projectId: string;
    contextRoot: string;
  }) => Promise<void> | void,
) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "loopboard-workflow-engine-"));
  const repoPath = join(tempDirectory, "repo");
  const contextRoot = join(tempDirectory, "contexts");
  const featureFolder = join(repoPath, "specs", "feature-integration");
  const database = new DatabaseSync(join(tempDirectory, "loopboard.sqlite"));

  try {
    mkdirSync(featureFolder, { recursive: true });
    writeFileSync(join(featureFolder, "PRD.md"), "# Integration PRD\n", "utf8");
    writeFileSync(join(featureFolder, "spec.md"), "# Integration Spec\n", "utf8");
    writeFileSync(join(featureFolder, "plan.md"), "# Integration Plan\n", "utf8");
    writeFileSync(
      join(featureFolder, "tasks.md"),
      [
        "# Tasks",
        "",
        "- [ ] T001 Wire import tasks executor in `lib/engine/executors/import-tasks-executor.ts`",
        "- [ ] T002 Wire GitHub issue bridge in `lib/github/github-issues.ts`",
      ].join("\n"),
      "utf8",
    );

    applyMigrations(database);
    const repository = new LoopBoardRepository(database);
    const project = repository.createProject({
      id: "project-integration",
      name: "Integration Project",
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
    const discovered = discoverFeatureArtifacts({
      project,
      artifactFolderPath: "specs/feature-integration",
      status: "tasks-ready",
    });
    const feature = repository.createFeature({
      id: "feature-integration",
      projectId: project.id,
      name: "Workflow Engine Integration",
      source: "spec-kit",
      status: "tasks-ready",
      ...discovered,
      createdAt: "2026-06-14T08:10:00.000Z",
    });

    repository.updateAutomationSettings({ globalAutoRunEnabled: true });

    await test({
      repository,
      featureId: feature.id,
      projectId: project.id,
      contextRoot,
    });
  } finally {
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
};

describe("workflow engine integration", () => {
  it("runs import-tasks then create-github-issues through engine jobs", async () => {
    await withIntegrationFixture(async ({ repository, featureId, projectId, contextRoot }) => {
      new TaskContextService(contextRoot);

      const workflow = repository.createWorkflow({
        id: "workflow-import-to-github",
        projectId,
        name: "Import To GitHub",
        description: "Trimmed graph for engine integration coverage.",
        nodes: [
          {
            id: "node-import-tasks",
            type: "import-tasks",
            name: "Import Tasks",
            mode: "auto",
            position: { x: 0, y: 0 },
            inputArtifacts: [
              {
                name: "tasks",
                path: "specs/{feature}/tasks.md",
                required: true,
              },
            ],
            outputArtifacts: [
              {
                name: "loopboard-tasks",
                path: "loopboard://feature/{feature}/tasks",
                required: true,
              },
            ],
            requireApproval: false,
            maxRetries: 1,
            riskPolicy: "low",
            config: {},
            currentState: "idle",
          },
          {
            id: "node-create-github-issues",
            type: "create-github-issues",
            name: "Create GitHub Issues",
            mode: "auto",
            position: { x: 260, y: 0 },
            inputArtifacts: [
              {
                name: "loopboard-tasks",
                path: "loopboard://feature/{feature}/tasks",
                required: true,
              },
            ],
            outputArtifacts: [
              {
                name: "github-issues",
                path: "https://github.com/{repository}/issues",
                required: true,
              },
            ],
            requireApproval: false,
            maxRetries: 1,
            riskPolicy: "low",
            config: {},
            currentState: "idle",
          },
        ],
        edges: [
          {
            id: "edge-import-github",
            sourceNodeId: "node-import-tasks",
            targetNodeId: "node-create-github-issues",
            label: "next",
            condition: {},
          },
        ],
      });

      const run = startWorkflowRun({
        repository,
        input: { workflowId: workflow.id, featureId },
      });
      assert.equal(run.currentNodeId, "node-import-tasks");

      const delegatedImport = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(delegatedImport.steps[0]?.status, "running");
      assert.equal(
        repository
          .listEngineJobs()
          .filter((job) => job.workflowRunId === run.id).length,
        1,
      );

      const scheduler = new LoopScheduler(
        repository,
        createIntegrationExecutorRegistry(repository),
      );
      const importTick = await scheduler.tick({ mode: "manual" });

      assert.equal(importTick.job?.status, "completed");
      assert.equal(importTick.job?.payload.nodeType, "import-tasks");

      const afterImport = repository.getWorkflowRun(run.id);
      assert.equal(afterImport.steps[0]?.status, "completed");
      assert.equal(afterImport.currentNodeId, "node-create-github-issues");

      const tasks = repository
        .listBoardData(projectId)
        .tasks.filter((task) => task.featureId === featureId);
      assert.equal(tasks.length, 2);
      assert.equal(
        afterImport.steps[0]?.outputArtifacts[0]?.path,
        "loopboard://feature/feature-integration/tasks",
      );

      const delegatedGitHub = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(delegatedGitHub.steps.at(-1)?.status, "running");
      assert.equal(
        repository
          .listEngineJobs({ status: "queued" })
          .filter((job) => job.workflowRunId === run.id).length,
        1,
      );

      const githubTick = await scheduler.tick({ mode: "manual" });

      assert.equal(githubTick.job?.status, "completed");
      assert.equal(githubTick.job?.payload.nodeType, "create-github-issues");

      const completedRun = repository.getWorkflowRun(run.id);
      assert.equal(completedRun.status, "completed");
      assert.equal(completedRun.steps.at(-1)?.status, "completed");
      assert.ok(
        completedRun.steps.at(-1)?.outputArtifacts[0]?.description?.startsWith(
          externalUntrustedPrefix,
        ),
      );

      const linkedTasks = repository
        .listBoardData(projectId)
        .tasks.filter((task) => task.featureId === featureId);
      assert.ok(linkedTasks.every((task) => task.github.issueNumber === 101));

      const featureEvents = repository.getFeature(featureId).events;
      assert.ok(
        featureEvents.some((event) => event.type === "WORKFLOW_STEP_COMPLETED"),
      );
    });
  });
});
