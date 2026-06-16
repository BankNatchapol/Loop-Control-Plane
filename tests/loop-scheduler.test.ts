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
  LoopScheduler,
  LoopSchedulerError,
  applySchedulerTransition,
  DEFAULT_TASK_LOOP_CONCURRENCY_LIMIT,
  planNextTick,
  planTaskLoopPickup,
  processEngineJob,
  redactEngineLogEntry,
} from "@/lib/engine/loop-scheduler";
import type { EngineJob, EngineSchedulerStatus } from "@/lib/engine/loop-engine-types";
import {
  defaultAutomationSettings,
  evaluateGlobalAutomationPolicy,
} from "@/lib/policies/automation-policy";
import { seedProject } from "@/lib/loopboard";
import {
  runNextWorkflowStep,
  startWorkflowRun,
} from "@/lib/workflows/workflow-runner";

const sampleJob = (
  overrides: Partial<EngineJob> = {},
): EngineJob => ({
  id: "job-demo-1",
  kind: "demo-ping",
  status: "queued",
  backend: "stub",
  payload: {},
  executionLogs: [],
  attempt: 1,
  maxAttempts: 3,
  queuedAt: "2026-06-16T12:00:00.000Z",
  createdAt: "2026-06-16T12:00:00.000Z",
  updatedAt: "2026-06-16T12:00:00.000Z",
  ...overrides,
});

const schedulerStatus = (
  overrides: Partial<EngineSchedulerStatus> = {},
): EngineSchedulerStatus => ({
  status: "stopped",
  tickCount: 0,
  updatedAt: "2026-06-16T12:00:00.000Z",
  ...overrides,
});

const withRepository = (
  test: (repository: LoopBoardRepository) => void | Promise<void>,
) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "loop-scheduler-"));
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

