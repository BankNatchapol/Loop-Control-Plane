import type {
  BoardData,
  CreateFeatureInput,
  CreateProjectInput,
  CreateWorkflowInput,
  PersistedTask,
  UpdateFeatureInput,
  UpdateProjectInput,
  UpdateWorkflowInput,
} from "@/lib/db/loopboard-repository";
import type {
  HandoffDocument,
  TaskContextStatus,
} from "@/lib/context/task-context-service";
import type {
  Feature,
  FeatureApprovalArtifactName,
  FeatureArtifactName,
  KanbanStatus,
  Project,
  RiskLevel,
  TaskAction,
  TaskEvent,
  TaskMode,
  TaskOwner,
  Workflow,
  WorkflowArtifact,
  WorkflowRun,
} from "@/lib/loopboard";
import type {
  WorkflowFileExportResult,
  WorkflowFileImportResult,
  WorkflowFileValidationError,
} from "@/lib/workflows/workflow-files";
import type { BackendAvailabilityResponse } from "@/lib/api/backend-availability-actions";
import type {
  EngineDemoJobResponse,
  EngineJobSummary,
  EngineSchedulerActionResponse,
  EngineStatusResponse,
  EngineTickResponse,
} from "@/lib/api/engine-actions";
import type {
  TaskLoopEnqueueResponse,
  TaskLoopScanResponse,
} from "@/lib/api/task-loop-actions";
import type { AutomationSettings, PolicyDecision } from "@/lib/policies/automation-policy";
import type { WorkflowRunAction } from "@/lib/workflows/workflow-runner";

type ApiSuccess<T> = {
  ok: true;
  data: T;
};

type ApiFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
  };
  validationErrors?: WorkflowFileValidationError[];
};

type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export class LoopBoardApiError extends Error {
  constructor(
    message: string,
    readonly code = "request_failed",
    readonly validationErrors: WorkflowFileValidationError[] = [],
  ) {
    super(message);
  }
}

export type TaskContextActionResult = {
  task: PersistedTask;
  context: TaskContextStatus;
};

export type ClaudeCodePromptResult = {
  taskId: string;
  prompt: string;
  paths: {
    directory: string;
    task: string;
    context: string;
    handoff: string;
    events: string;
  };
  sourceArtifacts: string[];
  generatedAt: string;
};

export type ClaudeCodePromptActionResult = {
  task: PersistedTask;
  context: TaskContextStatus;
  prompt: ClaudeCodePromptResult;
};

export type HandoffDocumentActionResult = {
  task: PersistedTask;
  context: TaskContextStatus;
  handoff: HandoffDocument;
};

export type ProjectOpenActionResult = {
  action: "open-folder" | "open-vscode";
  projectId: string;
  repoPath: string;
  command: string;
  message: string;
};

export type TaskOpenActionResult = {
  action: "open-worktree-vscode" | "open-repo-vscode";
  taskId: string;
  projectId: string;
  path: string;
  pathKind: "worktree" | "repo";
  usedFallback: boolean;
  command: string;
  message: string;
};

export type GitHubConnectionCheck = {
  status:
    | "disconnected"
    | "token-missing"
    | "repo-missing"
    | "connected"
    | "api-error";
  repository: string;
  message: string;
  checkedAt: string;
};

export type GitHubLabelSetupResult = {
  status:
    | "disconnected"
    | "token-missing"
    | "repo-missing"
    | "ready"
    | "api-error";
  repository: string;
  message: string;
  checkedAt: string;
  labels: Array<{
    name: string;
    status: "exists" | "created" | "error";
    message: string;
  }>;
};

export type GitHubIssueCreateResult = {
  status:
    | "disconnected"
    | "token-missing"
    | "repo-missing"
    | "created"
    | "api-error";
  repository: string;
  message: string;
  issueNumber?: number;
  issueUrl?: string;
  labels: string[];
  createdAt: string;
};

export type TaskGitHubIssueActionResult = {
  task: PersistedTask;
  issue: GitHubIssueCreateResult;
};

export type GitHubIssueLabelSyncResult = {
  status:
    | "disconnected"
    | "token-missing"
    | "repo-missing"
    | "issue-missing"
    | "synced"
    | "api-error";
  repository: string;
  message: string;
  issueNumber?: number;
  labels: string[];
  syncedAt: string;
};

