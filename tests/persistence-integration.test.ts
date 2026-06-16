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
import { TaskContextService } from "@/lib/context/task-context-service";
import { syncExistingTaskEventsFile } from "@/lib/api/task-context-actions";
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { seedFeatures, seedProject, seedTasks } from "@/lib/loopboard";

describe("LoopBoard local persistence", () => {
  it("keeps migrated tasks, events, and generated context files across database reopen", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "loopboard-persistence-"));
    const databasePath = join(tempDirectory, "loopboard.sqlite");
    const contextRoot = join(tempDirectory, "task-contexts");
    const originalContextRoot = process.env.LOOPBOARD_TASK_CONTEXT_ROOT;

    try {
      process.env.LOOPBOARD_TASK_CONTEXT_ROOT = contextRoot;
      let database = new DatabaseSync(databasePath);
      applyMigrations(database);
      seedDatabase(database);

      const repository = new LoopBoardRepository(database);
      const movedTask = repository.moveTask(
        "task-local-persistence-reset",
        "ai-running",
        "human",
      );
      const service = new TaskContextService(contextRoot);
      const generated = service.generateTaskContext({
        task: movedTask,
        project: seedProject,
        feature: seedFeatures.find(
          (feature) => feature.id === movedTask.featureId,
        )!,
      });

      assert.ok(existsSync(generated.paths.events));
      assert.match(
        readFileSync(generated.paths.handoff, "utf8"),
        /Status: AI Running \(ai-running\)/,
      );
      database.close();

      database = new DatabaseSync(databasePath);
      const reopenedRepository = new LoopBoardRepository(database);
      const board = reopenedRepository.listBoardData(seedProject.id);
      const reopenedTask = reopenedRepository.getTask(movedTask.id);
      database.close();

      assert.equal(board.projects.length, 1);
      assert.equal(board.tasks.length, seedTasks.length);
      assert.equal(reopenedTask.status, "ai-running");
      assert.equal(reopenedTask.events.at(-1)?.type, "TASK_MOVED");
      assert.equal(reopenedTask.events.at(-1)?.toStatus, "ai-running");

      const eventLines = readFileSync(generated.paths.events, "utf8")
        .trim()
        .split("\n");
      assert.equal(eventLines.length, reopenedTask.events.length);
      assert.equal(
        JSON.parse(eventLines.at(-1) ?? "{}").type,
        "TASK_MOVED",
      );

      const syncDatabase = new DatabaseSync(databasePath);
      const syncRepository = new LoopBoardRepository(syncDatabase);
      const updatedTask = syncRepository.appendTaskEvent(movedTask.id, {
        type: "HANDOFF_READY",
        actor: "human",
        message: "Prepared a fresh handoff after restart.",
        createdAt: "2099-01-01T00:00:00.000Z",
        metadata: {
          path: "data/task-contexts/task-local-persistence-reset/handoff.md",
        },
      });
      syncExistingTaskEventsFile(updatedTask);
      syncDatabase.close();

      const syncedEventLines = readFileSync(generated.paths.events, "utf8")
        .trim()
        .split("\n");
      assert.equal(syncedEventLines.length, updatedTask.events.length);
      assert.equal(
        JSON.parse(syncedEventLines.at(-1) ?? "{}").type,
        "HANDOFF_READY",
      );
    } finally {
      if (originalContextRoot === undefined) {
        delete process.env.LOOPBOARD_TASK_CONTEXT_ROOT;
      } else {
        process.env.LOOPBOARD_TASK_CONTEXT_ROOT = originalContextRoot;
      }
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