describe("Loop scheduler pure helpers", () => {
  it("applies start, stop, and pause transitions safely", () => {
    assert.deepEqual(applySchedulerTransition("stopped", "start"), {
      ok: true,
      status: "running",
    });
    assert.deepEqual(applySchedulerTransition("paused", "start"), {
      ok: true,
      status: "running",
    });
    assert.deepEqual(applySchedulerTransition("running", "pause"), {
      ok: true,
      status: "paused",
    });
    assert.deepEqual(applySchedulerTransition("running", "stop"), {
      ok: true,
      status: "stopped",
    });

    const invalidPause = applySchedulerTransition("stopped", "pause");
    assert.equal(invalidPause.ok, false);
    if (!invalidPause.ok) {
      assert.equal(invalidPause.code, "scheduler_not_running");
    }
  });

  it("plans automated ticks around scheduler state and policy", () => {
    const policyDeny = evaluateGlobalAutomationPolicy(defaultAutomationSettings);

    assert.deepEqual(
      planNextTick({
        schedulerStatus: schedulerStatus({ status: "stopped" }),
        policyDecision: policyDeny,
        nextJob: sampleJob(),
        tickMode: "automated",
      }),
      {
        action: "skip",
        code: "scheduler_stopped",
        reason: "Scheduler is stopped; automatic ticks are skipped.",
      },
    );

    assert.deepEqual(
      planNextTick({
        schedulerStatus: schedulerStatus({ status: "running" }),
        policyDecision: policyDeny,
        nextJob: sampleJob(),
        tickMode: "automated",
      }).action,
      "skip",
    );

    assert.deepEqual(
      planNextTick({
        schedulerStatus: schedulerStatus({ status: "running" }),
        policyDecision: evaluateGlobalAutomationPolicy({
          globalAutoRunEnabled: true,
        }),
        tickMode: "automated",
      }),
      {
        action: "idle",
        reason: "No queued engine jobs are waiting for execution.",
      },
    );
  });

  it("plans task loop pickup around scheduler state, policy, and concurrency", () => {
    const policyAllow = evaluateGlobalAutomationPolicy({
      globalAutoRunEnabled: true,
    });

    assert.deepEqual(
      planTaskLoopPickup({
        tickMode: "automated",
        schedulerStatus: schedulerStatus({ status: "running" }),
        policyDecision: policyAllow,
        activeTaskRunJobs: 0,
      }),
      { shouldEnqueue: true, enqueueLimit: DEFAULT_TASK_LOOP_CONCURRENCY_LIMIT },
    );

    assert.deepEqual(
      planTaskLoopPickup({
        tickMode: "automated",
        schedulerStatus: schedulerStatus({ status: "running" }),
        policyDecision: policyAllow,
        activeTaskRunJobs: 1,
      }),
      { shouldEnqueue: false, enqueueLimit: 0 },
    );

    assert.deepEqual(
      planTaskLoopPickup({
        tickMode: "manual",
        schedulerStatus: schedulerStatus({ status: "running" }),
        policyDecision: policyAllow,
        activeTaskRunJobs: 0,
      }),
      { shouldEnqueue: false, enqueueLimit: 0 },
    );
  });

  it("allows manual ticks even when global auto-run is disabled", () => {
    const plan = planNextTick({
      schedulerStatus: schedulerStatus({ status: "stopped" }),
      policyDecision: evaluateGlobalAutomationPolicy(defaultAutomationSettings),
      nextJob: sampleJob({ id: "manual-job" }),
      tickMode: "manual",
    });

    assert.deepEqual(plan, {
      action: "process",
      jobId: "manual-job",
    });
  });

  it("processes successful and retryable failed jobs", () => {
    const success = processEngineJob({
      job: sampleJob(),
      executorResult: {
        success: true,
        result: { completedDeterministically: true },
        logs: [],
      },
      startedAt: "2026-06-16T12:00:01.000Z",
      now: "2026-06-16T12:00:02.000Z",
    });

    assert.equal(success.status, "completed");
    assert.equal(success.attempt, 1);
    assert.equal(success.completedAt, "2026-06-16T12:00:02.000Z");

    const retry = processEngineJob({
      job: sampleJob({ attempt: 1, maxAttempts: 3 }),
      executorResult: {
        success: false,
        error: "token=super-secret failed",
        logs: [],
      },
      startedAt: "2026-06-16T12:00:01.000Z",
      now: "2026-06-16T12:00:02.000Z",
    });

    assert.equal(retry.status, "queued");
    assert.equal(retry.attempt, 2);
    assert.match(retry.error ?? "", /\[redacted\]/);
    assert.doesNotMatch(retry.error ?? "", /super-secret/);

    const exhausted = processEngineJob({
      job: sampleJob({ attempt: 3, maxAttempts: 3 }),
      executorResult: {
        success: false,
        error: "final failure",
        logs: [],
      },
      startedAt: "2026-06-16T12:00:01.000Z",
      now: "2026-06-16T12:00:02.000Z",
    });

    assert.equal(exhausted.status, "failed");
    assert.equal(exhausted.attempt, 4);
  });

  it("redacts sensitive values in engine log entries", () => {
    const entry = redactEngineLogEntry({
      timestamp: "2026-06-16T12:00:00.000Z",
      level: "error",
      message: "API_KEY=abc123 failed",
      metadata: {
        stderr: "bearer deadbeef-token",
      },
    });

    assert.match(entry.message, /\[redacted\]/);
    assert.match(String(entry.metadata?.stderr), /\[redacted\]/);
  });
});

