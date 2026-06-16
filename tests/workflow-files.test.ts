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
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import type { Workflow } from "@/lib/loopboard";
import {
  createCatalogWorkflowNode,
  normalizeWorkflowEdge,
} from "@/lib/workflows/workflow-editor";
import {
  exportRepositoryWorkflowFile,
  importRepositoryWorkflowFile,
  WorkflowFileError,
} from "@/lib/workflows/workflow-files";

const withRepository = (
  test: (input: {
    repository: LoopBoardRepository;
    tempDirectory: string;
    projectId: string;
  }) => void,
) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "loopboard-workflow-files-"));
  const database = new DatabaseSync(join(tempDirectory, "loopboard.sqlite"));
  const repository = new LoopBoardRepository(database);
  const projectId = "project-workflow-files";

  try {
    applyMigrations(database);
    repository.createProject({
      id: projectId,
      name: "Workflow Files",
      repoPath: tempDirectory,
      workflowsPath: "workflows",
      createdAt: "2026-06-16T00:00:00.000Z",
    });
    mkdirSync(join(tempDirectory, "workflows"), { recursive: true });
    test({ repository, tempDirectory, projectId });
  } finally {
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
};

const createWorkflow = (
  repository: LoopBoardRepository,
  projectId: string,
  id = "workflow-file-test",
): Workflow => {
  const timestamp = "2026-06-16T01:00:00.000Z";
  const nodes = [
    {
      ...createCatalogWorkflowNode({
        type: "human-input",
        workflowId: id,
        index: 0,
      }),
      id: "node-human-input",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      ...createCatalogWorkflowNode({
        type: "run-tests",
        workflowId: id,
        index: 1,
      }),
      id: "node-run-tests",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];

  return repository.createWorkflow({
    id,
    projectId,
    name: "Workflow File Test",
    description: "Persisted workflow for import/export tests.",
    createdAt: timestamp,
    nodes,
    edges: [
      {
        ...normalizeWorkflowEdge({
          workflowId: id,
          sourceNodeId: nodes[0]!.id,
          targetNodeId: nodes[1]!.id,
        }),
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    config: { pauseOnHumanNodes: true },
  });
};

describe("workflow file import/export", () => {
  it("exports workflow JSON inside the configured workflow folder", () => {
    withRepository(({ repository, tempDirectory, projectId }) => {
      const workflow = createWorkflow(repository, projectId);
      const result = exportRepositoryWorkflowFile({
        repository,
        workflowId: workflow.id,
      });

      assert.equal(result.path, "workflow-file-test.json");
      assert.equal(result.fileName, "workflow-file-test.json");
      assert.ok(existsSync(join(tempDirectory, "workflows", result.path)));
      assert.equal(
        JSON.parse(readFileSync(result.absolutePath, "utf8")).name,
        "Workflow File Test",
      );
    });
  });

  it("rejects workflow file paths outside the configured workflow folder", () => {
    withRepository(({ repository, projectId }) => {
      assert.throws(
        () =>
          importRepositoryWorkflowFile({
            repository,
            projectId,
            path: "../outside.json",
          }),
        (error) =>
          error instanceof WorkflowFileError &&
          error.code === "invalid_workflow_file_path" &&
          error.validationErrors[0]?.code === "invalid-file-path",
      );
    });
  });

  it("reports structured overwrite validation before replacing a workflow", () => {
    withRepository(({ repository, tempDirectory, projectId }) => {
      const workflow = createWorkflow(repository, projectId);
      const importedPath = join(tempDirectory, "workflows", "imported.json");

      writeFileSync(
        importedPath,
        JSON.stringify(
          {
            ...workflow,
            description: "Imported replacement.",
            config: { imported: true },
          },
          null,
          2,
        ),
        "utf8",
      );

      const conflict = importRepositoryWorkflowFile({
        repository,
        projectId,
        path: "imported.json",
      });

      assert.equal(conflict.status, "needs-overwrite");
      assert.equal(conflict.existingWorkflowId, workflow.id);
      assert.equal(conflict.validationErrors[0]?.code, "workflow-overwrite-required");

      const result = importRepositoryWorkflowFile({
        repository,
        projectId,
        path: "imported.json",
        overwriteWorkflowId: workflow.id,
      });

      assert.equal(result.status, "imported");
      assert.equal(result.workflow?.description, "Imported replacement.");
      assert.equal(result.workflow?.config.imported, true);
    });
  });

  it("rejects imported workflow files with graph validation errors", () => {
    withRepository(({ repository, tempDirectory, projectId }) => {
      writeFileSync(
        join(tempDirectory, "workflows", "invalid.json"),
        JSON.stringify({
          id: "workflow-invalid",
          name: "Invalid Workflow",
          version: 1,
          nodes: [],
          edges: [],
          config: {},
        }),
        "utf8",
      );

      assert.throws(
        () =>
          importRepositoryWorkflowFile({
            repository,
            projectId,
            path: "invalid.json",
          }),
        (error) =>
          error instanceof WorkflowFileError &&
          error.code === "workflow_file_validation_error" &&
          error.validationErrors[0]?.code === "empty-graph",
      );
    });
  });
});
