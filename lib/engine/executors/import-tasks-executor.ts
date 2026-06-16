import { TaskContextService } from "@/lib/context/task-context-service";
import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import type { EngineRunLogEntry } from "@/lib/engine/loop-engine-types";
import { SpecKitTaskImporter } from "@/lib/importers/spec-kit-task-importer";
import type { WorkflowArtifact } from "@/lib/loopboard";

import {
  artifactExistsOnDisk,
  findWorkflowArtifactByName,
} from "@/lib/engine/executors/workflow-artifact-paths";
import type { WorkflowStepExecutorResult } from "@/lib/engine/executors/workflow-step-types";

export type ImportTasksExecutorInput = {
  repository: LoopBoardRepository;
  featureId: string;
  inputArtifacts: WorkflowArtifact[];
  outputArtifacts: WorkflowArtifact[];
  contextRoot?: string;
  importer?: SpecKitTaskImporter;
};

const nowIso = (): string => new Date().toISOString();

const logEntry = (
  level: EngineRunLogEntry["level"],
  message: string,
  metadata: EngineRunLogEntry["metadata"] = {},
): EngineRunLogEntry => ({
  timestamp: nowIso(),
  level,
  message,
  metadata,
});

export const executeImportTasks = (
  input: ImportTasksExecutorInput,
): WorkflowStepExecutorResult => {
  const tasksArtifact = findWorkflowArtifactByName(input.inputArtifacts, ["tasks"]);

  if (!tasksArtifact) {
    return {
      success: false,
      errorCode: "import_tasks_input_missing",
      error: "Import tasks requires a tasks.md input artifact.",
      logs: [
        logEntry("error", "Tasks input artifact was not found.", {
          inputArtifacts: input.inputArtifacts.map((artifact) => artifact.name),
        }),
      ],
    };
  }

  const project = input.repository.getProject(
    input.repository.getFeature(input.featureId).projectId,
  );

  if (!artifactExistsOnDisk(project.repoPath, tasksArtifact.path)) {
    return {
      success: false,
      errorCode: "import_tasks_file_missing",
      error: `tasks.md was not found at ${tasksArtifact.path}.`,
      logs: [
        logEntry("error", "tasks.md input file does not exist on disk.", {
          tasksPath: tasksArtifact.path,
        }),
      ],
    };
  }

  const importer =
    input.importer ??
    new SpecKitTaskImporter(
      input.repository,
      new TaskContextService(input.contextRoot),
    );

  let importResult;
  try {
    importResult = importer.importFeature(input.featureId);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Spec Kit task import failed.";
    return {
      success: false,
      errorCode: "import_tasks_failed",
      error: message,
      logs: [logEntry("error", message, { featureId: input.featureId })],
    };
  }

  const loopboardOutput =
    findWorkflowArtifactByName(input.outputArtifacts, ["loopboard-tasks"]) ??
    input.outputArtifacts[0];

  const outputArtifacts = loopboardOutput
    ? [
        {
          ...loopboardOutput,
          path: loopboardOutput.path.replaceAll("{feature}", input.featureId),
        },
      ]
    : input.outputArtifacts;

  return {
    success: true,
    outputArtifacts,
    result: {
      featureId: input.featureId,
      tasksPath: importResult.preview.tasksPath,
      importedCount: importResult.imported.length,
      skippedCount: importResult.skipped.length,
      importedTaskIds: importResult.imported.map((entry) => entry.task.id),
      skipped: importResult.skipped,
    },
    logs: [
      logEntry("info", "Import tasks executor started.", {
        featureId: input.featureId,
        tasksPath: tasksArtifact.path,
      }),
      logEntry("info", "Spec Kit tasks imported into Loop Control Plane.", {
        importedCount: importResult.imported.length,
        skippedCount: importResult.skipped.length,
      }),
    ],
  };
};
