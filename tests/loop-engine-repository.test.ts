import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { applyMigrations } from "@/db/migrate";
import { seedDatabase } from "@/db/seed";
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { seedProject, seedFeatures } from "@/lib/loopboard";

const withRepository = (test: (repository: LoopBoardRepository) => void) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "loop-engine-repository-"));
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

describe("Loop engine repository persistence", () => {
  it("initializes scheduler state as stopped without auto-starting", () => {
    withRepository((repository) => {
      const scheduler = repository.getEngineSchedulerStatus();

      assert.equal(scheduler.status, "stopped");
      assert.equal(scheduler.tickCount, 0);
      assert.equal(scheduler.lastTickAt, undefined);
      assert.equal(scheduler.lastError, undefined);
    });
  });

  it("seeds a completed historical demo job for dashboard display", () => {
    withRepository((repository) => {
      const jobs = repository.listEngineJobs({ projectId: seedProject.id });

      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]?.id, "engine-job-seed-demo-ping");
      assert.equal(jobs[0]?.kind, "demo-ping");
      assert.equal(jobs[0]?.status, "completed");
      assert.equal(jobs[0]?.backend, "stub");
      assert.equal(jobs[0]?.executionLogs.length, 1);
    });
  });

  it("creates, lists, updates, and fetches queued engine jobs", () => {
    withRepository((repository) => {
      const first = repository.createEngineJob({
        id: "engine-job-queued-1",
        kind: "demo-ping",
        backend: "stub",
        projectId: seedProject.id,
        payload: { ping: true },
        queuedAt: "2026-06-16T10:00:00.000Z",
        createdAt: "2026-06-16T10:00:00.000Z",
      });
      repository.createEngineJob({
        id: "engine-job-queued-2",
        kind: "demo-ping",
        backend: "stub",
        projectId: seedProject.id,
        payload: { ping: true },
        queuedAt: "2026-06-16T11:00:00.000Z",
        createdAt: "2026-06-16T11:00:00.000Z",
      });

      assert.equal(first.status, "queued");
      assert.equal(repository.fetchNextQueuedJob()?.id, "engine-job-queued-1");

      const queued = repository.listEngineJobs({
        projectId: seedProject.id,
        status: "queued",
      });
      assert.equal(queued.length, 2);

      const running = repository.updateEngineJob("engine-job-queued-1", {
        status: "running",
        startedAt: "2026-06-16T10:00:01.000Z",
      });
      assert.equal(running.status, "running");
      assert.equal(repository.fetchNextQueuedJob()?.id, "engine-job-queued-2");
    });
  });

  it("filters engine jobs by workflow run and backend", () => {
    withRepository((repository) => {
      repository.createWorkflowRun({
        id: "workflow-run-filter-test",
        workflowId: "workflow-feature-development-loop",
        featureId: seedFeatures[0].id,
        status: "running",
        currentNodeId: "node-run-tests",
      });

      repository.createEngineJob({
        id: "engine-job-workflow-filter",
        kind: "workflow-step",
        backend: "cursor",
        projectId: seedProject.id,
        workflowRunId: "workflow-run-filter-test",
        workflowNodeId: "node-run-tests",
        payload: {},
      });

      const filtered = repository.listEngineJobs({
        projectId: seedProject.id,
        workflowRunId: "workflow-run-filter-test",
        backend: "cursor",
      });

      assert.equal(filtered.length, 1);
      assert.equal(filtered[0]?.id, "engine-job-workflow-filter");
    });
  });

  it("appends engine log entries and updates scheduler state", () => {
    withRepository((repository) => {
      const job = repository.createEngineJob({
        id: "engine-job-log-test",
        kind: "demo-ping",
        backend: "stub",
        projectId: seedProject.id,
      });

      const updated = repository.appendEngineLogEntry(job.id, {
        timestamp: "2026-06-16T12:00:00.000Z",
        level: "info",
        message: "Queued for stub execution.",
      });

      assert.equal(updated.executionLogs.length, 1);
      assert.match(updated.executionLogs[0]?.message ?? "", /Queued for stub execution/);

      const scheduler = repository.updateEngineSchedulerStatus({
        status: "running",
        lastTickAt: "2026-06-16T12:00:01.000Z",
        tickCount: 1,
      });

      assert.equal(scheduler.status, "running");
      assert.equal(scheduler.tickCount, 1);
      assert.equal(scheduler.lastTickAt, "2026-06-16T12:00:01.000Z");
    });
  });
});
