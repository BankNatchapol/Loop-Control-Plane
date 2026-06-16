import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";

import type {
  CreateWorkflowInput,
  LoopBoardRepository,
  UpdateWorkflowInput,
} from "@/lib/db/loopboard-repository";
import type { Project, Workflow } from "@/lib/loopboard";
import {
  hasBlockingWorkflowIssues,
  validateWorkflowDefinition,
  type WorkflowValidationIssue,
} from "@/lib/workflows/workflow-editor";

export type WorkflowFileFormat = "json";

export type WorkflowFileValidationError = WorkflowValidationIssue | {
  code:
    | "invalid-file-path"
    | "unsupported-file-format"
    | "invalid-json"
    | "invalid-workflow-payload"
    | "workflow-overwrite-required";
  message: string;
  path?: string;
  workflowId?: string;
};

export type WorkflowFileExportResult = {
  workflow: Workflow;
  format: WorkflowFileFormat;
  fileName: string;
  path: string;
  absolutePath: string;
  overwritten: boolean;
  exportedAt: string;
};

export type WorkflowFileImportResult = {
  workflow?: Workflow;
  status: "imported" | "needs-overwrite";
  path: string;
  validationErrors: WorkflowFileValidationError[];
  existingWorkflowId?: string;
};

type WorkflowFilePayload = Omit<Workflow, "projectId" | "createdAt" | "updatedAt"> &
  Partial<Pick<Workflow, "projectId" | "createdAt" | "updatedAt">>;

export class WorkflowFileError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
    readonly code = "workflow_file_error",
    readonly validationErrors: WorkflowFileValidationError[] = [],
  ) {
    super(message);
  }
}

export const exportRepositoryWorkflowFile = ({
  repository,
  workflowId,
  fileName,
  overwrite = false,
}: {
  repository: LoopBoardRepository;
  workflowId: string;
  fileName?: string;
  overwrite?: boolean;
}): WorkflowFileExportResult => {
  const workflow = repository.getWorkflow(workflowId);
  const project = repository.getProject(workflow.projectId);

  return exportWorkflowFile({ project, workflow, fileName, overwrite });
};

export const importRepositoryWorkflowFile = ({
  repository,
  projectId,
  path,
  overwriteWorkflowId,
}: {
  repository: LoopBoardRepository;
  projectId: string;
  path: string;
  overwriteWorkflowId?: string;
}): WorkflowFileImportResult => {
  const project = repository.getProject(projectId);
  const resolved = resolveWorkflowFilePath(project, path, { mustBeJson: true });
  const payload = readWorkflowFilePayload(resolved.absolutePath, resolved.storedPath);
  const input = workflowPayloadToCreateInput(project.id, payload);
  const validationErrors = validateImportedWorkflowPayload(input);

  if (validationErrors.length > 0) {
    throw new WorkflowFileError(
      "Workflow file validation failed.",
      400,
      "workflow_file_validation_error",
      validationErrors,
    );
  }

  const existingWorkflow = findWorkflowConflict(repository, projectId, input);
  if (existingWorkflow && existingWorkflow.id !== overwriteWorkflowId) {
    return {
      status: "needs-overwrite",
      path: resolved.storedPath,
      existingWorkflowId: existingWorkflow.id,
      validationErrors: [
        {
          code: "workflow-overwrite-required",
          message: `Import would overwrite existing workflow "${existingWorkflow.name}".`,
          path: resolved.storedPath,
          workflowId: existingWorkflow.id,
        },
      ],
    };
  }

  const workflow = existingWorkflow
    ? repository.updateWorkflow(existingWorkflow.id, workflowPayloadToUpdateInput(input))
    : repository.createWorkflow(input);

  return {
    status: "imported",
    workflow,
    path: resolved.storedPath,
    validationErrors: [],
  };
};

export const workflowToJson = (workflow: Workflow): string =>
  `${JSON.stringify(workflow, null, 2)}\n`;

const exportWorkflowFile = ({
  project,
  workflow,
  fileName,
  overwrite,
}: {
  project: Project;
  workflow: Workflow;
  fileName?: string;
  overwrite: boolean;
}): WorkflowFileExportResult => {
  const resolved = resolveWorkflowFilePath(project, fileName ?? workflowFileName(workflow), {
    mustBeJson: true,
  });
  const existed = existsSync(resolved.absolutePath);

  if (existed && !overwrite) {
    throw new WorkflowFileError(
      `Workflow file "${resolved.storedPath}" already exists.`,
      409,
      "workflow_file_exists",
      [
        {
          code: "workflow-overwrite-required",
          message: `Export would overwrite existing file "${resolved.storedPath}".`,
          path: resolved.storedPath,
          workflowId: workflow.id,
        },
      ],
    );
  }

  try {
    mkdirSync(dirname(resolved.absolutePath), { recursive: true });
    writeFileSync(resolved.absolutePath, workflowToJson(workflow), "utf8");
  } catch {
    throw new WorkflowFileError("LoopBoard could not export the workflow file.");
  }

  return {
    workflow,
    format: "json",
    fileName: basename(resolved.storedPath),
    path: resolved.storedPath,
    absolutePath: resolved.absolutePath,
    overwritten: existed,
    exportedAt: new Date().toISOString(),
  };
};

