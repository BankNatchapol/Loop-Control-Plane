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
import { discoverFeatureArtifacts } from "@/lib/features/feature-artifacts";
import { SpecKitTaskImporter } from "@/lib/importers/spec-kit-task-importer";

const withImporter = (
  test: (input: {
    repository: LoopBoardRepository;
    importer: SpecKitTaskImporter;
    contextRoot: string;
    featureId: string;
  }) => void,
) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "loopboard-importer-"));
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
        "## Backend",
        "- [ ] T001 Add checkout API in `app/api/checkout/route.ts`",
        "  Parse the request and persist payment intent metadata.",
        "  Dependencies: T000",
        "  Acceptance Criteria:",
        "  - Returns validation errors without writing rows.",
        "",
        "## Frontend",
        "- [ ] T002 Build checkout form in `app/checkout/page.tsx`",
        "  Acceptance: User can submit card details.",
        "",
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
    const importer = new SpecKitTaskImporter(
      repository,
      new TaskContextService(contextRoot),
    );

    test({ repository, importer, contextRoot, featureId: feature.id });
  } finally {
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
};

describe("SpecKitTaskImporter", () => {
  it("previews parsed feature tasks without writing task rows", () => {
    withImporter(({ repository, importer, featureId }) => {
      const before = repository.listBoardData("project-checkout").tasks.length;
      const preview = importer.previewFeature(featureId);

      assert.equal(preview.tasks.length, 2);
      assert.equal(preview.tasks[0]?.sourceId, "T001");
      assert.equal(preview.tasks[0]?.duplicate, false);
      assert.equal(preview.tasks[0]?.risk, "critical");
      assert.deepEqual(preview.tasks[0]?.labels, ["backend"]);
      assert.deepEqual(preview.tasks[0]?.dependencies, ["T000"]);
      assert.deepEqual(preview.tasks[0]?.sourceArtifactPaths, [
        "specs/checkout/PRD.md",
        "specs/checkout/spec.md",
        "specs/checkout/plan.md",
        "specs/checkout/tasks.md",
      ]);
      assert.equal(preview.missingArtifacts.length, 1);
      assert.equal(preview.missingArtifacts[0]?.fileName, "decisions.md");
      assert.equal(repository.listBoardData("project-checkout").tasks.length, before);
    });
  });

  it("imports approved preview tasks with TASK_IMPORTED events and context files", () => {
    withImporter(({ repository, importer, contextRoot, featureId }) => {
      const preview = importer.previewFeature(featureId);
      const result = importer.importFeature(featureId, {
        tasks: [
          {
            ...preview.tasks[0],
            owner: "ai",
            mode: "execute",
            status: "ready",
            labels: ["backend", "payments"],
          },
          {
            ...preview.tasks[1],
            include: false,
          },
        ],
      });

      assert.equal(result.imported.length, 1);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0]?.reason, "excluded");

      const imported = result.imported[0]?.task;
      assert.ok(imported);
      assert.equal(imported.source, "spec-kit");
      assert.equal(imported.featureId, featureId);
      assert.equal(imported.status, "ready");
      assert.equal(imported.owner, "ai");
      assert.equal(imported.mode, "execute");
      assert.equal(imported.risk, "critical");
      assert.deepEqual(imported.labels, ["spec-kit", "backend", "payments"]);
      assert.deepEqual(imported.acceptanceCriteria, [
        "Returns validation errors without writing rows.",
      ]);
      assert.deepEqual(imported.dependencies, ["T000"]);
      assert.deepEqual(imported.handoff.contextPaths, [
        "specs/checkout/PRD.md",
        "specs/checkout/spec.md",
        "specs/checkout/plan.md",
        "specs/checkout/tasks.md",
      ]);
      assert.equal(imported.events.at(-1)?.type, "TASK_IMPORTED");
      assert.equal(imported.events.at(-1)?.metadata?.sourceId, "T001");

      const generated = result.imported[0]?.generated.paths;
      assert.ok(generated);
      assert.ok(generated.directory.startsWith(contextRoot));
      assert.ok(existsSync(generated.task));
      assert.ok(existsSync(generated.context));
      assert.ok(existsSync(generated.handoff));
      assert.ok(existsSync(generated.events));
      assert.match(readFileSync(generated.events, "utf8"), /TASK_IMPORTED/);

      const persisted = repository.getTask(imported.id);
      assert.equal(persisted.events.at(-1)?.type, "TASK_IMPORTED");
    });
  });

  it("skips repeated imports by source task ID or title within the feature", () => {
    withImporter(({ importer, featureId }) => {
      const first = importer.importFeature(featureId);
      const second = importer.importFeature(featureId);

      assert.equal(first.imported.length, 2);
      assert.equal(second.imported.length, 0);
      assert.deepEqual(
        second.skipped.map((item) => [item.sourceId, item.reason, item.duplicateTaskId]),
        [
          ["T001", "duplicate", first.imported[0]?.task.id],
          ["T002", "duplicate", first.imported[1]?.task.id],
        ],
      );

      const preview = importer.previewFeature(featureId);
      assert.equal(preview.tasks[0]?.duplicate, true);
      assert.equal(preview.tasks[0]?.duplicateTaskId, first.imported[0]?.task.id);
    });
  });

  it("skips approved import payload tasks that duplicate an existing title", () => {
    withImporter(({ importer, featureId }) => {
      const first = importer.importFeature(featureId, {
        tasks: [
          {
            sourceId: "SOURCE-A",
            title: "Create shared importer shell",
            description: "Create the first imported task.",
          },
        ],
      });
      const second = importer.importFeature(featureId, {
        tasks: [
          {
            sourceId: "SOURCE-B",
            title: "  Create   shared importer shell  ",
            description: "Same work with a new source ID should still skip.",
          },
        ],
      });

      assert.equal(first.imported.length, 1);
      assert.equal(second.imported.length, 0);
      assert.deepEqual(second.skipped, [
        {
          sourceId: "SOURCE-B",
          title: "Create   shared importer shell",
          reason: "duplicate",
          duplicateTaskId: first.imported[0]?.task.id,
        },
      ]);
    });
  });
});
