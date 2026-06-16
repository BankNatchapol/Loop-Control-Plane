import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import { POST as postDemoJob } from "@/app/api/engine/demo-job/route";
import { GET as getEngineStatus } from "@/app/api/engine/status/route";
import { POST as postStartScheduler } from "@/app/api/engine/start/route";
import { POST as postStopScheduler } from "@/app/api/engine/stop/route";
import { POST as postTickEngine } from "@/app/api/engine/tick/route";
import { applyMigrations } from "@/db/migrate";
import { seedDatabase } from "@/db/seed";
import { seedProject } from "@/lib/loopboard";

type ApiPayload<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

const readApiJson = async <T>(response: Response): Promise<ApiPayload<T>> =>
  (await response.json()) as ApiPayload<T>;

const withEngineApiDatabase = (
  test: () => void | Promise<void>,
) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "loop-engine-api-route-"));
  const databasePath = join(tempDirectory, "loopboard.sqlite");
  const originalDatabasePath = process.env.LOOPBOARD_DATABASE_PATH;

  return (async () => {
    try {
      process.env.LOOPBOARD_DATABASE_PATH = databasePath;
      const database = new DatabaseSync(databasePath);
      applyMigrations(database);
      seedDatabase(database);
      database.close();
      await test();
    } finally {
      if (originalDatabasePath === undefined) {
        delete process.env.LOOPBOARD_DATABASE_PATH;
      } else {
        process.env.LOOPBOARD_DATABASE_PATH = originalDatabasePath;
      }
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  })();
};

const enableGlobalAutoRun = (databasePath: string) => {
  const database = new DatabaseSync(databasePath);
  database
    .prepare(
      `
        UPDATE app_settings
        SET value = ?, updated_at = ?
        WHERE key = 'automation'
      `,
    )
    .run(JSON.stringify({ globalAutoRunEnabled: true }), new Date().toISOString());
  database.close();
};

const setSchedulerRunning = (databasePath: string) => {
  const database = new DatabaseSync(databasePath);
  database
    .prepare(
      `
        UPDATE engine_scheduler_state
        SET status = 'running', updated_at = ?
        WHERE id = 'default'
      `,
    )
    .run(new Date().toISOString());
  database.close();
};

afterEach(() => {
  delete process.env.LOOPBOARD_DATABASE_PATH;
});

describe("Loop engine API routes", () => {
  it("returns scheduler state, queue counts, and recent jobs from GET /api/engine/status", async () => {
    await withEngineApiDatabase(async () => {
      const response = await getEngineStatus(
        new Request(
          `http://localhost/api/engine/status?projectId=${encodeURIComponent(seedProject.id)}`,
        ),
      );
      const payload = await readApiJson<{
        scheduler: { status: string };
        queueCounts: { completed: number; queued: number };
        recentJobs: Array<{ id: string }>;
        automationPolicy: { kind: string };
      }>(response);

      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      if (payload.ok) {
        assert.equal(payload.data.scheduler.status, "stopped");
        assert.equal(payload.data.automationPolicy.kind, "deny");
        assert.equal(payload.data.queueCounts.completed, 1);
        assert.equal(payload.data.queueCounts.queued, 0);
        assert.equal(payload.data.recentJobs[0]?.id, "engine-job-seed-demo-ping");
      }
    });
  });

  it("denies POST /api/engine/start when global auto-run is disabled", async () => {
    await withEngineApiDatabase(async () => {
      const response = await postStartScheduler();
      const payload = await readApiJson<unknown>(response);

      assert.equal(response.status, 403);
      assert.equal(payload.ok, false);
      if (!payload.ok) {
        assert.equal(payload.error.code, "global_auto_run_disabled");
      }
    });
  });

  it("starts and stops the scheduler when global auto-run is enabled", async () => {
    await withEngineApiDatabase(async () => {
      const databasePath = process.env.LOOPBOARD_DATABASE_PATH!;
      enableGlobalAutoRun(databasePath);

      const started = await postStartScheduler();
      const startedPayload = await readApiJson<{ scheduler: { status: string } }>(
        started,
      );

      assert.equal(started.status, 200);
      assert.equal(startedPayload.ok, true);
      if (startedPayload.ok) {
        assert.equal(startedPayload.data.scheduler.status, "running");
      }

      const stopped = await postStopScheduler();
      const stoppedPayload = await readApiJson<{ scheduler: { status: string } }>(
        stopped,
      );

      assert.equal(stopped.status, 200);
      assert.equal(stoppedPayload.ok, true);
      if (stoppedPayload.ok) {
        assert.equal(stoppedPayload.data.scheduler.status, "stopped");
      }
    });
  });

  it("enqueues a demo job and completes it through manual tick routes", async () => {
    await withEngineApiDatabase(async () => {
      const demoResponse = await postDemoJob(
        new Request("http://localhost/api/engine/demo-job", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: seedProject.id }),
        }),
      );
      const demoPayload = await readApiJson<{
        job: { status: string; kind: string };
      }>(demoResponse);

      assert.equal(demoResponse.status, 200);
      assert.equal(demoPayload.ok, true);
      if (demoPayload.ok) {
        assert.equal(demoPayload.data.job.status, "queued");
        assert.equal(demoPayload.data.job.kind, "demo-ping");
      }

      const tickResponse = await postTickEngine(
        new Request("http://localhost/api/engine/tick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "manual" }),
        }),
      );
      const tickPayload = await readApiJson<{
        plan: { action: string };
        job?: { status: string; logCount: number };
        scheduler: { tickCount: number };
      }>(tickResponse);

      assert.equal(tickResponse.status, 200);
      assert.equal(tickPayload.ok, true);
      if (tickPayload.ok) {
        assert.equal(tickPayload.data.plan.action, "process");
        assert.equal(tickPayload.data.job?.status, "completed");
        assert.ok((tickPayload.data.job?.logCount ?? 0) >= 2);
        assert.equal(tickPayload.data.scheduler.tickCount, 1);
      }
    });
  });

  it("denies automated tick when global auto-run is disabled", async () => {
    await withEngineApiDatabase(async () => {
      setSchedulerRunning(process.env.LOOPBOARD_DATABASE_PATH!);

      const response = await postTickEngine(
        new Request("http://localhost/api/engine/tick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "automated" }),
        }),
      );
      const payload = await readApiJson<unknown>(response);

      assert.equal(response.status, 403);
      assert.equal(payload.ok, false);
      if (!payload.ok) {
        assert.equal(payload.error.code, "global_auto_run_disabled");
      }
    });
  });
});
