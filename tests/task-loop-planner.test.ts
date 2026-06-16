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
  buildTaskRunJobPayload,
  validateTaskRunJobPayload,
} from "@/lib/engine/loop-engine-types";
import {
  enqueueTaskLoopJobs,
  isTaskStructurallyEligible,
  scanTaskLoopCandidates,
} from "@/lib/engine/task-loop-planner";
import { seedProject } from "@/lib/loopboard";

const withRepository = (test: (repository: LoopBoardRepository) => void) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "task-loop-planner-"));
  const database = new DatabaseSync(join(tempDirectory, "loopboard.sqlite"));

  try {
    applyMigrations(database);
    seedDatabase(database);
    test(new LoopBoardRepository(database));
  } finally {
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
};

describe("task-run payload validation", () => {
  it("validates and builds task-run job payloads", () => {
    const payload = buildTaskRunJobPayload({
      taskId: "task-1",
      projectId: "project-1",
      action: "execute",
      executorConfig: { backend: "stub" },
      contextPaths: ["lib/loopboard.ts"],
      trigger: "scheduler",
    });

    const validation = validateTaskRunJobPayload(payload);
    assert.equal(validation.ok, true);
    if (validation.ok) {
      assert.equal(validation.payload.taskId, "task-1");
      assert.equal(validation.payload.trigger, "scheduler");
      assert.deepEqual(validation.payload.contextPaths, ["lib/loopboard.ts"]);
    }
  });
});

