import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { applyMigrations } from "@/db/migrate";
import { seedDatabase } from "@/db/seed";
import {
  buildEngineQueueCounts,
  enqueueDemoPingJob,
  getEngineStatus,
  startEngineScheduler,
  stopEngineScheduler,
  summarizeEngineJob,
  tickEngine,
} from "@/lib/api/engine-actions";
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { LoopSchedulerError } from "@/lib/engine/loop-scheduler";
import { seedProject } from "@/lib/loopboard";

const withRepository = (
  test: (repository: LoopBoardRepository) => void | Promise<void>,
) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "loop-engine-api-"));
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

describe("Loop engine API actions", () => {
  it("returns scheduler state, queue counts, and redacted job summaries", () => {
    withRepository((repository) => {
      const status = getEngineStatus(repository, { projectId: seedProject.id });

      assert.equal(status.scheduler.status, "stopped");
      assert.equal(status.automationPolicy.kind, "deny");
      assert.equal(status.recentJobs.length, 1);
      assert.equal(status.recentJobs[0]?.id, "engine-job-seed-demo-ping");
      assert.equal(status.queueCounts.completed, 1);
      assert.equal(status.queueCounts.queued, 0);
    });
  });

  it("builds queue counts across all job statuses", () => {
    const counts = buildEngineQueueCounts([
      {
        id: "a",
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
      },
      {
        id: "b",
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
      },
    ]);

    assert.equal(counts.queued, 2);
    assert.equal(counts.running, 0);
  });

  it("redacts secrets in job summaries", () => {
    const summary = summarizeEngineJob({
      id: "job-secret",
      kind: "demo-ping",
      status: "failed",
      backend: "stub",
      workflowRunId: "workflow-run-1",
      workflowNodeId: "node-import-tasks",
      payload: {},
      executionLogs: [
        {
          timestamp: "2026-06-16T12:00:00.000Z",
          level: "error",
          message: "token=super-secret-value failed",
        },
      ],
      error: "password=abc123",
      attempt: 1,
      maxAttempts: 3,
      queuedAt: "2026-06-16T12:00:00.000Z",
      createdAt: "2026-06-16T12:00:00.000Z",
      updatedAt: "2026-06-16T12:00:00.000Z",
    });

    assert.match(summary.error ?? "", /\[redacted\]/);
    assert.match(summary.lastLogMessage ?? "", /\[redacted\]/);
    assert.equal(summary.workflowRunId, "workflow-run-1");
    assert.equal(summary.workflowNodeId, "node-import-tasks");
  });

  it("denies scheduler start when global auto-run is disabled", () => {
    withRepository((repository) => {
      assert.throws(
        () => startEngineScheduler(repository),
        (error: unknown) => {
          assert.ok(error instanceof LoopSchedulerError);
          assert.equal(error.code, "global_auto_run_disabled");
          return true;
        },
      );
    });
  });

  it("allows manual tick and demo job enqueue without global auto-run", async () => {
    await withRepository(async (repository) => {
      const demo = enqueueDemoPingJob(repository, seedProject.id);
      assert.equal(demo.job.status, "queued");
      assert.equal(demo.job.kind, "demo-ping");

      const tick = await tickEngine(repository, "manual");
      assert.equal(tick.plan.action, "process");
      assert.equal(tick.job?.status, "completed");
    });
  });

  it("starts and stops the scheduler when global auto-run is enabled", () => {
    withRepository((repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });

      const started = startEngineScheduler(repository);
      assert.equal(started.scheduler.status, "running");

      const stopped = stopEngineScheduler(repository);
      assert.equal(stopped.scheduler.status, "stopped");
    });
  });
});
