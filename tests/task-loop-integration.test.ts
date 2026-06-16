import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { applyMigrations } from "@/db/migrate";
import { seedDatabase } from "@/db/seed";
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { createExecutorRegistryForRepository } from "@/lib/engine/executor-registry";
import { LoopScheduler } from "@/lib/engine/loop-scheduler";
import { seedProject } from "@/lib/loopboard";

describe("task loop integration", () => {
  it("picks up a ready low-risk task via scheduler tick and writes context files", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "task-loop-integration-"));
    const databasePath = join(tempDirectory, "loopboard.sqlite");
    const contextRoot = join(tempDirectory, "task-contexts");
    const taskId = "task-local-persistence-reset";
    const previousContextRoot = process.env.LOOPBOARD_TASK_CONTEXT_ROOT;

    try {
      process.env.LOOPBOARD_TASK_CONTEXT_ROOT = contextRoot;

      const database = new DatabaseSync(databasePath);
      applyMigrations(database);
      seedDatabase(database);

      const repository = new LoopBoardRepository(database);
      const initialTask = repository.getTask(taskId);

      assert.equal(initialTask.status, "ready");
      assert.equal(initialTask.risk, "low");

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
      const tick = await scheduler.tick({ mode: "automated" });

      assert.equal(tick.taskLoopPickup?.enqueued, 1);
      assert.equal(tick.plan.action, "process");
      assert.equal(tick.job?.kind, "task-run");
      assert.equal(tick.job?.taskId, taskId);
      assert.equal(tick.job?.status, "completed");

      const completedTask = repository.getTask(taskId);
      assert.equal(completedTask.status, "needs-review");
      assert.equal(completedTask.owner, "ai");
      assert.ok(
        completedTask.events.some((event) => event.type === "ASSIGNED_TO_AI"),
      );
      assert.ok(
        completedTask.events.some((event) => event.type === "ENGINE_PICKUP"),
      );
      assert.ok(
        completedTask.events.some((event) => event.type === "ENGINE_TASK_COMPLETED"),
      );

      const contextDir = join(contextRoot, taskId);
      assert.ok(existsSync(join(contextDir, "task.md")));
      assert.ok(existsSync(join(contextDir, "context.md")));
      assert.ok(existsSync(join(contextDir, "handoff.md")));
      assert.ok(existsSync(join(contextDir, "events.jsonl")));

      const handoff = readFileSync(join(contextDir, "handoff.md"), "utf8");
      assert.match(handoff, /Needs Review|needs-review/);
      assert.match(handoff, /ENGINE_TASK_COMPLETED/);

      const eventLines = readFileSync(join(contextDir, "events.jsonl"), "utf8")
        .trim()
        .split("\n");
      assert.ok(eventLines.length >= completedTask.events.length);
      assert.ok(
        eventLines.some((line) => JSON.parse(line).type === "ASSIGNED_TO_AI"),
      );

      database.close();
    } finally {
      if (previousContextRoot === undefined) {
        delete process.env.LOOPBOARD_TASK_CONTEXT_ROOT;
      } else {
        process.env.LOOPBOARD_TASK_CONTEXT_ROOT = previousContextRoot;
      }
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