describe("task loop planner", () => {
  it("marks ready unassigned tasks as structurally eligible", () => {
    withRepository((repository) => {
      const task = repository.getTask("task-local-persistence-reset");
      assert.equal(isTaskStructurallyEligible(task), true);
    });
  });

  it("rejects blocked, human-working, and human-owned tasks", () => {
    withRepository((repository) => {
      assert.equal(
        isTaskStructurallyEligible(repository.getTask("task-blocked-automation-policy")),
        false,
      );
      assert.equal(
        isTaskStructurallyEligible(repository.getTask("task-human-takeover-actions")),
        false,
      );
      assert.equal(
        isTaskStructurallyEligible(repository.getTask("task-ai-board-dragging")),
        false,
      );
    });
  });

  it("dry-run scan reports policy denials when global auto-run is disabled", () => {
    withRepository((repository) => {
      const scan = scanTaskLoopCandidates(repository, {
        projectId: seedProject.id,
        automated: true,
        dryRun: true,
      });

      const persistenceTask = scan.skipped.find(
        (entry) => entry.taskId === "task-local-persistence-reset",
      );
      assert.ok(persistenceTask);
      assert.equal(persistenceTask.code, "engine_global_auto_run_required");
      assert.equal(scan.eligible.length, 0);
    });
  });

  it("allows manual pickup when global auto-run is disabled", () => {
    withRepository((repository) => {
      const scan = scanTaskLoopCandidates(repository, {
        projectId: seedProject.id,
        taskId: "task-local-persistence-reset",
        automated: false,
      });

      assert.equal(scan.eligible.length, 1);
      assert.equal(scan.eligible[0]?.taskId, "task-local-persistence-reset");
      assert.equal(scan.skipped.length, 0);
    });
  });

  it("dedupes queued task-run jobs per task id", () => {
    withRepository((repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });

      const first = enqueueTaskLoopJobs(repository, {
        projectId: seedProject.id,
        taskId: "task-local-persistence-reset",
        trigger: "manual",
        automated: false,
      });

      assert.equal(first.enqueued.length, 1);
      assert.equal(first.deduped.length, 0);

      const second = enqueueTaskLoopJobs(repository, {
        projectId: seedProject.id,
        taskId: "task-local-persistence-reset",
        trigger: "manual",
        automated: false,
      });

      assert.equal(second.enqueued.length, 0);
      assert.equal(second.deduped.length, 1);
      assert.equal(second.deduped[0]?.id, first.enqueued[0]?.id);
    });
  });

  it("records policy skip events for automated denials", () => {
    withRepository((repository) => {
      enqueueTaskLoopJobs(repository, {
        projectId: seedProject.id,
        taskId: "task-local-persistence-reset",
        trigger: "scheduler",
        automated: true,
        recordSkips: true,
      });

      const task = repository.getTask("task-local-persistence-reset");
      const skipEvent = task.events.find((event) => event.type === "ENGINE_PICKUP_SKIPPED");
      assert.ok(skipEvent);
      assert.equal(skipEvent.metadata?.policyCode, "engine_global_auto_run_required");
    });
  });

  it("blocks automated pickup when project disallows low-risk auto task execution", () => {
    withRepository((repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });

      const scan = scanTaskLoopCandidates(repository, {
        projectId: seedProject.id,
        taskId: "task-local-persistence-reset",
        automated: true,
      });

      assert.equal(scan.eligible.length, 0);
      assert.equal(scan.skipped[0]?.code, "engine_project_blocks_auto_task_execution");
    });
  });

  it("allows automated pickup when project enables low-risk auto task execution", () => {
    withRepository((repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      repository.updateProject(seedProject.id, {
        automationPolicy: {
          ...seedProject.automationPolicy,
          allowLowRiskAutoTaskExecution: true,
        },
      });

      const scan = scanTaskLoopCandidates(repository, {
        projectId: seedProject.id,
        taskId: "task-local-persistence-reset",
        automated: true,
      });

      assert.equal(scan.eligible.length, 1);
      assert.equal(scan.skipped.length, 0);
    });
  });

  it("blocks high-risk automated pickup even when low-risk auto execution is enabled", () => {
    withRepository((repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      repository.updateProject(seedProject.id, {
        automationPolicy: {
          ...seedProject.automationPolicy,
          allowLowRiskAutoTaskExecution: true,
        },
      });
      repository.updateTask("task-local-persistence-reset", { risk: "high" });

      const scan = scanTaskLoopCandidates(repository, {
        projectId: seedProject.id,
        taskId: "task-local-persistence-reset",
        automated: true,
      });

      assert.equal(scan.eligible.length, 0);
      assert.equal(scan.skipped[0]?.code, "engine_high_risk_task_auto_blocked");
    });
  });

  it("requires ao-ready approval for medium-risk automated pickup", () => {
    withRepository((repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      repository.updateProject(seedProject.id, {
        automationPolicy: {
          ...seedProject.automationPolicy,
          allowLowRiskAutoTaskExecution: true,
        },
      });
      repository.updateTask("task-local-persistence-reset", {
        risk: "medium",
        github: {
          issueNumber: 36,
          issueUrl: "https://github.com/bank-p/loop-control-plane/issues/36",
          issueState: "open",
          ciStatus: "not-started",
          reviewStatus: "not-requested",
        },
      });

      const blocked = scanTaskLoopCandidates(repository, {
        projectId: seedProject.id,
        taskId: "task-local-persistence-reset",
        automated: true,
      });

      assert.equal(blocked.eligible.length, 0);
      assert.equal(blocked.skipped[0]?.code, "medium_risk_review_gate");

      repository.updateTask("task-local-persistence-reset", {
        github: {
          issueNumber: 36,
          issueUrl: "https://github.com/bank-p/loop-control-plane/issues/36",
          issueState: "open",
          ciStatus: "not-started",
          reviewStatus: "not-requested",
          aoReadyApprovedAt: "2026-06-14T00:00:00.000Z",
        },
      });

      const approved = scanTaskLoopCandidates(repository, {
        projectId: seedProject.id,
        taskId: "task-local-persistence-reset",
        automated: true,
      });

      assert.equal(approved.eligible.length, 1);
      assert.equal(approved.skipped.length, 0);
    });
  });

  it("dry-run enqueue does not persist jobs while scan reports eligible tasks", () => {
    withRepository((repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      repository.updateProject(seedProject.id, {
        automationPolicy: {
          ...seedProject.automationPolicy,
          allowLowRiskAutoTaskExecution: true,
        },
      });

      const scan = scanTaskLoopCandidates(repository, {
        projectId: seedProject.id,
        taskId: "task-local-persistence-reset",
        automated: true,
      });
      assert.equal(scan.eligible.length, 1);
      assert.equal(scan.eligible[0]?.taskId, "task-local-persistence-reset");

      const result = enqueueTaskLoopJobs(repository, {
        projectId: seedProject.id,
        taskId: "task-local-persistence-reset",
        trigger: "scheduler",
        automated: true,
        dryRun: true,
      });

      assert.equal(result.enqueued.length, 0);
      assert.equal(result.skipped.length, 0);
      assert.equal(repository.hasActiveTaskRunJob("task-local-persistence-reset"), false);
      assert.equal(repository.countActiveTaskRunJobs(), 0);
    });
  });

  it("repository active task-run lookup finds queued jobs only", () => {
    withRepository((repository) => {
      assert.equal(repository.hasActiveTaskRunJob("task-local-persistence-reset"), false);

      const job = repository.createEngineJob({
        id: "engine-job-task-run-active",
        kind: "task-run",
        backend: "stub",
        projectId: seedProject.id,
        taskId: "task-local-persistence-reset",
        payload: buildTaskRunJobPayload({
          taskId: "task-local-persistence-reset",
          projectId: seedProject.id,
          action: "execute",
          executorConfig: { backend: "stub" },
          trigger: "manual",
        }),
      });

      assert.equal(repository.hasActiveTaskRunJob("task-local-persistence-reset"), true);
      assert.equal(
        repository.getActiveTaskRunJobForTask("task-local-persistence-reset")?.id,
        job.id,
      );

      repository.updateEngineJob(job.id, { status: "completed", completedAt: new Date().toISOString() });
      assert.equal(repository.hasActiveTaskRunJob("task-local-persistence-reset"), false);
    });
  });
});
