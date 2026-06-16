import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import { GET as getEngineJobDetail } from "@/app/api/engine/jobs/[jobId]/route";
import { GET as listEngineJobs } from "@/app/api/engine/jobs/route";
import { GET as getEngineStatus } from "@/app/api/engine/status/route";
import { applyMigrations } from "@/db/migrate";
import { seedDatabase } from "@/db/seed";
import {
  getEngineJobDetail as getEngineJobDetailAction,
  getEngineStatus as getEngineStatusAction,
  listEngineJobsForApi,
} from "@/lib/api/engine-actions";
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { seedFeatures, seedProject } from "@/lib/loopboard";

type ApiPayload<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

const readApiJson = async <T>(response: Response): Promise<ApiPayload<T>> =>
  (await response.json()) as ApiPayload<T>;

const withObservabilityDatabase = (
  test: (repository: LoopBoardRepository) => void | Promise<void>,
) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "loop-engine-observability-"));
  const databasePath = join(tempDirectory, "loopboard.sqlite");
  const originalDatabasePath = process.env.LOOPBOARD_DATABASE_PATH;
  const database = new DatabaseSync(databasePath);

  return (async () => {
    try {
      process.env.LOOPBOARD_DATABASE_PATH = databasePath;
      applyMigrations(database);
      seedDatabase(database);
      await test(new LoopBoardRepository(database));
    } finally {
      if (originalDatabasePath === undefined) {
        delete process.env.LOOPBOARD_DATABASE_PATH;
      } else {
        process.env.LOOPBOARD_DATABASE_PATH = originalDatabasePath;
      }
      database.close();
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  })();
};

afterEach(() => {
  delete process.env.LOOPBOARD_DATABASE_PATH;
});