describe("Loop scheduler service", () => {
  it("denies start when global auto-run is disabled", () => {
    withRepository((repository) => {
      const scheduler = new LoopScheduler(repository);

      assert.throws(
        () => scheduler.start(defaultAutomationSettings),
        (error: unknown) => {
          assert.ok(error instanceof LoopSchedulerError);
          assert.equal(error.code, "engine_global_auto_run_required");
          return true;
        },
      );
    });
  });

  it("dequeues the oldest queued job after enqueue on manual tick", async () => {
    await withRepository(async (repository) => {
      repository.createEngineJob({
        id: "engine-job-first",
        kind: "demo-ping",
        backend: "stub",
        projectId: seedProject.id,
        queuedAt: "2026-06-16T10:00:00.000Z",
        createdAt: "2026-06-16T10:00:00.000Z",
      });
      repository.createEngineJob({
        id: "engine-job-second",
        kind: "demo-ping",
        backend: "stub",
        projectId: seedProject.id,
        queuedAt: "2026-06-16T11:00:00.000Z",
        createdAt: "2026-06-16T11:00:00.000Z",
      });

      assert.equal(repository.fetchNextQueuedJob()?.id, "engine-job-first");

      const scheduler = new LoopScheduler(repository);
      const firstTick = await scheduler.tick({ mode: "manual" });

      assert.equal(firstTick.plan.action, "process");
      assert.equal(firstTick.job?.id, "engine-job-first");
      assert.equal(firstTick.job?.status, "completed");
      assert.equal(repository.fetchNextQueuedJob()?.id, "engine-job-second");
    });
  });

  it("executes a queued stub job on manual tick and completes it", async () => {
    await withRepository(async (repository) => {
      repository.createEngineJob({
        id: "engine-job-manual-tick",
        kind: "demo-ping",
        backend: "stub",
        projectId: seedProject.id,
      });

      const scheduler = new LoopScheduler(repository);
      const result = await scheduler.tick({ mode: "manual" });

      assert.equal(result.plan.action, "process");
      assert.equal(result.job?.status, "completed");
      assert.ok((result.job?.executionLogs.length ?? 0) >= 2);
      assert.equal(result.schedulerStatus.tickCount, 1);
    });
  });

  it("retries failed jobs until max attempts are exhausted", async () => {
    await withRepository(async (repository) => {
      class FailingStubExecutor extends StubExecutor {
        override async execute() {
          return {
            success: false,
            error: "stub failure",
            logs: [],
          };
        }
      }

      repository.createEngineJob({
        id: "engine-job-retry",
        kind: "demo-ping",
        backend: "stub",
        projectId: seedProject.id,
        maxAttempts: 2,
      });

      const scheduler = new LoopScheduler(
        repository,
        new ExecutorRegistry([new FailingStubExecutor()]),
      );

      const first = await scheduler.tick({ mode: "manual" });
      assert.equal(first.job?.status, "queued");
      assert.equal(first.job?.attempt, 2);

      const second = await scheduler.tick({ mode: "manual" });
      assert.equal(second.job?.status, "failed");
      assert.equal(second.job?.attempt, 3);
    });
  });

  it("advances workflow runs after workflow-step jobs complete", async () => {
    await withRepository(async (repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      const workflow = repository.createWorkflow({
        id: "workflow-engine-step",
        projectId: seedProject.id,
        name: "Engine Step Integration",
        description: "Completes ai-review via scheduler tick.",
        nodes: [
          {
            id: "node-ai-review-engine",
            type: "ai-review",
            name: "AI Review",
            mode: "auto",
            position: { x: 0, y: 0 },
            inputArtifacts: [],
            outputArtifacts: [
              {
                name: "review-notes",
                path: "loopboard://runs/{run}/review-notes",
                required: true,
              },
            ],
            requireApproval: false,
            maxRetries: 0,
            riskPolicy: "low",
            config: {},
            currentState: "idle",
          },
        ],
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

      assert.equal(result.plan.action, "process");
      assert.equal(result.job?.status, "completed");
      assert.equal(result.job?.kind, "workflow-step");

      const updatedRun = repository.getWorkflowRun(run.id);
      assert.equal(updatedRun.status, "completed");
      assert.equal(updatedRun.steps[0]?.status, "completed");
      assert.match(
        updatedRun.steps[0]?.outputArtifacts[0]?.path ?? "",
        /review-notes/u,
      );
    });
  });

  it("enqueues eligible ready tasks on automated tick when auto-run and project policy allow", async () => {
    await withRepository(async (repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      repository.updateProject(seedProject.id, {
        automationPolicy: {
          ...seedProject.automationPolicy,
          allowLowRiskAutoTaskExecution: true,
        },
      });
      repository.updateEngineSchedulerStatus({ status: "running" });

      const scheduler = new LoopScheduler(
        repository,
        createExecutorRegistryForRepository(repository),
      );
      const result = await scheduler.tick({ mode: "automated" });

      assert.equal(result.taskLoopPickup?.enqueued, 1);
      assert.equal(result.plan.action, "process");
      assert.equal(result.job?.kind, "task-run");
      assert.equal(result.job?.taskId, "task-local-persistence-reset");
    });
  });

  it("does not enqueue task loop jobs on manual tick", async () => {
    await withRepository(async (repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      repository.updateProject(seedProject.id, {
        automationPolicy: {
          ...seedProject.automationPolicy,
          allowLowRiskAutoTaskExecution: true,
        },
      });
      repository.updateEngineSchedulerStatus({ status: "running" });

      const scheduler = new LoopScheduler(repository);
      const result = await scheduler.tick({ mode: "manual" });

      assert.equal(result.taskLoopPickup, undefined);
      assert.equal(repository.countActiveTaskRunJobs(), 0);
    });
  });
});