export type TaskGitHubIssueLabelSyncActionResult = {
  task: PersistedTask;
  sync: GitHubIssueLabelSyncResult;
};

export type GitHubPullRequestSyncResult = {
  status:
    | "disconnected"
    | "token-missing"
    | "repo-missing"
    | "not-found"
    | "synced"
    | "api-error";
  repository: string;
  message: string;
  syncedAt: string;
  linkedIssueNumbers: number[];
};

export type TaskGitHubPullRequestSyncActionResult = {
  task: PersistedTask;
  sync: GitHubPullRequestSyncResult;
};

export type FeatureArtifactDocument = {
  featureId: string;
  artifactName: FeatureArtifactName;
  fileName: string;
  path: string;
  absolutePath: string;
  exists: boolean;
  content: string;
  loadedAt: string;
};

export type SpecKitArtifactLink = {
  name: FeatureArtifactName;
  fileName: string;
  path: string;
  exists: boolean;
};

export type SpecKitParseWarning = {
  line: number;
  message: string;
};

export type SpecKitMissingArtifactNotice = {
  name: FeatureArtifactName;
  fileName: string;
  path: string;
  message: string;
};

export type SpecKitImportPreviewTask = {
  sourceId: string;
  sourceLine: number;
  completed: boolean;
  headings: string[];
  title: string;
  description: string;
  fileReferences: string[];
  dependencies: string[];
  acceptanceCriteria: string[];
  labels: string[];
  owner: TaskOwner;
  mode: TaskMode;
  risk: RiskLevel;
  notes: string[];
  sourceText: string;
  sourceArtifactPaths: string[];
  duplicate: boolean;
  duplicateTaskId?: string;
  status?: KanbanStatus;
};

export type SpecKitImportPreview = {
  project: Project;
  feature: Feature;
  tasksPath: string;
  tasks: SpecKitImportPreviewTask[];
  artifacts: SpecKitArtifactLink[];
  warnings: SpecKitParseWarning[];
  missingArtifacts: SpecKitMissingArtifactNotice[];
};

export type SpecKitImportTaskInput = {
  include?: boolean;
  sourceId: string;
  sourceLine?: number;
  completed?: boolean;
  headings?: string[];
  title: string;
  description?: string;
  fileReferences?: string[];
  dependencies?: string[];
  acceptanceCriteria?: string[];
  labels?: string[];
  owner?: TaskOwner;
  mode?: TaskMode;
  risk?: RiskLevel;
  notes?: string[];
  sourceText?: string;
  sourceArtifactPaths?: string[];
  status?: KanbanStatus;
};

export type SpecKitImportResult = {
  project: Project;
  feature: Feature;
  imported: Array<{
    task: PersistedTask;
    sourceId: string;
  }>;
  skipped: Array<{
    sourceId: string;
    title: string;
    reason: "excluded" | "duplicate";
    duplicateTaskId?: string;
  }>;
  preview: SpecKitImportPreview;
};

const readApiResponse = async <T>(response: Response): Promise<T> => {
  const body = (await response.json().catch(() => null)) as ApiResponse<T> | null;

  if (body?.ok) {
    return body.data;
  }

  throw new LoopBoardApiError(
    body?.error.message ?? "LoopBoard could not complete the request.",
    body?.error.code,
    body?.validationErrors ?? [],
  );
};

const writeJson = async <T>(
  url: string,
  body: unknown,
): Promise<T> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readApiResponse<T>(response);
};

const patchJson = async <T>(
  url: string,
  body: unknown,
): Promise<T> => {
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readApiResponse<T>(response);
};

export const fetchBoardData = async (projectId?: string): Promise<BoardData> => {
  const params = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const response = await fetch(`/api/board${params}`, { cache: "no-store" });

  return readApiResponse<BoardData>(response);
};

export const fetchProjects = async (): Promise<Project[]> => {
  const response = await fetch("/api/projects", { cache: "no-store" });

  return readApiResponse<Project[]>(response);
};

export const fetchAutomationSettings = async (): Promise<AutomationSettings> => {
  const response = await fetch("/api/settings/automation", { cache: "no-store" });

  return readApiResponse<AutomationSettings>(response);
};

