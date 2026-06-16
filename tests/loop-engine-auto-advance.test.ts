import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { applyMigrations } from "@/db/migrate";
import { seedDatabase } from "@/db/seed";
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import {
  createExecutorRegistryForRepository,
  ExecutorRegistry,
  StubExecutor,
} from "@/lib/engine/executor-registry";
import {
  extractWorkflowRunPauseReason,
  isProjectAutoAdvanceEnabled,
  isWorkflowHardStopNode,
  maybeAutoAdvanceWorkflowRun,
} from "@/lib/engine/auto-advance";
import { LoopScheduler } from "@/lib/engine/loop-scheduler";
import { seedProject } from "@/lib/loopboard";
import {
  runNextWorkflowStep,
  startWorkflowRun,
} from "@/lib/workflows/workflow-runner";

const withRepository = (
  test: (repository: LoopBoardRepository) => void | Promise<void>,
) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "loop-engine-auto-advance-"));
  const database = new DatabaseSync(join(tempDirectory, "loopboard.sqlite"));

  return (async () => {
    try {
      applyMigrations(database);
      seedDatabase(database);
      await test(new LoopBoardRepository(database));
    } finally {
      database.close();
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  })();
};

const autoWorkflowNode = (
  id: string,
  type: string,
  mode: "auto" | "human" | "semi" = "auto",
) => ({
  id,
  type,
  name: id,
  mode,
  position: { x: 0, y: 0 },
  inputArtifacts: [],
  outputArtifacts:
    type === "ai-review"
      ? [
          {
            name: "review-notes",
            path: "loopboard://runs/{run}/review-notes",
            required: true,
          },
        ]
      : type === "run-tests"
        ? [
            {
              name: "test-report",
              path: "loopboard://runs/{run}/test-report",
              required: true,
            },
          ]
        : [],
  requireApproval: false,
  maxRetries: 0,
  riskPolicy: "low" as const,
  config: {},
  currentState: "idle" as const,
});