const readWorkflowFilePayload = (
  absolutePath: string,
  storedPath: string,
): WorkflowFilePayload => {
  try {
    const stats = statSync(absolutePath);
    if (!stats.isFile()) {
      throw new WorkflowFileError(
        `"${storedPath}" is not a file.`,
        400,
        "invalid_workflow_file_path",
      );
    }
  } catch (error) {
    if (error instanceof WorkflowFileError) {
      throw error;
    }

    throw new WorkflowFileError(
      `Workflow file "${storedPath}" was not found.`,
      404,
      "workflow_file_not_found",
    );
  }

  try {
    const parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new WorkflowFileError(
        "Workflow file must contain a JSON object.",
        400,
        "invalid_workflow_file",
        [
          {
            code: "invalid-workflow-payload",
            message: "Workflow file must contain a JSON object.",
            path: storedPath,
          },
        ],
      );
    }

    return parsed as WorkflowFilePayload;
  } catch (error) {
    if (error instanceof WorkflowFileError) {
      throw error;
    }

    throw new WorkflowFileError(
      "Workflow file must contain valid JSON.",
      400,
      "invalid_workflow_json",
      [
        {
          code: "invalid-json",
          message: "Workflow file must contain valid JSON.",
          path: storedPath,
        },
      ],
    );
  }
};

const workflowPayloadToCreateInput = (
  projectId: string,
  payload: WorkflowFilePayload,
): CreateWorkflowInput => {
  if (!Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) {
    throw new WorkflowFileError(
      "Workflow file must include nodes and edges arrays.",
      400,
      "invalid_workflow_file",
      [
        {
          code: "invalid-workflow-payload",
          message: "Workflow file must include nodes and edges arrays.",
        },
      ],
    );
  }

  return {
    id: payload.id,
    projectId,
    name: payload.name,
    description: payload.description,
    version: payload.version,
    nodes: payload.nodes,
    edges: payload.edges,
    config: payload.config,
  };
};

const workflowPayloadToUpdateInput = (
  input: CreateWorkflowInput,
): UpdateWorkflowInput => ({
  name: input.name,
  description: input.description,
  version: input.version,
  nodes: input.nodes,
  edges: input.edges,
  config: input.config,
});

const validateImportedWorkflowPayload = (
  input: CreateWorkflowInput,
): WorkflowFileValidationError[] => {
  const issues: WorkflowFileValidationError[] = [];

  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    issues.push({
      code: "invalid-workflow-payload",
      message: "Workflow name must be a non-empty string.",
    });
  }

  const graphIssues = validateWorkflowDefinition({
    nodes: input.nodes ?? [],
    edges: input.edges ?? [],
  });

  if (hasBlockingWorkflowIssues(graphIssues)) {
    issues.push(...graphIssues);
  }

  return issues;
};

const findWorkflowConflict = (
  repository: LoopBoardRepository,
  projectId: string,
  input: CreateWorkflowInput,
): Workflow | undefined =>
  repository
    .listWorkflows(projectId)
    .find(
      (workflow) =>
        (input.id && workflow.id === input.id) ||
        workflow.name.toLocaleLowerCase() === input.name.toLocaleLowerCase(),
    );

const resolveWorkflowFilePath = (
  project: Project,
  path: string,
  options: { mustBeJson: boolean },
) => {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new WorkflowFileError("Workflow file path is required.", 400, "invalid_workflow_file_path");
  }

  const storedPath = path.trim();

  if (isAbsolute(storedPath)) {
    throw new WorkflowFileError(
      "Workflow file paths must be relative to the configured workflow folder.",
      400,
      "invalid_workflow_file_path",
      [
        {
          code: "invalid-file-path",
          message: "Workflow file paths must be relative to the configured workflow folder.",
          path: storedPath,
        },
      ],
    );
  }

  if (options.mustBeJson && extname(storedPath).toLocaleLowerCase() !== ".json") {
    throw new WorkflowFileError(
      "Only JSON workflow files are supported.",
      400,
      "unsupported_workflow_file_format",
      [
        {
          code: "unsupported-file-format",
          message: "Only JSON workflow files are supported.",
          path: storedPath,
        },
      ],
    );
  }

  const repoRoot = resolve(project.repoPath);
  const workflowRoot = resolve(repoRoot, project.workflowsPath || "workflows");
  const absolutePath = resolve(workflowRoot, storedPath);

  if (!isInside(absolutePath, workflowRoot)) {
    throw new WorkflowFileError(
      "Workflow file paths must stay inside the configured workflow folder.",
      400,
      "invalid_workflow_file_path",
      [
        {
          code: "invalid-file-path",
          message: "Workflow file paths must stay inside the configured workflow folder.",
          path: storedPath,
        },
      ],
    );
  }

  return {
    storedPath,
    absolutePath,
  };
};

const isInside = (targetPath: string, rootPath: string): boolean => {
  const relativePath = relative(rootPath, targetPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
};

const workflowFileName = (workflow: Workflow): string =>
  `${slugify(workflow.name || workflow.id)}.json`;

const slugify = (value: string): string => {
  const slug = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "workflow";
};
