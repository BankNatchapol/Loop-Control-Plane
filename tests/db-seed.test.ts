import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { applyMigrations } from "@/db/migrate";
import { seedDatabase } from "@/db/seed";
import { seedFeatures, seedProject, seedTasks, seedWorkflows } from "@/lib/loopboard";

describe("Loop Control Plane SQLite setup", () => {
  it("applies migrations and seeds the Phase 01 demo board", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "loopboard-db-"));
    const database = new DatabaseSync(join(tempDirectory, "loopboard.sqlite"));

    try {
      const applied = applyMigrations(database);
      seedDatabase(database);
      seedDatabase(database);

      assert.deepEqual(applied, [
        "0001_initial_loopboard.sql",
        "0002_project_local_management.sql",
        "0003_feature_artifact_management.sql",
        "0004_feature_approval_events.sql",
        "0005_project_github_repository.sql",
        "0006_workflow_editor_runner.sql",
        "0007_automation_policy_settings.sql",
        "0008_loop_engine.sql",
        "0009_project_engine_settings.sql",
      ]);
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM projects").get()
          ?.count,
        1,
      );
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM features").get()
          ?.count,
        seedFeatures.length,
      );
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM tasks").get()?.count,
        seedTasks.length,
      );
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM task_events").get()
          ?.count,
        seedTasks.reduce((count, task) => count + task.events.length, 0),
      );
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM feature_events").get()
          ?.count,
        0,
      );
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM workflows").get()?.count,
        seedWorkflows.length,
      );
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM workflow_nodes").get()
          ?.count,
        seedWorkflows.reduce((count, workflow) => count + workflow.nodes.length, 0),
      );
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM workflow_edges").get()
          ?.count,
        seedWorkflows.reduce((count, workflow) => count + workflow.edges.length, 0),
      );
      assert.equal(
        database
          .prepare("SELECT github_repository FROM projects WHERE id = ?")
          .get(seedProject.id)?.github_repository,
        seedProject.githubRepository,
      );
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM engine_jobs").get()?.count,
        1,
      );
      assert.equal(
        database
          .prepare(
            "SELECT status FROM engine_scheduler_state WHERE id = 'default'",
          )
          .get()?.status,
        "stopped",
      );

      const seededTask = database
        .prepare(
          `
            SELECT project_id, labels, acceptance_criteria, dependencies, github
            FROM tasks
            WHERE id = ?
          `,
        )
        .get(seedTasks[0].id);

      assert.equal(seededTask?.project_id, seedProject.id);
      assert.deepEqual(JSON.parse(String(seededTask?.labels)), seedTasks[0].labels);
      assert.deepEqual(
        JSON.parse(String(seededTask?.acceptance_criteria)),
        seedTasks[0].acceptanceCriteria,
      );
      assert.deepEqual(JSON.parse(String(seededTask?.dependencies)), []);
      assert.deepEqual(JSON.parse(String(seededTask?.github)), seedTasks[0].github);

      const indexes = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((row) => String(row.name));

      assert.ok(indexes.includes("tasks_project_id_idx"));
      assert.ok(indexes.includes("tasks_feature_id_idx"));
      assert.ok(indexes.includes("tasks_status_idx"));
      assert.ok(indexes.includes("tasks_owner_idx"));
      assert.ok(indexes.includes("task_events_task_created_at_idx"));
      assert.ok(indexes.includes("feature_events_feature_created_at_idx"));
      assert.ok(indexes.includes("workflows_project_id_idx"));
      assert.ok(indexes.includes("workflow_runs_project_status_idx"));
      assert.ok(indexes.includes("engine_jobs_status_idx"));
      assert.ok(indexes.includes("engine_jobs_status_queued_at_idx"));
      assert.ok(indexes.includes("engine_jobs_project_id_idx"));
      assert.ok(indexes.includes("engine_jobs_project_status_idx"));
    } finally {
      database.close();
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