const workflowEdge = (
  workflowId: string,
  sourceNodeId: string,
  targetNodeId: string,
) => ({
  id: `edge-${sourceNodeId}-to-${targetNodeId}`,
  workflowId,
  sourceNodeId,
  targetNodeId,
  label: "next",
  condition: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const startSchedulerForAutoRun = (repository: LoopBoardRepository): void => {
  repository.updateEngineSchedulerStatus({ status: "running" });
};

describe("loop engine auto-advance", () => {
  it("requires both global auto-run and project autoAdvanceEnabled", () => {
    assert.equal(
      isProjectAutoAdvanceEnabled(
        {
          engineSettings: { autoAdvanceEnabled: true },
        },
        { globalAutoRunEnabled: false },
      ),
      false,
    );
    assert.equal(
      isProjectAutoAdvanceEnabled(
        {
          engineSettings: { autoAdvanceEnabled: false },
        },
        { globalAutoRunEnabled: true },
      ),
      false,
    );
    assert.equal(
      isProjectAutoAdvanceEnabled(
        {
          engineSettings: { autoAdvanceEnabled: true },
        },
        { globalAutoRunEnabled: true },
      ),
      true,
    );
  });

  it("treats merge and manual-claude-code-edit nodes as hard stops", () => {
    assert.equal(
      isWorkflowHardStopNode({ type: "merge", mode: "human" }),
      true,
    );
    assert.equal(
      isWorkflowHardStopNode({ type: "manual-claude-code-edit", mode: "human" }),
      true,
    );
    assert.equal(
      isWorkflowHardStopNode({ type: "ai-review", mode: "auto" }),
      false,
    );
  });

  it("chains workflow steps when auto-advance is enabled", async () => {
    await withRepository(async (repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      repository.updateProject(seedProject.id, {
        engineSettings: {
          ...seedProject.engineSettings,
          autoAdvanceEnabled: true,
        },
      });

      const workflow = repository.createWorkflow({
        id: "workflow-auto-chain",
        projectId: seedProject.id,
        name: "Auto Chain",
        description: "Chains ai-review into completion.",
        nodes: [
          autoWorkflowNode("node-ai-review-1", "ai-review"),
          autoWorkflowNode("node-ai-review-2", "ai-review"),
        ],
        edges: [
          workflowEdge("workflow-auto-chain", "node-ai-review-1", "node-ai-review-2"),
        ],
      });

      const run = startWorkflowRun({
        repository,
        input: { workflowId: workflow.id },
      });
      runNextWorkflowStep({ repository, runId: run.id });
      startSchedulerForAutoRun(repository);

      const scheduler = new LoopScheduler(
        repository,
        createExecutorRegistryForRepository(repository),
      );
      const result = await scheduler.tick({ mode: "automated" });

      assert.equal(result.plan.action, "process");
      assert.equal(result.job?.status, "completed");

      const updatedRun = repository.getWorkflowRun(run.id);
      assert.equal(updatedRun.status, "completed");
      assert.equal(updatedRun.steps.length, 2);
      assert.equal(updatedRun.steps.every((step) => step.status === "completed"), true);
      assert.ok((result.chainedTicks ?? 0) >= 0);
    });
  });

  it("pauses on human review nodes instead of auto-advancing", async () => {
    await withRepository(async (repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      repository.updateProject(seedProject.id, {
        engineSettings: {
          ...seedProject.engineSettings,
          autoAdvanceEnabled: true,
        },
      });

      const workflow = repository.createWorkflow({
        id: "workflow-auto-human-stop",
        projectId: seedProject.id,
        name: "Human Stop",
        description: "Stops at human review.",
        nodes: [
          autoWorkflowNode("node-auto-human-spec-kit", "spec-kit-actions"),
          autoWorkflowNode("node-auto-human-review", "human-review", "human"),
        ],
        edges: [
          workflowEdge(
            "workflow-auto-human-stop",
            "node-auto-human-spec-kit",
            "node-auto-human-review",
          ),
        ],
      });

      const run = startWorkflowRun({
        repository,
        input: { workflowId: workflow.id },
      });
      runNextWorkflowStep({ repository, runId: run.id });
      startSchedulerForAutoRun(repository);

      const scheduler = new LoopScheduler(
        repository,
        new ExecutorRegistry([
          new StubExecutor({
            workflowStepHandler: async () => ({
              success: true,
              result: { outputArtifacts: [] },
              logs: [],
            }),
          }),
        ]),
      );
      await scheduler.tick({ mode: "automated" });

      const updatedRun = repository.getWorkflowRun(run.id);
      assert.equal(updatedRun.status, "running");
      assert.equal(updatedRun.currentNodeId, "node-auto-human-review");

      const pauseReason = extractWorkflowRunPauseReason(updatedRun, workflow);
      assert.ok(pauseReason);
      assert.equal(pauseReason.kind, "hard-stop");
    });
  });

  it("does not auto-advance when project autoAdvanceEnabled is false", async () => {
    await withRepository(async (repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      repository.updateProject(seedProject.id, {
        engineSettings: {
          ...seedProject.engineSettings,
          autoAdvanceEnabled: false,
        },
      });

      const workflow = repository.createWorkflow({
        id: "workflow-no-auto-advance",
        projectId: seedProject.id,
        name: "No Auto Advance",
        description: "Single delegated step.",
        nodes: [autoWorkflowNode("node-ai-review-only", "ai-review")],
        edges: [],
      });

      const run = startWorkflowRun({
        repository,
        input: { workflowId: workflow.id },
      });
      runNextWorkflowStep({ repository, runId: run.id });

      const scheduler = new LoopScheduler(
        repository,
        createExecutorRegistryForRepository(repository),
      );
      const result = await scheduler.tick({ mode: "manual" });

      assert.equal(result.job?.status, "completed");
      assert.notEqual(result.autoAdvance?.action, "advanced");

      const updatedRun = repository.getWorkflowRun(run.id);
      assert.equal(updatedRun.status, "completed");
      assert.equal(updatedRun.steps.length, 1);
      assert.equal(updatedRun.steps[0]?.status, "completed");
    });
  });

  it("stops auto-advance on policy deny for high-risk nodes", async () => {
    await withRepository(async (repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      repository.updateProject(seedProject.id, {
        engineSettings: {
          ...seedProject.engineSettings,
          autoAdvanceEnabled: true,
        },
      });

      const workflow = repository.createWorkflow({
        id: "workflow-high-risk-stop",
        projectId: seedProject.id,
        name: "High Risk Stop",
        description: "Denies high-risk automation.",
        nodes: [
          {
            ...autoWorkflowNode("node-auto-high-low", "ai-review"),
            riskPolicy: "low",
          },
          {
            ...autoWorkflowNode("node-auto-high-risk", "ai-review"),
            riskPolicy: "high",
          },
        ],
        edges: [
          workflowEdge("workflow-high-risk-stop", "node-auto-high-low", "node-auto-high-risk"),
        ],
      });

      const run = startWorkflowRun({
        repository,
        input: { workflowId: workflow.id },
      });
      runNextWorkflowStep({ repository, runId: run.id });
      startSchedulerForAutoRun(repository);

      const scheduler = new LoopScheduler(
        repository,
        createExecutorRegistryForRepository(repository),
      );
      await scheduler.tick({ mode: "automated" });

      const afterFirst = repository.getWorkflowRun(run.id);
      assert.equal(afterFirst.currentNodeId, "node-auto-high-risk");

      const advance = maybeAutoAdvanceWorkflowRun(repository, run.id, {
        tickMode: "automated",
      });

      assert.equal(advance.action, "stopped");
      assert.equal(advance.pauseReason?.kind, "deny");

      const pausedRun = repository.getWorkflowRun(run.id);
      assert.equal(pausedRun.status, "paused");
    });
  });
});
