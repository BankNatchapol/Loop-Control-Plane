import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { applyMigrations } from "@/db/migrate";
import { TaskContextService } from "@/lib/context/task-context-service";
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { executeImportTasks } from "@/lib/engine/executors/import-tasks-executor";
import { discoverFeatureArtifacts } from "@/lib/features/feature-artifacts";
import { SpecKitTaskImporter } from "@/lib/importers/spec-kit-task-importer";
import type { WorkflowArtifact } from "@/lib/loopboard";

const withImportFixture = (
  test: (input: {
    repository: LoopBoardRepository;
    featureId: string;
    contextRoot: string;
  }) => void,
) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "loopboard-import-exec-"));
  const repoPath = join(tempDirectory, "repo");
  const contextRoot = join(tempDirectory, "contexts");
  const featureFolder = join(repoPath, "specs", "checkout");
  const database = new DatabaseSync(join(tempDirectory, "loopboard.sqlite"));

  try {
    mkdirSync(featureFolder, { recursive: true });
    writeFileSync(join(featureFolder, "PRD.md"), "# Checkout PRD\n", "utf8");
    writeFileSync(join(featureFolder, "spec.md"), "# Checkout Spec\n", "utf8");
    writeFileSync(join(featureFolder, "plan.md"), "# Checkout Plan\n", "utf8");
    writeFileSync(
      join(featureFolder, "tasks.md"),
      [
        "# Tasks",
        "",
        "- [ ] T001 Add checkout API in `app/api/checkout/route.ts`",
        "- [ ] T002 Build checkout form in `app/checkout/page.tsx`",
      ].join("\n"),
      "utf8",
    );

    applyMigrations(database);
    const repository = new LoopBoardRepository(database);
    const project = repository.createProject({
      id: "project-checkout",
      name: "Checkout",
      repoPath,
      specKitRoot: "specs",
      createdAt: "2026-06-14T08:00:00.000Z",
    });
    const discovered = discoverFeatureArtifacts({
      project,
      artifactFolderPath: "specs/checkout",
      status: "tasks-ready",
    });
    const feature = repository.createFeature({
      id: "feature-checkout",
      projectId: project.id,
      name: "Checkout Flow",
      source: "spec-kit",
      status: "tasks-ready",
      ...discovered,
      createdAt: "2026-06-14T08:10:00.000Z",
    });

    test({ repository, featureId: feature.id, contextRoot });
  } finally {
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
};

describe("import-tasks-executor", () => {
  it("imports tasks from resolved tasks.md and returns loopboard output artifact", () => {
    withImportFixture(({ repository, featureId, contextRoot }) => {
      const inputArtifacts: WorkflowArtifact[] = [
        {
          name: "tasks",
          path: "specs/checkout/tasks.md",
          required: true,
        },
      ];
      const outputArtifacts: WorkflowArtifact[] = [
        {
          name: "loopboard-tasks",
          path: "loopboard://feature/{feature}/tasks",
          required: true,
        },
      ];

      const result = executeImportTasks({
        repository,
        featureId,
        inputArtifacts,
        outputArtifacts,
        importer: new SpecKitTaskImporter(
          repository,
          new TaskContextService(contextRoot),
        ),
      });

      assert.equal(result.success, true);
      assert.equal(result.result?.importedCount, 2);
      assert.equal(result.outputArtifacts?.[0]?.path, "loopboard://feature/feature-checkout/tasks");

      const tasks = repository
        .listBoardData("project-checkout")
        .tasks.filter((task) => task.featureId === featureId);
      assert.equal(tasks.length, 2);
      assert.ok(
        existsSync(
          join(contextRoot, tasks[0]?.id ?? "", "task.md"),
        ),
      );
      assert.ok(readFileSync(join(contextRoot, tasks[0]?.id ?? "", "task.md"), "utf8").length > 0);
    });
  });

  it("fails when tasks.md input file is missing", () => {
    withImportFixture(({ repository, featureId }) => {
      const result = executeImportTasks({
        repository,
        featureId,
        inputArtifacts: [
          {
            name: "tasks",
            path: "specs/checkout/missing-tasks.md",
            required: true,
          },
        ],
        outputArtifacts: [],
      });

      assert.equal(result.success, false);
      assert.equal(result.errorCode, "import_tasks_file_missing");
    });
  });
});