describe("loop engine observability", () => {
  it("filters engine jobs by task, workflow run, node, status, and backend", () =>
    withObservabilityDatabase((repository) => {
      repository.createWorkflowRun({
        id: "workflow-run-observability",
        workflowId: "workflow-feature-development-loop",
        featureId: seedFeatures[0].id,
        status: "running",
        currentNodeId: "node-import-tasks",
      });

      repository.createEngineJob({
        id: "engine-job-obs-task",
        kind: "task-run",
        backend: "stub",
        projectId: seedProject.id,
        taskId: "task-local-persistence-reset",
        status: "queued",
        payload: { taskId: "task-local-persistence-reset" },
      });
      repository.createEngineJob({
        id: "engine-job-obs-workflow",
        kind: "workflow-step",
        backend: "cursor",
        projectId: seedProject.id,
        workflowRunId: "workflow-run-observability",
        workflowNodeId: "node-import-tasks",
        status: "running",
        payload: { nodeType: "import-tasks" },
        startedAt: new Date().toISOString(),
      });

      const byTask = repository.listEngineJobs({
        projectId: seedProject.id,
        taskId: "task-local-persistence-reset",
      });
      assert.equal(byTask.length, 1);
      assert.equal(byTask[0]?.id, "engine-job-obs-task");

      const byWorkflow = repository.listEngineJobs({
        projectId: seedProject.id,
        workflowRunId: "workflow-run-observability",
        workflowNodeId: "node-import-tasks",
        backend: "cursor",
        status: "running",
      });
      assert.equal(byWorkflow.length, 1);
      assert.equal(byWorkflow[0]?.id, "engine-job-obs-workflow");

      const listed = listEngineJobsForApi(repository, {
        projectId: seedProject.id,
        status: "queued",
        backend: "stub",
      });
      assert.equal(listed.jobs.length, 1);
      assert.equal(listed.jobs[0]?.id, "engine-job-obs-task");
    }));

  it("serves filtered job lists from GET /api/engine/jobs", async () => {
    await withObservabilityDatabase(async (repository) => {
      repository.createEngineJob({
        id: "engine-job-api-filter",
        kind: "demo-ping",
        backend: "stub",
        projectId: seedProject.id,
        status: "failed",
        payload: {},
        error: "Demo failure for observability test.",
        queuedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });

      const response = await listEngineJobs(
        new Request(
          `http://localhost/api/engine/jobs?projectId=${encodeURIComponent(seedProject.id)}&status=failed&backend=stub&kind=demo-ping&limit=10`,
        ),
      );
      const payload = await readApiJson<{
        jobs: Array<{ id: string; status: string; backend: string; kind: string }>;
      }>(response);

      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      if (payload.ok) {
        assert.equal(payload.data.jobs.length, 1);
        assert.equal(payload.data.jobs[0]?.id, "engine-job-api-filter");
        assert.equal(payload.data.jobs[0]?.status, "failed");
      }
    });
  });

  it("returns redacted job detail without secrets in payload, logs, or errors", async () => {
    await withObservabilityDatabase(async (repository) => {
      const job = repository.createEngineJob({
        id: "engine-job-obs-redacted",
        kind: "task-run",
        backend: "stub",
        projectId: seedProject.id,
        taskId: "task-local-persistence-reset",
        status: "failed",
        payload: {
          token: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
          env: "GITHUB_TOKEN=super-secret",
        },
        executionLogs: [
          {
            timestamp: "2026-06-16T12:00:00.000Z",
            level: "error",
            message: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload failed",
            metadata: { policyCode: "task_run_denied", policyKind: "deny" },
          },
        ],
        error: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456",
        result: {
          stdoutSummary: "password=abc123",
          stderrSummary: "AO_SECRET=hidden",
          externalSessionId: "session-obs-001",
        },
        queuedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });

      const detail = getEngineJobDetailAction(repository, job.id);
      const serialized = JSON.stringify(detail);

      assert.match(serialized, /\[redacted\]/);
      assert.doesNotMatch(serialized, /ghp_abcdefghijklmnopqrstuvwxyz1234567890/);
      assert.doesNotMatch(serialized, /sk-abcdefghijklmnopqrstuvwxyz123456/);
      assert.equal(detail.policyDecisions[0]?.code, "task_run_denied");
      assert.deepEqual(detail.externalSessionIds, ["session-obs-001"]);

      const response = await getEngineJobDetail(
        new Request(`http://localhost/api/engine/jobs/${job.id}`),
        { params: Promise.resolve({ jobId: job.id }) },
      );
      const payload = await readApiJson<typeof detail>(response);

      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      if (payload.ok) {
        assert.match(JSON.stringify(payload.data), /\[redacted\]/);
        assert.equal(payload.data.executionLogs.length, 1);
      }
    });
  });

  it("computes dashboard metrics from sqlite for engine status responses", async () => {
    await withObservabilityDatabase(async (repository) => {
      const now = Date.now();
      repository.createEngineJob({
        id: "engine-job-obs-metrics-completed",
        kind: "demo-ping",
        backend: "stub",
        projectId: seedProject.id,
        status: "completed",
        payload: {},
        queuedAt: new Date(now - 60_000).toISOString(),
        startedAt: new Date(now - 30_000).toISOString(),
        completedAt: new Date(now - 10_000).toISOString(),
      });
      repository.createEngineJob({
        id: "engine-job-obs-metrics-failed",
        kind: "demo-ping",
        backend: "stub",
        projectId: seedProject.id,
        status: "failed",
        payload: {},
        error: "Metrics failure sample.",
        queuedAt: new Date(now - 45_000).toISOString(),
        startedAt: new Date(now - 20_000).toISOString(),
        completedAt: new Date(now - 5_000).toISOString(),
      });
      repository.createEngineJob({
        id: "engine-job-obs-metrics-queued",
        kind: "demo-ping",
        backend: "stub",
        projectId: seedProject.id,
        status: "queued",
        payload: {},
        queuedAt: new Date(now - 5_000).toISOString(),
      });

      const metrics = repository.getEngineJobMetrics(seedProject.id);
      assert.equal(metrics.windowHours, 24);
      assert.ok(metrics.completed >= 2);
      assert.ok(metrics.failed >= 1);
      assert.ok(metrics.queued >= 1);
      assert.ok(metrics.averageDurationMs !== null);
      assert.ok(metrics.failureRate !== null);
      assert.ok(metrics.failureRate! > 0 && metrics.failureRate! < 1);

      const status = getEngineStatusAction(repository, { projectId: seedProject.id });
      assert.ok(status.metrics);
      assert.equal(status.metrics?.windowHours, 24);
      assert.ok(status.activeJobCount >= 0);
      assert.ok(status.recentJobs.length >= 1);

      const response = await getEngineStatus(
        new Request(
          `http://localhost/api/engine/status?projectId=${encodeURIComponent(seedProject.id)}`,
        ),
      );
      const payload = await readApiJson<{
        metrics: { completed: number; failed: number; queued: number };
        activeJobCount: number;
      }>(response);

      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      if (payload.ok) {
        assert.ok(payload.data.metrics.completed >= 2);
        assert.ok(payload.data.metrics.failed >= 1);
        assert.ok(payload.data.metrics.queued >= 1);
        assert.equal(typeof payload.data.activeJobCount, "number");
      }
    });
  });
});