export const fetchEngineStatus = async (
  projectId?: string,
): Promise<EngineStatusResponse> => {
  const params = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const response = await fetch(`/api/engine/status${params}`, { cache: "no-store" });

  return readApiResponse<EngineStatusResponse>(response);
};

export type { BackendAvailabilityResponse };

export const fetchBackendAvailability = async (
  projectId?: string,
): Promise<BackendAvailabilityResponse> => {
  const params = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const response = await fetch(`/api/engine/backends/availability${params}`, {
    cache: "no-store",
  });

  return readApiResponse<BackendAvailabilityResponse>(response);
};

export const startEngineScheduler = async (): Promise<EngineSchedulerActionResponse> =>
  writeJson<EngineSchedulerActionResponse>("/api/engine/start", {});

export const stopEngineScheduler = async (): Promise<EngineSchedulerActionResponse> =>
  writeJson<EngineSchedulerActionResponse>("/api/engine/stop", {});

export const tickEngine = async ({
  mode = "manual",
}: {
  mode?: "manual" | "automated";
} = {}): Promise<EngineTickResponse> =>
  writeJson<EngineTickResponse>("/api/engine/tick", { mode });

export const enqueueEngineDemoJob = async (
  projectId: string,
): Promise<EngineDemoJobResponse> =>
  writeJson<EngineDemoJobResponse>("/api/engine/demo-job", { projectId });

export type { EngineJobSummary, PolicyDecision, TaskLoopEnqueueResponse, TaskLoopScanResponse };

export const scanTaskLoop = async (input: {
  projectId?: string;
  taskId?: string;
  automated?: boolean;
} = {}): Promise<TaskLoopScanResponse> =>
  writeJson<TaskLoopScanResponse>("/api/engine/task-loop/scan", input);

export const enqueueTaskLoop = async (input: {
  taskId: string;
  automated?: boolean;
}): Promise<TaskLoopEnqueueResponse> =>
  writeJson<TaskLoopEnqueueResponse>("/api/engine/task-loop/enqueue", input);

export const updateAutomationSettings = async (
  input: Partial<AutomationSettings>,
): Promise<AutomationSettings> =>
  patchJson<AutomationSettings>("/api/settings/automation", input);

export const createProject = async (
  input: CreateProjectInput,
): Promise<Project> => writeJson<Project>("/api/projects", input);

export const updateProject = async ({
  projectId,
  input,
}: {
  projectId: string;
  input: UpdateProjectInput;
}): Promise<Project> =>
  patchJson<Project>(`/api/projects/${encodeURIComponent(projectId)}`, input);

export const deleteProject = async (projectId: string): Promise<{ projectId: string }> => {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  });

  return readApiResponse<{ projectId: string }>(response);
};

export const openProject = async ({
  projectId,
  action,
}: {
  projectId: string;
  action: ProjectOpenActionResult["action"];
}): Promise<ProjectOpenActionResult> =>
  writeJson<ProjectOpenActionResult>(
    `/api/projects/${encodeURIComponent(projectId)}/open`,
    { action },
  );

export const openTask = async ({
  taskId,
  action,
}: {
  taskId: string;
  action: TaskOpenActionResult["action"];
}): Promise<TaskOpenActionResult> =>
  writeJson<TaskOpenActionResult>(
    `/api/tasks/${encodeURIComponent(taskId)}/open`,
    { action },
  );

export const fetchProjectWorkflows = async (
  projectId: string,
): Promise<Workflow[]> => {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows`,
    { cache: "no-store" },
  );

  return readApiResponse<Workflow[]>(response);
};

export const createProjectWorkflow = async ({
  projectId,
  input,
}: {
  projectId: string;
  input: Omit<CreateWorkflowInput, "projectId">;
}): Promise<Workflow> =>
  writeJson<Workflow>(
    `/api/projects/${encodeURIComponent(projectId)}/workflows`,
    input,
  );

export const updateWorkflow = async ({
  workflowId,
  input,
}: {
  workflowId: string;
  input: UpdateWorkflowInput;
}): Promise<Workflow> =>
  patchJson<Workflow>(`/api/workflows/${encodeURIComponent(workflowId)}`, input);

export const exportWorkflow = async ({
  workflowId,
  fileName,
  overwrite,
}: {
  workflowId: string;
  fileName?: string;
  overwrite?: boolean;
}): Promise<WorkflowFileExportResult> =>
  writeJson<WorkflowFileExportResult>(
    `/api/workflows/${encodeURIComponent(workflowId)}/export`,
    { fileName, overwrite },
  );

export const importProjectWorkflow = async ({
  projectId,
  path,
  overwriteWorkflowId,
}: {
  projectId: string;
  path: string;
  overwriteWorkflowId?: string;
}): Promise<WorkflowFileImportResult> =>
  writeJson<WorkflowFileImportResult>(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/import`,
    { path, overwriteWorkflowId },
  );

