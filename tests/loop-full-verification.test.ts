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
  extractWorkflowRunPauseReason,
  isWorkflowHardStopNode,
  maybeAutoAdvanceWorkflowRun,
} from "@/lib/engine/auto-advance";
import { createExecutorRegistryForRepository } from "@/lib/engine/executor-registry";
import { LoopScheduler } from "@/lib/engine/loop-scheduler";
import { enqueueTaskLoopJobs, scanTaskLoopCandidates } from "@/lib/engine/task-loop-planner";
import { seedProject, seedTasks, seedWorkflows } from "@/lib/loopboard";
import {
  runNextWorkflowStep,
  startWorkflowRun,
} from "@/lib/workflows/workflow-runner";

const withRepository = (
  test: (repository: LoopBoardRepository) => void | Promise<void>,
) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "loop-full-verification-"));
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

describe("loop full verification", () => {
  it("blocks high-risk ready tasks from automated engine pickup with default settings", () =>
    withRepository((repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      repository.updateProject(seedProject.id, {
        automationPolicy: {
          ...seedProject.automationPolicy,
          allowLowRiskAutoTaskExecution: true,
        },
      });

      const highRiskTask = repository.createTask({
        ...seedTasks[0],
        id: "task-verification-high-risk-ready",
        title: "High risk verification task",
        status: "ready",
        owner: "unassigned",
        risk: "high",
      });

      const scan = scanTaskLoopCandidates(repository, {
        projectId: seedProject.id,
        automated: true,
      });

      assert.equal(
        scan.eligible.some((candidate) => candidate.taskId === highRiskTask.id),
        false,
      );
      assert.equal(
        scan.skipped.some(
          (skip) =>
            skip.taskId === highRiskTask.id &&
            skip.code === "engine_high_risk_task_auto_blocked",
        ),
        true,
      );

      const enqueue = enqueueTaskLoopJobs(repository, {
        projectId: seedProject.id,
        automated: true,
      });

      assert.equal(
        enqueue.enqueued.some((job) => job.taskId === highRiskTask.id),
        false,
      );
    }));

  it("never auto-advances through merge nodes even when auto-advance is enabled", async () =>
    withRepository(async (repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      repository.updateProject(seedProject.id, {
        engineSettings: {
          ...seedProject.engineSettings,
          autoAdvanceEnabled: true,
        },
      });
      repository.updateEngineSchedulerStatus({ status: "running" });

      const workflow = seedWorkflows[0];
      const mergeNode = workflow.nodes.find((node) => node.id === "node-merge");
      assert.ok(mergeNode);
      assert.equal(isWorkflowHardStopNode(mergeNode), true);

      const run = repository.createWorkflowRun({
        workflowId: workflow.id,
        projectId: seedProject.id,
        featureId: "feature-kanban-control-plane",
        status: "running",
        currentNodeId: "node-merge",
        inputArtifacts: [],
        executionLogs: [],
        startedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });

      const paused = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(paused.status, "paused");
      assert.equal(paused.currentNodeId, "node-merge");

      const pauseReason = extractWorkflowRunPauseReason(paused, workflow);
      assert.ok(pauseReason);
      assert.equal(pauseReason.nodeId, "node-merge");
      assert.equal(pauseReason.nodeType, "merge");

      const advance = maybeAutoAdvanceWorkflowRun(repository, run.id, {
        tickMode: "automated",
      });
      assert.notEqual(advance.action, "advanced");

      const scheduler = new LoopScheduler(
        repository,
        createExecutorRegistryForRepository(repository),
      );
      const tick = await scheduler.tick({ mode: "automated" });
      assert.notEqual(tick.autoAdvance?.action, "advanced");

      const unchanged = repository.getWorkflowRun(run.id);
      assert.equal(unchanged.currentNodeId, "node-merge");
      assert.equal(unchanged.status, "paused");
    }));

  it("confirms seeded low-risk task loop path remains covered by integration suite", () =>
    withRepository((repository) => {
      const lowRiskReady = repository.getTask("task-local-persistence-reset");
      assert.equal(lowRiskReady.status, "ready");
      assert.equal(lowRiskReady.risk, "low");

      repository.updateAutomationSettings({ globalAutoRunEnabled: false });
      const scanDefault = scanTaskLoopCandidates(repository, {
        projectId: seedProject.id,
        automated: true,
      });
      assert.equal(scanDefault.eligible.length, 0);

      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      repository.updateProject(seedProject.id, {
        automationPolicy: {
          ...seedProject.automationPolicy,
          allowLowRiskAutoTaskExecution: true,
        },
      });

      const scanEnabled = scanTaskLoopCandidates(repository, {
        projectId: seedProject.id,
        automated: true,
        taskId: lowRiskReady.id,
      });
      assert.equal(scanEnabled.eligible.length, 1);
      assert.equal(scanEnabled.eligible[0]?.taskId, lowRiskReady.id);
    }));
});