export const startWorkflowRun = async ({
  workflowId,
  featureId,
  inputArtifacts,
}: {
  workflowId: string;
  featureId?: string;
  inputArtifacts?: WorkflowArtifact[];
}): Promise<WorkflowRun> =>
  writeJson<WorkflowRun>(
    `/api/workflows/${encodeURIComponent(workflowId)}/runs`,
    { featureId, inputArtifacts },
  );

export const applyWorkflowRunAction = async ({
  runId,
  action,
  error,
}: {
  runId: string;
  action: Exclude<WorkflowRunAction, "start">;
  error?: string;
}): Promise<WorkflowRun> => {
  const response = await fetch(
    `/api/workflow-runs/${encodeURIComponent(runId)}/actions?action=${encodeURIComponent(action)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-loopboard-workflow-action": action,
      },
      body: JSON.stringify({ action, error }),
    },
  );

  return readApiResponse<WorkflowRun>(response);
};

export const checkProjectGitHubConnection = async (
  projectId: string,
): Promise<GitHubConnectionCheck> => {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/github/connection`,
    { cache: "no-store" },
  );

  return readApiResponse<GitHubConnectionCheck>(response);
};

export const setupProjectGitHubLabels = async (
  projectId: string,
): Promise<GitHubLabelSetupResult> =>
  writeJson<GitHubLabelSetupResult>(
    `/api/projects/${encodeURIComponent(projectId)}/github/labels`,
    {},
  );

export const fetchFeatures = async (projectId?: string): Promise<Feature[]> => {
  const params = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const response = await fetch(`/api/features${params}`, { cache: "no-store" });

  return readApiResponse<Feature[]>(response);
};

export const createFeature = async (
  input: CreateFeatureInput,
): Promise<Feature> => writeJson<Feature>("/api/features", input);

export const updateFeature = async ({
  featureId,
  input,
}: {
  featureId: string;
  input: UpdateFeatureInput;
}): Promise<Feature> =>
  patchJson<Feature>(`/api/features/${encodeURIComponent(featureId)}`, input);

export const approveFeatureArtifact = async ({
  featureId,
  artifactName,
}: {
  featureId: string;
  artifactName: FeatureApprovalArtifactName;
}): Promise<Feature> =>
  writeJson<Feature>(
    `/api/features/${encodeURIComponent(featureId)}/approvals`,
    { artifactName },
  );

export const deleteFeature = async (
  featureId: string,
): Promise<{ featureId: string }> => {
  const response = await fetch(`/api/features/${encodeURIComponent(featureId)}`, {
    method: "DELETE",
  });

  return readApiResponse<{ featureId: string }>(response);
};

export const fetchFeatureArtifactDocument = async ({
  featureId,
  artifactName,
}: {
  featureId: string;
  artifactName: FeatureArtifactName;
}): Promise<FeatureArtifactDocument> => {
  const response = await fetch(
    `/api/features/${encodeURIComponent(featureId)}/artifacts/${encodeURIComponent(artifactName)}`,
    { cache: "no-store" },
  );

  return readApiResponse<FeatureArtifactDocument>(response);
};

export const saveFeatureArtifactDocument = async ({
  featureId,
  artifactName,
  content,
}: {
  featureId: string;
  artifactName: FeatureArtifactName;
  content: string;
}): Promise<FeatureArtifactDocument> => {
  const response = await fetch(
    `/api/features/${encodeURIComponent(featureId)}/artifacts/${encodeURIComponent(artifactName)}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    },
  );

  return readApiResponse<FeatureArtifactDocument>(response);
};

export const previewSpecKitTasks = async (
  featureId: string,
): Promise<SpecKitImportPreview> =>
  writeJson<SpecKitImportPreview>(
    `/api/features/${encodeURIComponent(featureId)}/spec-kit-tasks/preview`,
    {},
  );

export const importSpecKitTasks = async ({
  featureId,
  tasks,
}: {
  featureId: string;
  tasks: SpecKitImportTaskInput[];
}): Promise<SpecKitImportResult> =>
  writeJson<SpecKitImportResult>(
    `/api/features/${encodeURIComponent(featureId)}/spec-kit-tasks/import`,
    { tasks },
  );

export const movePersistedTask = async ({
  taskId,
  toStatus,
  actor = "human",
}: {
  taskId: string;
  toStatus: KanbanStatus;
  actor?: TaskEvent["actor"];
}): Promise<PersistedTask> =>
  writeJson<PersistedTask>(`/api/tasks/${encodeURIComponent(taskId)}/move`, {
    toStatus,
    actor,
  });

export const applyPersistedTaskAction = async ({
  taskId,
  action,
  handoffNote,
}: {
  taskId: string;
  action: TaskAction;
  handoffNote?: string;
}): Promise<PersistedTask> =>
  writeJson<PersistedTask>(`/api/tasks/${encodeURIComponent(taskId)}/actions`, {
    action,
    handoffNote,
  });

export const createPersistedTaskGitHubIssue = async (
  taskId: string,
): Promise<TaskGitHubIssueActionResult> =>
  writeJson<TaskGitHubIssueActionResult>(
    `/api/tasks/${encodeURIComponent(taskId)}/github/issue`,
    {},
  );

export const syncPersistedTaskGitHubIssueLabels = async ({
  taskId,
  labels,
}: {
  taskId: string;
  labels?: string[];
}): Promise<TaskGitHubIssueLabelSyncActionResult> =>
  writeJson<TaskGitHubIssueLabelSyncActionResult>(
    `/api/tasks/${encodeURIComponent(taskId)}/github/labels`,
    labels ? { labels } : {},
  );

export const syncPersistedTaskGitHubPullRequest = async ({
  taskId,
  pullRequestUrl,
}: {
  taskId: string;
  pullRequestUrl?: string;
}): Promise<TaskGitHubPullRequestSyncActionResult> =>
  writeJson<TaskGitHubPullRequestSyncActionResult>(
    `/api/tasks/${encodeURIComponent(taskId)}/github/pr`,
    pullRequestUrl ? { pullRequestUrl } : {},
  );

export const fetchTaskContextStatus = async (
  taskId: string,
): Promise<TaskContextActionResult> => {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/context`, {
    cache: "no-store",
  });

  return readApiResponse<TaskContextActionResult>(response);
};

export const exportPersistedTaskEvents = async (
  taskId: string,
): Promise<TaskContextActionResult> =>
  writeJson<TaskContextActionResult>(
    `/api/tasks/${encodeURIComponent(taskId)}/context`,
    { action: "export-events" },
  );

export const refreshPersistedTaskHandoff = async (
  taskId: string,
): Promise<TaskContextActionResult> =>
  writeJson<TaskContextActionResult>(
    `/api/tasks/${encodeURIComponent(taskId)}/context`,
    { action: "refresh-handoff" },
  );

export const fetchPersistedTaskHandoff = async (
  taskId: string,
): Promise<HandoffDocumentActionResult> =>
  writeJson<HandoffDocumentActionResult>(
    `/api/tasks/${encodeURIComponent(taskId)}/context`,
    { action: "read-handoff" },
  );

export const savePersistedTaskHandoff = async ({
  taskId,
  content,
}: {
  taskId: string;
  content: string;
}): Promise<HandoffDocumentActionResult> =>
  writeJson<HandoffDocumentActionResult>(
    `/api/tasks/${encodeURIComponent(taskId)}/context`,
    { action: "save-handoff", content },
  );

export const generatePersistedTaskClaudeCodePrompt = async ({
  taskId,
  manualIntent,
}: {
  taskId: string;
  manualIntent?: string;
}): Promise<ClaudeCodePromptActionResult> =>
  writeJson<ClaudeCodePromptActionResult>(
    `/api/tasks/${encodeURIComponent(taskId)}/context`,
    { action: "generate-claude-prompt", manualIntent },
  );
