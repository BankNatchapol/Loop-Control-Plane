import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  KANBAN_COLUMNS,
  applyTaskAction,
  canTransitionOwner,
  createFeatureEvent,
  createTaskEvent,
  emptyFeatureArtifacts,
  moveTaskToStatus,
  normalizeGitHubDeliveryStatus,
  type Feature,
  type FeatureApprovalArtifactName,
  type FeatureArtifactStatus,
  type FeatureEvent,
  type FeatureEventType,
  type FeatureStatus,
  type GitHubState,
  type HandoffState,
  type KanbanStatus,
  type Project,
  type ProjectAutomationPolicy,
  type RiskLevel,
  type Task,
  type TaskAction,
  type TaskEvent,
  type TaskEventType,
  type TaskMode,
  type TaskOwner,
  type TaskSource,
  type Workflow,
  type WorkflowArtifact,
  type WorkflowEdge,
  type WorkflowLogEntry,
  type WorkflowNode,
  type WorkflowNodeMode,
  type WorkflowNodeState,
  type WorkflowRiskPolicy,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowRunStep,
  type WorkflowRunStepStatus,
  defaultProjectAutomationPolicy,
  defaultProjectEngineSettings,
  type ProjectEngineSettings,
} from "@/lib/loopboard";
import {
  defaultAutomationSettings,
  evaluateTaskActionPolicy,
  evaluateTaskPolicy,
  type AutomationSettings,
} from "@/lib/policies/automation-policy";
import {
  isEngineJobKind,
  isExecutorBackend,
  type EngineJob,
  type EngineJobKind,
  type EngineJobStatus,
  type EngineRunLogEntry,
  type EngineRunLogLevel,
  type EngineSchedulerState,
  type EngineSchedulerStatus,
  type ExecutorBackend,
} from "@/lib/engine/loop-engine-types";

export type MetadataValue = string | number | boolean | null;
export type EventPayload = Record<string, MetadataValue>;

export interface BoardData {
  projects: Project[];
  features: Feature[];
  tasks: PersistedTask[];
  latestWorkflowRuns: WorkflowRun[];
  automationSettings: AutomationSettings;
}

export type PersistedTask = Task & {
  dependencies: string[];
};

export interface CreateTaskInput {
  id?: string;
  projectId: string;
  featureId: string;
  title: string;
  description: string;
  status?: KanbanStatus;
  owner?: TaskOwner;
  mode?: TaskMode;
  risk?: RiskLevel;
  source?: TaskSource;
  labels?: string[];
  acceptanceCriteria?: string[];
  dependencies?: string[];
  branch?: string;
  worktree?: string;
  github?: GitHubState;
  handoff?: HandoffState;
  createdAt?: string;
}

export interface CreateProjectInput {
  id?: string;
  name: string;
  description?: string;
  repoPath: string;
  repository?: string;
  isGitRepository?: boolean;
  currentBranch?: string;
  defaultBranch?: string;
  githubRemoteUrl?: string;
  githubRepository?: string;
  specKitRoot?: string;
  specsPath?: string;
  tasksPath?: string;
  workflowsPath?: string;
  handoffsPath?: string;
  automationPolicy?: Partial<ProjectAutomationPolicy>;
  engineSettings?: Partial<ProjectEngineSettings>;
  createdAt?: string;
}

export interface CreateFeatureInput {
  id?: string;
  projectId: string;
  name: string;
  summary?: string;
  source?: TaskSource;
  artifactFolderPath?: string;
  prdPath?: string;
  specPath?: string;
  planPath?: string;
  tasksPath?: string;
  decisionsPath?: string;
  status?: FeatureStatus;
  artifacts?: FeatureArtifactStatus;
  createdAt?: string;
}

export interface UpdateFeatureInput {
  name?: string;
  summary?: string;
  source?: TaskSource;
  artifactFolderPath?: string;
  prdPath?: string;
  specPath?: string;
  planPath?: string;
  tasksPath?: string;
  decisionsPath?: string;
  status?: FeatureStatus;
  artifacts?: FeatureArtifactStatus;
  updatedAt?: string;
}

export interface ApproveFeatureArtifactInput {
  artifactName: FeatureApprovalArtifactName;
  actor?: FeatureEvent["actor"];
  message?: string;
  createdAt?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  repoPath?: string;
  repository?: string;
  isGitRepository?: boolean;
  currentBranch?: string;
  defaultBranch?: string;
  githubRemoteUrl?: string;
  githubRepository?: string;
  specKitRoot?: string;
  specsPath?: string;
  tasksPath?: string;
  workflowsPath?: string;
  handoffsPath?: string;
  automationPolicy?: Partial<ProjectAutomationPolicy>;
  engineSettings?: Partial<ProjectEngineSettings>;
  updatedAt?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  owner?: TaskOwner;
  mode?: TaskMode;
  risk?: RiskLevel;
  labels?: string[];
  acceptanceCriteria?: string[];
  dependencies?: string[];
  branch?: string;
  worktree?: string;
  github?: GitHubState;
  handoff?: HandoffState;
  actor?: TaskEvent["actor"];
  message?: string;
  updatedAt?: string;
}

export interface AppendTaskEventInput {
  type: TaskEventType;
  actor: TaskEvent["actor"];
  message: string;
  createdAt?: string;
  fromStatus?: KanbanStatus;
  toStatus?: KanbanStatus;
  fromOwner?: TaskOwner;
  toOwner?: TaskOwner;
  metadata?: EventPayload;
}

export interface AppendFeatureEventInput {
  type: FeatureEventType;
  actor: FeatureEvent["actor"];
  message: string;
  createdAt?: string;
  fromStatus?: FeatureStatus;
  toStatus?: FeatureStatus;
  metadata?: EventPayload;
}

export interface CreateWorkflowInput {
  id?: string;
  projectId: string;
  name: string;
  description?: string;
  version?: number;
  nodes?: Array<
    Omit<WorkflowNode, "workflowId" | "createdAt" | "updatedAt"> & {
      workflowId?: string;
      createdAt?: string;
      updatedAt?: string;
    }
  >;
  edges?: Array<
    Omit<WorkflowEdge, "workflowId" | "createdAt" | "updatedAt"> & {
      workflowId?: string;
      createdAt?: string;
      updatedAt?: string;
    }
  >;
  config?: Record<string, unknown>;
  createdAt?: string;
}

export interface UpdateWorkflowInput {
  name?: string;
  description?: string;
  version?: number;
  nodes?: CreateWorkflowInput["nodes"];
  edges?: CreateWorkflowInput["edges"];
  config?: Record<string, unknown>;
  updatedAt?: string;
}

export interface CreateWorkflowRunInput {
  id?: string;
  workflowId: string;
  projectId?: string;
  featureId?: string;
  status?: WorkflowRunStatus;
  currentNodeId?: string;
  inputArtifacts?: WorkflowArtifact[];
  outputArtifacts?: WorkflowArtifact[];
  executionLogs?: WorkflowLogEntry[];
  steps?: Array<
    Omit<WorkflowRunStep, "runId" | "createdAt" | "updatedAt"> & {
      runId?: string;
      createdAt?: string;
      updatedAt?: string;
    }
  >;
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
}

export interface UpdateWorkflowRunInput {
  status?: WorkflowRunStatus;
  currentNodeId?: string | null;
  inputArtifacts?: WorkflowArtifact[];
  outputArtifacts?: WorkflowArtifact[];
  executionLogs?: WorkflowLogEntry[];
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
}

export interface UpsertWorkflowRunStepInput {
  id?: string;
  workflowNodeId: string;
  status: WorkflowRunStepStatus;
  attempt?: number;
  inputArtifacts?: WorkflowArtifact[];
  outputArtifacts?: WorkflowArtifact[];
  executionLogs?: WorkflowLogEntry[];
  error?: string | null;
  requireApproval?: boolean;
  approvedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateEngineJobInput {
  id?: string;
  kind: EngineJobKind;
  status?: EngineJobStatus;
  backend: ExecutorBackend;
  projectId?: string;
  taskId?: string;
  workflowRunId?: string;
  workflowNodeId?: string;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  executionLogs?: EngineRunLogEntry[];
  error?: string;
  attempt?: number;
  maxAttempts?: number;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
}

export interface UpdateEngineJobInput {
  status?: EngineJobStatus;
  result?: Record<string, unknown> | null;
  executionLogs?: EngineRunLogEntry[];
  error?: string | null;
  attempt?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
}

export interface ListEngineJobsOptions {
  projectId?: string;
  taskId?: string;
  workflowRunId?: string;
  workflowNodeId?: string;
  kind?: EngineJobKind;
  status?: EngineJobStatus | EngineJobStatus[];
  backend?: ExecutorBackend;
  limit?: number;
}

export interface EngineJobMetricsSnapshot {
  windowHours: number;
  since: string;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  averageDurationMs: number | null;
  failureRate: number | null;
}

export interface UpdateEngineSchedulerInput {
  status?: EngineSchedulerState;
  lastTickAt?: string | null;
  tickCount?: number;
  lastError?: string | null;
  updatedAt?: string;
}

export interface EnqueueTaskRunJobInput {
  taskId: string;
  projectId: string;
  backend: ExecutorBackend;
  payload: Record<string, unknown>;
  maxAttempts?: number;
}

export interface EnqueueTaskRunJobResult {
  job: EngineJob;
  created: boolean;
}

type ProjectRow = {
  id: string;
  name: string;
  description: string;
  repository: string;
  repo_path: string;
  is_git_repository: string;
  current_branch: string;
  default_branch: string;
  github_remote_url: string;
  github_repository: string;
  spec_kit_root: string;
  specs_path: string;
  tasks_path: string;
  workflows_path: string;
  handoffs_path: string;
  automation_policy: string;
  engine_settings: string;
  created_at: string;
  updated_at: string;
};

type AppSettingRow = {
  key: string;
  value: string;
  updated_at: string;
};

type FeatureRow = {
  id: string;
  project_id: string;
  name: string;
  summary: string;
  source: TaskSource;
  artifact_folder_path: string;
  prd_path: string;
  spec_path: string;
  plan_path: string;
  tasks_path: string;
  decisions_path: string;
  status: FeatureStatus;
  artifacts: string;
  created_at: string;
  updated_at: string;
};

type FeatureEventRow = {
  id: string;
  feature_id: string;
  type: FeatureEventType;
  actor: FeatureEvent["actor"];
  message: string;
  from_status: FeatureStatus | null;
  to_status: FeatureStatus | null;
  payload: string;
  created_at: string;
};

type TaskRow = {
  id: string;
  project_id: string;
  feature_id: string;
  title: string;
  description: string;
  status: KanbanStatus;
  owner: TaskOwner;
  mode: TaskMode;
  risk: RiskLevel;
  source: TaskSource;
  labels: string;
  acceptance_criteria: string;
  dependencies: string;
  branch: string;
  worktree: string;
  github: string;
  handoff: string;
  created_at: string;
  updated_at: string;
};

type TaskEventRow = {
  id: string;
  task_id: string;
  type: TaskEventType;
  actor: TaskEvent["actor"];
  message: string;
  from_status: KanbanStatus | null;
  to_status: KanbanStatus | null;
  from_owner: TaskOwner | null;
  to_owner: TaskOwner | null;
  payload: string;
  created_at: string;
};

type WorkflowRow = {
  id: string;
  project_id: string;
  name: string;
  description: string;
  version: string;
  config: string;
  created_at: string;
  updated_at: string;
};

type WorkflowNodeRow = {
  id: string;
  workflow_id: string;
  type: string;
  name: string;
  mode: WorkflowNodeMode;
  position: string;
  input_artifacts: string;
  output_artifacts: string;
  require_approval: string;
  max_retries: string;
  risk_policy: WorkflowRiskPolicy;
  config: string;
  current_state: WorkflowNodeState;
  created_at: string;
  updated_at: string;
};

type WorkflowEdgeRow = {
  id: string;
  workflow_id: string;
  source_node_id: string;
  target_node_id: string;
  label: string;
  dashed: number;
  condition: string;
  created_at: string;
  updated_at: string;
};

type WorkflowRunRow = {
  id: string;
  workflow_id: string;
  project_id: string;
  feature_id: string | null;
  status: WorkflowRunStatus;
  current_node_id: string | null;
  input_artifacts: string;
  output_artifacts: string;
  execution_logs: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type WorkflowRunStepRow = {
  id: string;
  run_id: string;
  workflow_node_id: string;
  status: WorkflowRunStepStatus;
  attempt: string;
  input_artifacts: string;
  output_artifacts: string;
  execution_logs: string;
  error: string | null;
  require_approval: string;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type EngineJobRow = {
  id: string;
  kind: EngineJobKind;
  status: EngineJobStatus;
  backend: ExecutorBackend;
  project_id: string | null;
  task_id: string | null;
  workflow_run_id: string | null;
  workflow_node_id: string | null;
  payload: string;
  result: string | null;
  execution_logs: string;
  error: string | null;
  attempt: string;
  max_attempts: string;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type EngineSchedulerStateRow = {
  id: string;
  status: EngineSchedulerState;
  last_tick_at: string | null;
  tick_count: string;
  last_error: string | null;
  updated_at: string;
};

export class LoopBoardRepositoryError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export class NotFoundError extends LoopBoardRepositoryError {
  constructor(message: string) {
    super(message, 404, "not_found");
  }
}

export class ValidationError extends LoopBoardRepositoryError {
  constructor(message: string) {
    super(message, 400, "validation_error");
  }
}

export class UnsupportedTransitionError extends LoopBoardRepositoryError {
  constructor(message: string) {
    super(message, 409, "unsupported_transition");
  }
}

const statusIds = new Set(KANBAN_COLUMNS.map((column) => column.id));
const owners = new Set<TaskOwner>(["unassigned", "ai", "human", "pairing"]);
const modes = new Set<TaskMode>(["spec", "plan", "execute", "review", "handoff"]);
const risks = new Set<RiskLevel>(["low", "medium", "high", "critical"]);
const sources = new Set<TaskSource>(["spec-kit", "github", "manual", "playbook"]);
const featureStatuses = new Set<FeatureStatus>([
  "prd-draft",
  "spec-review",
  "spec-approved",
  "plan-review",
  "plan-approved",
  "tasks-ready",
  "in-execution",
  "done",
]);
const actors = new Set<TaskEvent["actor"]>(["system", "ai", "human"]);
const eventTypes = new Set<TaskEventType>([
  "TASK_CREATED",
  "TASK_IMPORTED",
  "TASK_MOVED",
  "OWNER_CHANGED",
  "ASSIGNED_TO_AI",
  "AI_ASSIGNED",
  "AI_PAUSED",
  "HUMAN_TAKEOVER",
  "HUMAN_CLAIMED",
  "ASSIGNED_TO_HUMAN",
  "RETURNED_TO_AI",
  "BLOCKED",
  "UNBLOCKED",
  "MARKED_DONE",
  "GITHUB_LINKED",
  "ISSUE_CREATED",
  "ISSUE_LABELS_SYNCED",
  "PR_OPENED",
  "CI_RUNNING",
  "CI_FAILED",
  "CI_PASSED",
  "REVIEW_REQUESTED",
  "REVIEW_CHANGES_REQUESTED",
  "REVIEW_APPROVED",
  "DONE",
  "AO_READY_APPROVED",
  "HANDOFF_READY",
  "WORKFLOW_STEP_COMPLETED",
  "ENGINE_PICKUP",
  "ENGINE_PICKUP_SKIPPED",
  "ENGINE_EXTERNAL_SYNC",
  "ENGINE_TASK_COMPLETED",
  "ENGINE_TASK_FAILED",
  "ENGINE_TASK_CANCELLED",
]);
const featureEventTypes = new Set<FeatureEventType>([
  "SPEC_APPROVED",
  "PLAN_APPROVED",
  "TASKS_APPROVED",
  "WORKFLOW_RUN_STARTED",
  "WORKFLOW_STEP_COMPLETED",
]);
const featureApprovalArtifactNames = new Set<FeatureApprovalArtifactName>([
  "spec",
  "plan",
  "tasks",
]);
const workflowNodeModes = new Set<WorkflowNodeMode>([
  "auto",
  "human",
  "semi",
  "disabled",
]);
const workflowRiskPolicies = new Set<WorkflowRiskPolicy>([
  "low",
  "medium",
  "high",
  "critical",
  "manual-only",
]);
const workflowNodeStates = new Set<WorkflowNodeState>([
  "idle",
  "ready",
  "running",
  "paused",
  "completed",
  "failed",
  "skipped",
]);
const workflowRunStatuses = new Set<WorkflowRunStatus>([
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
const workflowRunStepStatuses = new Set<WorkflowRunStepStatus>([
  "pending",
  "running",
  "waiting-approval",
  "completed",
  "failed",
  "skipped",
]);
const engineJobStatuses = new Set<EngineJobStatus>([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
const engineSchedulerStates = new Set<EngineSchedulerState>([
  "stopped",
  "running",
  "paused",
]);
const engineRunLogLevels = new Set<EngineRunLogLevel>(["info", "warn", "error"]);
const featureStatusRank: Record<FeatureStatus, number> = {
  "prd-draft": 0,
  "spec-review": 1,
  "spec-approved": 2,
  "plan-review": 3,
  "plan-approved": 4,
  "tasks-ready": 5,
  "in-execution": 6,
  done: 7,
};
const featureApprovalConfig: Record<
  FeatureApprovalArtifactName,
  { eventType: FeatureEventType; status: FeatureStatus; message: string }
> = {
  spec: {
    eventType: "SPEC_APPROVED",
    status: "spec-approved",
    message: "Marked spec artifact approved.",
  },
  plan: {
    eventType: "PLAN_APPROVED",
    status: "plan-approved",
    message: "Marked plan artifact approved.",
  },
  tasks: {
    eventType: "TASKS_APPROVED",
    status: "tasks-ready",
    message: "Marked tasks artifact approved.",
  },
};

const json = (value: unknown): string => JSON.stringify(value);

const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const assertNonEmptyString = (value: unknown, fieldName: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${fieldName} must be a non-empty string.`);
  }

  return value.trim();
};

const assertOptionalString = (value: unknown, fieldName: string): string => {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value !== "string") {
    throw new ValidationError(`${fieldName} must be a string.`);
  }

  return value.trim();
};

const assertOptionalBoolean = (value: unknown, fieldName: string): boolean => {
  if (typeof value !== "boolean") {
    throw new ValidationError(`${fieldName} must be a boolean.`);
  }

  return value;
};

const normalizeAutomationSettings = (
  value: unknown,
  fallback: AutomationSettings = defaultAutomationSettings,
): AutomationSettings => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }

  const input = value as Partial<AutomationSettings>;
  return {
    globalAutoRunEnabled:
      typeof input.globalAutoRunEnabled === "boolean"
        ? input.globalAutoRunEnabled
        : fallback.globalAutoRunEnabled,
  };
};

const assertAutomationSettings = (value: unknown): AutomationSettings => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("automation settings must be a JSON object.");
  }

  const input = value as Partial<AutomationSettings>;
  return {
    globalAutoRunEnabled: assertOptionalBoolean(
      input.globalAutoRunEnabled,
      "globalAutoRunEnabled",
    ),
  };
};

const normalizeProjectEngineSettings = (
  value: unknown,
  fallback: ProjectEngineSettings = defaultProjectEngineSettings,
): ProjectEngineSettings => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }

  const input = value as Partial<ProjectEngineSettings>;
  const settings: ProjectEngineSettings = { ...fallback };

  if (
    typeof input.defaultTaskBackend === "string" &&
    isExecutorBackend(input.defaultTaskBackend)
  ) {
    settings.defaultTaskBackend = input.defaultTaskBackend;
  }

  if (
    typeof input.defaultReviewBackend === "string" &&
    isExecutorBackend(input.defaultReviewBackend)
  ) {
    settings.defaultReviewBackend = input.defaultReviewBackend;
  }

  if (typeof input.autoAdvanceEnabled === "boolean") {
    settings.autoAdvanceEnabled = input.autoAdvanceEnabled;
  }

  if (input.agentOrchestrator && typeof input.agentOrchestrator === "object") {
    const ao = input.agentOrchestrator;
    settings.agentOrchestrator = {
      ...(typeof ao.enabled === "boolean" ? { enabled: ao.enabled } : {}),
      ...(typeof ao.configPath === "string" && ao.configPath.trim()
        ? { configPath: ao.configPath.trim() }
        : {}),
      ...(typeof ao.projectId === "string" && ao.projectId.trim()
        ? { projectId: ao.projectId.trim() }
        : {}),
      ...(typeof ao.dashboardUrl === "string" && ao.dashboardUrl.trim()
        ? { dashboardUrl: ao.dashboardUrl.trim() }
        : {}),
      ...(typeof ao.pollIntervalMs === "number" &&
      Number.isInteger(ao.pollIntervalMs) &&
      ao.pollIntervalMs > 0
        ? { pollIntervalMs: ao.pollIntervalMs }
        : {}),
    };
  }

  return settings;
};

const assertProjectEngineSettings = (
  value: unknown,
  fallback: ProjectEngineSettings = defaultProjectEngineSettings,
): ProjectEngineSettings => {
  if (value === undefined) {
    return fallback;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("engineSettings must be a JSON object.");
  }

  return normalizeProjectEngineSettings(value, fallback);
};

const normalizeProjectAutomationPolicy = (
  value: unknown,
  fallback: ProjectAutomationPolicy = defaultProjectAutomationPolicy,
): ProjectAutomationPolicy => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }

  const input = value as Partial<ProjectAutomationPolicy>;
  return {
    allowLowRiskAutoIssueCreation:
      typeof input.allowLowRiskAutoIssueCreation === "boolean"
        ? input.allowLowRiskAutoIssueCreation
        : fallback.allowLowRiskAutoIssueCreation,
    allowLowRiskAutoAoReadyLabeling:
      typeof input.allowLowRiskAutoAoReadyLabeling === "boolean"
        ? input.allowLowRiskAutoAoReadyLabeling
        : fallback.allowLowRiskAutoAoReadyLabeling,
    allowLowRiskAutoTaskExecution:
      typeof input.allowLowRiskAutoTaskExecution === "boolean"
        ? input.allowLowRiskAutoTaskExecution
        : fallback.allowLowRiskAutoTaskExecution,
    mediumRiskRequiresReview:
      typeof input.mediumRiskRequiresReview === "boolean"
        ? input.mediumRiskRequiresReview
        : fallback.mediumRiskRequiresReview,
    highRiskManualOnly:
      typeof input.highRiskManualOnly === "boolean"
        ? input.highRiskManualOnly
        : fallback.highRiskManualOnly,
  };
};

const assertProjectAutomationPolicy = (
  value: unknown,
  fallback: ProjectAutomationPolicy = defaultProjectAutomationPolicy,
): ProjectAutomationPolicy => {
  if (value === undefined) {
    return fallback;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("automationPolicy must be a JSON object.");
  }

  const input = value as Partial<ProjectAutomationPolicy>;
  return {
    allowLowRiskAutoIssueCreation:
      input.allowLowRiskAutoIssueCreation === undefined
        ? fallback.allowLowRiskAutoIssueCreation
        : assertOptionalBoolean(
            input.allowLowRiskAutoIssueCreation,
            "automationPolicy.allowLowRiskAutoIssueCreation",
          ),
    allowLowRiskAutoAoReadyLabeling:
      input.allowLowRiskAutoAoReadyLabeling === undefined
        ? fallback.allowLowRiskAutoAoReadyLabeling
        : assertOptionalBoolean(
            input.allowLowRiskAutoAoReadyLabeling,
            "automationPolicy.allowLowRiskAutoAoReadyLabeling",
          ),
    allowLowRiskAutoTaskExecution:
      input.allowLowRiskAutoTaskExecution === undefined
        ? fallback.allowLowRiskAutoTaskExecution
        : assertOptionalBoolean(
            input.allowLowRiskAutoTaskExecution,
            "automationPolicy.allowLowRiskAutoTaskExecution",
          ),
    mediumRiskRequiresReview:
      input.mediumRiskRequiresReview === undefined
        ? fallback.mediumRiskRequiresReview
        : assertOptionalBoolean(
            input.mediumRiskRequiresReview,
            "automationPolicy.mediumRiskRequiresReview",
          ),
    highRiskManualOnly:
      input.highRiskManualOnly === undefined
        ? fallback.highRiskManualOnly
        : assertOptionalBoolean(
            input.highRiskManualOnly,
            "automationPolicy.highRiskManualOnly",
          ),
  };
};

const assertStringArray = (value: unknown, fieldName: string): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ValidationError(`${fieldName} must be an array of strings.`);
  }

  return value;
};

const assertRecord = (
  value: unknown,
  fieldName: string,
): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${fieldName} must be a JSON object.`);
  }

  return value as Record<string, unknown>;
};

const assertNonNegativeInteger = (
  value: unknown,
  fieldName: string,
): number => {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new ValidationError(`${fieldName} must be a non-negative integer.`);
  }

  return Number(value);
};

const assertPositiveInteger = (value: unknown, fieldName: string): number => {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new ValidationError(`${fieldName} must be a positive integer.`);
  }

  return Number(value);
};

const assertStatus = (value: unknown, fieldName = "status"): KanbanStatus => {
  if (typeof value !== "string" || !statusIds.has(value as KanbanStatus)) {
    throw new ValidationError(`${fieldName} is not a supported board status.`);
  }

  return value as KanbanStatus;
};

const assertOwner = (value: unknown, fieldName = "owner"): TaskOwner => {
  if (typeof value !== "string" || !owners.has(value as TaskOwner)) {
    throw new ValidationError(`${fieldName} is not a supported task owner.`);
  }

  return value as TaskOwner;
};

const assertMode = (value: unknown): TaskMode => {
  if (typeof value !== "string" || !modes.has(value as TaskMode)) {
    throw new ValidationError("mode is not supported.");
  }

  return value as TaskMode;
};

const assertRisk = (value: unknown): RiskLevel => {
  if (typeof value !== "string" || !risks.has(value as RiskLevel)) {
    throw new ValidationError("risk is not supported.");
  }

  return value as RiskLevel;
};

const assertSource = (value: unknown): TaskSource => {
  if (typeof value !== "string" || !sources.has(value as TaskSource)) {
    throw new ValidationError("source is not supported.");
  }

  return value as TaskSource;
};

const assertFeatureStatus = (value: unknown): FeatureStatus => {
  if (typeof value !== "string" || !featureStatuses.has(value as FeatureStatus)) {
    throw new ValidationError("feature status is not supported.");
  }

  return value as FeatureStatus;
};

const assertFeatureApprovalArtifactName = (
  value: unknown,
): FeatureApprovalArtifactName => {
  if (
    typeof value !== "string" ||
    !featureApprovalArtifactNames.has(value as FeatureApprovalArtifactName)
  ) {
    throw new ValidationError("artifactName is not a supported approval artifact.");
  }

  return value as FeatureApprovalArtifactName;
};

const assertActor = (value: unknown): TaskEvent["actor"] => {
  if (typeof value !== "string" || !actors.has(value as TaskEvent["actor"])) {
    throw new ValidationError("actor is not supported.");
  }

  return value as TaskEvent["actor"];
};

const assertEventType = (value: unknown): TaskEventType => {
  if (typeof value !== "string" || !eventTypes.has(value as TaskEventType)) {
    throw new ValidationError("event type is not supported.");
  }

  return value as TaskEventType;
};

const assertFeatureEventType = (value: unknown): FeatureEventType => {
  if (typeof value !== "string" || !featureEventTypes.has(value as FeatureEventType)) {
    throw new ValidationError("feature event type is not supported.");
  }

  return value as FeatureEventType;
};

const assertWorkflowNodeMode = (value: unknown): WorkflowNodeMode => {
  if (
    typeof value !== "string" ||
    !workflowNodeModes.has(value as WorkflowNodeMode)
  ) {
    throw new ValidationError("workflow node mode is not supported.");
  }

  return value as WorkflowNodeMode;
};

const assertWorkflowRiskPolicy = (value: unknown): WorkflowRiskPolicy => {
  if (
    typeof value !== "string" ||
    !workflowRiskPolicies.has(value as WorkflowRiskPolicy)
  ) {
    throw new ValidationError("workflow risk policy is not supported.");
  }

  return value as WorkflowRiskPolicy;
};

const assertWorkflowNodeState = (value: unknown): WorkflowNodeState => {
  if (
    typeof value !== "string" ||
    !workflowNodeStates.has(value as WorkflowNodeState)
  ) {
    throw new ValidationError("workflow node state is not supported.");
  }

  return value as WorkflowNodeState;
};

const assertWorkflowRunStatus = (value: unknown): WorkflowRunStatus => {
  if (
    typeof value !== "string" ||
    !workflowRunStatuses.has(value as WorkflowRunStatus)
  ) {
    throw new ValidationError("workflow run status is not supported.");
  }

  return value as WorkflowRunStatus;
};

const assertWorkflowRunStepStatus = (
  value: unknown,
): WorkflowRunStepStatus => {
  if (
    typeof value !== "string" ||
    !workflowRunStepStatuses.has(value as WorkflowRunStepStatus)
  ) {
    throw new ValidationError("workflow run step status is not supported.");
  }

  return value as WorkflowRunStepStatus;
};

const assertEngineJobKind = (value: unknown): EngineJobKind => {
  if (!isEngineJobKind(value)) {
    throw new ValidationError("engine job kind is not supported.");
  }

  return value;
};

const assertEngineJobStatus = (value: unknown): EngineJobStatus => {
  if (typeof value !== "string" || !engineJobStatuses.has(value as EngineJobStatus)) {
    throw new ValidationError("engine job status is not supported.");
  }

  return value as EngineJobStatus;
};

const assertExecutorBackend = (value: unknown): ExecutorBackend => {
  if (!isExecutorBackend(value)) {
    throw new ValidationError("executor backend is not supported.");
  }

  return value;
};

const assertEngineSchedulerState = (value: unknown): EngineSchedulerState => {
  if (
    typeof value !== "string" ||
    !engineSchedulerStates.has(value as EngineSchedulerState)
  ) {
    throw new ValidationError("engine scheduler state is not supported.");
  }

  return value as EngineSchedulerState;
};

const assertEngineRunLogs = (
  value: unknown,
  fieldName: string,
): EngineRunLogEntry[] => {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${fieldName} must be an array.`);
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ValidationError(`${fieldName}[${index}] must be an object.`);
    }

    const record = entry as Record<string, unknown>;
    if (typeof record.timestamp !== "string" || record.timestamp.length === 0) {
      throw new ValidationError(`${fieldName}[${index}].timestamp must be a string.`);
    }

    if (
      typeof record.level !== "string" ||
      !engineRunLogLevels.has(record.level as EngineRunLogLevel)
    ) {
      throw new ValidationError(`${fieldName}[${index}].level is not supported.`);
    }

    if (typeof record.message !== "string") {
      throw new ValidationError(`${fieldName}[${index}].message must be a string.`);
    }

    return {
      timestamp: record.timestamp,
      level: record.level as EngineRunLogLevel,
      message: record.message,
      ...(record.metadata !== undefined
        ? { metadata: assertRecord(record.metadata, `${fieldName}[${index}].metadata`) }
        : {}),
    };
  });
};

const assertWorkflowPosition = (
  value: unknown,
): WorkflowNode["position"] => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { x?: unknown }).x !== "number" ||
    typeof (value as { y?: unknown }).y !== "number"
  ) {
    throw new ValidationError("workflow node position must include numeric x and y.");
  }

  return {
    x: (value as { x: number }).x,
    y: (value as { y: number }).y,
  };
};

const assertWorkflowArtifacts = (
  value: unknown,
  fieldName: string,
): WorkflowArtifact[] => {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${fieldName} must be an array of workflow artifacts.`);
  }

  return value.map((artifact, index) => {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new ValidationError(`${fieldName}[${index}] must be a workflow artifact.`);
    }

    const item = artifact as Partial<WorkflowArtifact>;
    return {
      name: assertNonEmptyString(item.name, `${fieldName}[${index}].name`),
      path: assertNonEmptyString(item.path, `${fieldName}[${index}].path`),
      required: Boolean(item.required),
      description: item.description
        ? assertOptionalString(item.description, `${fieldName}[${index}].description`)
        : undefined,
    };
  });
};

const assertWorkflowLogs = (
  value: unknown,
  fieldName: string,
): WorkflowLogEntry[] => {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${fieldName} must be an array of workflow log entries.`);
  }

  return value.map((log, index) => {
    if (!log || typeof log !== "object" || Array.isArray(log)) {
      throw new ValidationError(`${fieldName}[${index}] must be a workflow log entry.`);
    }

    const item = log as Partial<WorkflowLogEntry>;
    const level = item.level ?? "info";
    if (!["debug", "info", "warn", "error"].includes(level)) {
      throw new ValidationError(`${fieldName}[${index}].level is not supported.`);
    }

    return {
      timestamp: assertNonEmptyString(
        item.timestamp,
        `${fieldName}[${index}].timestamp`,
      ),
      level,
      message: assertNonEmptyString(item.message, `${fieldName}[${index}].message`),
      metadata: item.metadata ? sanitizePayload(item.metadata) : undefined,
    };
  });
};

const sanitizePayload = (value: unknown): EventPayload => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, MetadataValue] => {
      const item = entry[1];
      return (
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean" ||
        item === null
      );
    }),
  );
};

const projectFromRow = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  description: row.description,
  repository: row.repository,
  repoPath: row.repo_path,
  isGitRepository: row.is_git_repository === "true",
  currentBranch: row.current_branch,
  defaultBranch: row.default_branch,
  githubRemoteUrl: row.github_remote_url,
  githubRepository: row.github_repository ?? "",
  specKitRoot: row.spec_kit_root,
  specsPath: row.specs_path,
  tasksPath: row.tasks_path,
  workflowsPath: row.workflows_path,
  handoffsPath: row.handoffs_path,
  automationPolicy: normalizeProjectAutomationPolicy(
    parseJson<ProjectAutomationPolicy>(
      row.automation_policy,
      defaultProjectAutomationPolicy,
    ),
  ),
  engineSettings: normalizeProjectEngineSettings(
    parseJson<ProjectEngineSettings>(
      row.engine_settings,
      defaultProjectEngineSettings,
    ),
  ),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const featureFromRow = (row: FeatureRow): Feature => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  summary: row.summary,
  source: row.source,
  artifactFolderPath: row.artifact_folder_path,
  prdPath: row.prd_path,
  specPath: row.spec_path,
  planPath: row.plan_path,
  tasksPath: row.tasks_path,
  decisionsPath: row.decisions_path,
  status: row.status,
  artifacts: parseJson<FeatureArtifactStatus>(
    row.artifacts,
    emptyFeatureArtifacts({
      prd: row.prd_path,
      spec: row.spec_path,
      plan: row.plan_path,
      tasks: row.tasks_path,
      decisions: row.decisions_path,
    }),
  ),
  events: [],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const featureEventFromRow = (row: FeatureEventRow): FeatureEvent => {
  const payload = parseJson<EventPayload>(row.payload, {});

  return {
    id: row.id,
    featureId: row.feature_id,
    type: row.type,
    actor: row.actor,
    message: row.message,
    createdAt: row.created_at,
    fromStatus: row.from_status ?? undefined,
    toStatus: row.to_status ?? undefined,
    metadata: Object.keys(payload).length > 0 ? payload : undefined,
  };
};

const eventFromRow = (row: TaskEventRow): TaskEvent => {
  const payload = parseJson<EventPayload>(row.payload, {});

  return {
    id: row.id,
    taskId: row.task_id,
    type: row.type,
    actor: row.actor,
    message: row.message,
    createdAt: row.created_at,
    fromStatus: row.from_status ?? undefined,
    toStatus: row.to_status ?? undefined,
    fromOwner: row.from_owner ?? undefined,
    toOwner: row.to_owner ?? undefined,
    metadata: Object.keys(payload).length > 0 ? payload : undefined,
  };
};

const taskFromRow = (row: TaskRow, events: TaskEvent[]): PersistedTask => ({
  id: row.id,
  projectId: row.project_id,
  featureId: row.feature_id,
  title: row.title,
  description: row.description,
  status: row.status,
  owner: row.owner,
  mode: row.mode,
  risk: row.risk,
  source: row.source,
  labels: parseJson<string[]>(row.labels, []),
  acceptanceCriteria: parseJson<string[]>(row.acceptance_criteria, []),
  dependencies: parseJson<string[]>(row.dependencies, []),
  branch: row.branch,
  worktree: row.worktree,
  github: parseJson<GitHubState>(row.github, {}),
  handoff: parseJson<HandoffState>(row.handoff, {
    available: false,
    contextPaths: [],
  }),
  events,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const workflowNodeFromRow = (row: WorkflowNodeRow): WorkflowNode => ({
  id: row.id,
  workflowId: row.workflow_id,
  type: row.type,
  name: row.name,
  mode: row.mode,
  position: parseJson<WorkflowNode["position"]>(row.position, { x: 0, y: 0 }),
  inputArtifacts: parseJson<WorkflowArtifact[]>(row.input_artifacts, []),
  outputArtifacts: parseJson<WorkflowArtifact[]>(row.output_artifacts, []),
  requireApproval: row.require_approval === "true",
  maxRetries: Number(row.max_retries),
  riskPolicy: row.risk_policy,
  config: parseJson<Record<string, unknown>>(row.config, {}),
  currentState: row.current_state,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const workflowEdgeFromRow = (row: WorkflowEdgeRow): WorkflowEdge => ({
  id: row.id,
  workflowId: row.workflow_id,
  sourceNodeId: row.source_node_id,
  targetNodeId: row.target_node_id,
  label: row.label,
  ...(row.dashed ? { dashed: true } : {}),
  condition: parseJson<Record<string, unknown>>(row.condition, {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const workflowFromRow = (
  row: WorkflowRow,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): Workflow => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  description: row.description,
  version: Number(row.version),
  nodes,
  edges,
  config: parseJson<Record<string, unknown>>(row.config, {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const workflowRunStepFromRow = (row: WorkflowRunStepRow): WorkflowRunStep => ({
  id: row.id,
  runId: row.run_id,
  workflowNodeId: row.workflow_node_id,
  status: row.status,
  attempt: Number(row.attempt),
  inputArtifacts: parseJson<WorkflowArtifact[]>(row.input_artifacts, []),
  outputArtifacts: parseJson<WorkflowArtifact[]>(row.output_artifacts, []),
  executionLogs: parseJson<WorkflowLogEntry[]>(row.execution_logs, []),
  error: row.error ?? undefined,
  requireApproval: row.require_approval === "true",
  approvedAt: row.approved_at ?? undefined,
  startedAt: row.started_at ?? undefined,
  completedAt: row.completed_at ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const workflowRunFromRow = (
  row: WorkflowRunRow,
  steps: WorkflowRunStep[],
): WorkflowRun => ({
  id: row.id,
  workflowId: row.workflow_id,
  projectId: row.project_id,
  featureId: row.feature_id ?? undefined,
  status: row.status,
  currentNodeId: row.current_node_id ?? undefined,
  inputArtifacts: parseJson<WorkflowArtifact[]>(row.input_artifacts, []),
  outputArtifacts: parseJson<WorkflowArtifact[]>(row.output_artifacts, []),
  executionLogs: parseJson<WorkflowLogEntry[]>(row.execution_logs, []),
  steps,
  startedAt: row.started_at ?? undefined,
  completedAt: row.completed_at ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const engineJobFromRow = (row: EngineJobRow): EngineJob => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  backend: row.backend,
  projectId: row.project_id ?? undefined,
  taskId: row.task_id ?? undefined,
  workflowRunId: row.workflow_run_id ?? undefined,
  workflowNodeId: row.workflow_node_id ?? undefined,
  payload: parseJson<Record<string, unknown>>(row.payload, {}),
  result: row.result
    ? parseJson<Record<string, unknown>>(row.result, {})
    : undefined,
  executionLogs: parseJson<EngineRunLogEntry[]>(row.execution_logs, []),
  error: row.error ?? undefined,
  attempt: Number(row.attempt),
  maxAttempts: Number(row.max_attempts),
  queuedAt: row.queued_at,
  startedAt: row.started_at ?? undefined,
  completedAt: row.completed_at ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const engineSchedulerFromRow = (
  row: EngineSchedulerStateRow,
): EngineSchedulerStatus => ({
  status: row.status,
  lastTickAt: row.last_tick_at ?? undefined,
  tickCount: Number(row.tick_count),
  lastError: row.last_error ?? undefined,
  updatedAt: row.updated_at,
});

export class LoopBoardRepository {
  constructor(private readonly database: DatabaseSync) {}

  getAutomationSettings(): AutomationSettings {
    const row = this.database
      .prepare("SELECT * FROM app_settings WHERE key = ?")
      .get("automation") as AppSettingRow | undefined;

    if (!row) {
      return defaultAutomationSettings;
    }

    return normalizeAutomationSettings(
      parseJson<AutomationSettings>(row.value, defaultAutomationSettings),
    );
  }

  updateAutomationSettings(input: Partial<AutomationSettings>): AutomationSettings {
    const currentSettings = this.getAutomationSettings();
    const settings = assertAutomationSettings({
      ...currentSettings,
      ...input,
    });
    const updatedAt = new Date().toISOString();

    this.database
      .prepare(
        `
          INSERT INTO app_settings (key, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `,
      )
      .run("automation", json(settings), updatedAt);

    return this.getAutomationSettings();
  }

  listProjects(): Project[] {
    const rows = this.database
      .prepare("SELECT * FROM projects ORDER BY created_at")
      .all() as ProjectRow[];

    return rows.map(projectFromRow);
  }

  getProject(projectId: string): Project {
    const row = this.database
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(projectId) as ProjectRow | undefined;

    if (!row) {
      throw new NotFoundError(`Project "${projectId}" was not found.`);
    }

    return projectFromRow(row);
  }

  createProject(input: CreateProjectInput): Project {
    const now = input.createdAt ?? new Date().toISOString();
    const project: Project = {
      id: input.id ?? `project-${randomUUID()}`,
      name: assertNonEmptyString(input.name, "name"),
      description: assertOptionalString(input.description, "description"),
      repository: assertOptionalString(input.repository, "repository"),
      repoPath: assertNonEmptyString(input.repoPath, "repoPath"),
      isGitRepository: Boolean(input.isGitRepository),
      currentBranch: assertOptionalString(input.currentBranch, "currentBranch"),
      defaultBranch: assertOptionalString(input.defaultBranch, "defaultBranch"),
      githubRemoteUrl: assertOptionalString(input.githubRemoteUrl, "githubRemoteUrl"),
      githubRepository: assertOptionalString(input.githubRepository, "githubRepository"),
      specKitRoot: assertOptionalString(input.specKitRoot, "specKitRoot"),
      specsPath: assertOptionalString(input.specsPath, "specsPath") || "specs",
      tasksPath: assertOptionalString(input.tasksPath, "tasksPath") || "tasks",
      workflowsPath:
        assertOptionalString(input.workflowsPath, "workflowsPath") || "workflows",
      handoffsPath:
        assertOptionalString(input.handoffsPath, "handoffsPath") || "handoffs",
      automationPolicy: assertProjectAutomationPolicy(input.automationPolicy),
      engineSettings: assertProjectEngineSettings(input.engineSettings),
      createdAt: now,
      updatedAt: now,
    };

    this.insertProject(project);

    return this.getProject(project.id);
  }

  updateProject(projectId: string, input: UpdateProjectInput): Project {
    const project = this.getProject(projectId);
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const nextProject: Project = {
      ...project,
      name:
        input.name === undefined
          ? project.name
          : assertNonEmptyString(input.name, "name"),
      description:
        input.description === undefined
          ? project.description
          : assertOptionalString(input.description, "description"),
      repository:
        input.repository === undefined
          ? project.repository
          : assertOptionalString(input.repository, "repository"),
      repoPath:
        input.repoPath === undefined
          ? project.repoPath
          : assertNonEmptyString(input.repoPath, "repoPath"),
      isGitRepository:
        input.isGitRepository === undefined
          ? project.isGitRepository
          : Boolean(input.isGitRepository),
      currentBranch:
        input.currentBranch === undefined
          ? project.currentBranch
          : assertOptionalString(input.currentBranch, "currentBranch"),
      defaultBranch:
        input.defaultBranch === undefined
          ? project.defaultBranch
          : assertOptionalString(input.defaultBranch, "defaultBranch"),
      githubRemoteUrl:
        input.githubRemoteUrl === undefined
          ? project.githubRemoteUrl
          : assertOptionalString(input.githubRemoteUrl, "githubRemoteUrl"),
      githubRepository:
        input.githubRepository === undefined
          ? project.githubRepository
          : assertOptionalString(input.githubRepository, "githubRepository"),
      specKitRoot:
        input.specKitRoot === undefined
          ? project.specKitRoot
          : assertOptionalString(input.specKitRoot, "specKitRoot"),
      specsPath:
        input.specsPath === undefined
          ? project.specsPath
          : assertOptionalString(input.specsPath, "specsPath"),
      tasksPath:
        input.tasksPath === undefined
          ? project.tasksPath
          : assertOptionalString(input.tasksPath, "tasksPath"),
      workflowsPath:
        input.workflowsPath === undefined
          ? project.workflowsPath
          : assertOptionalString(input.workflowsPath, "workflowsPath"),
      handoffsPath:
        input.handoffsPath === undefined
          ? project.handoffsPath
          : assertOptionalString(input.handoffsPath, "handoffsPath"),
      automationPolicy: assertProjectAutomationPolicy(
        input.automationPolicy,
        project.automationPolicy,
      ),
      engineSettings: assertProjectEngineSettings(
        input.engineSettings,
        project.engineSettings,
      ),
      updatedAt,
    };

    this.updateProjectRow(nextProject);

    return this.getProject(projectId);
  }

  deleteProject(projectId: string): void {
    this.getProject(projectId);
    this.database.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  }

  listFeatures(projectId?: string): Feature[] {
    const rows = projectId
      ? this.database
          .prepare("SELECT * FROM features WHERE project_id = ? ORDER BY created_at")
          .all(projectId)
      : this.database.prepare("SELECT * FROM features ORDER BY created_at").all();

    return (rows as FeatureRow[]).map((row) =>
      this.featureWithEvents(featureFromRow(row)),
    );
  }

  getFeature(featureId: string): Feature {
    const row = this.database
      .prepare("SELECT * FROM features WHERE id = ?")
      .get(featureId) as FeatureRow | undefined;

    if (!row) {
      throw new NotFoundError(`Feature "${featureId}" was not found.`);
    }

    return this.featureWithEvents(featureFromRow(row));
  }

  createFeature(input: CreateFeatureInput): Feature {
    this.getProject(assertNonEmptyString(input.projectId, "projectId"));
    const now = input.createdAt ?? new Date().toISOString();
    const feature: Feature = {
      id: input.id ?? `feature-${randomUUID()}`,
      projectId: assertNonEmptyString(input.projectId, "projectId"),
      name: assertNonEmptyString(input.name, "name"),
      summary: assertOptionalString(input.summary, "summary"),
      source: input.source ? assertSource(input.source) : "manual",
      artifactFolderPath: assertOptionalString(
        input.artifactFolderPath,
        "artifactFolderPath",
      ),
      prdPath: assertOptionalString(input.prdPath, "prdPath"),
      specPath: assertOptionalString(input.specPath, "specPath"),
      planPath: assertOptionalString(input.planPath, "planPath"),
      tasksPath: assertOptionalString(input.tasksPath, "tasksPath"),
      decisionsPath: assertOptionalString(input.decisionsPath, "decisionsPath"),
      status: input.status ? assertFeatureStatus(input.status) : "prd-draft",
      artifacts:
        input.artifacts ??
        emptyFeatureArtifacts({
          prd: input.prdPath ?? "",
          spec: input.specPath ?? "",
          plan: input.planPath ?? "",
          tasks: input.tasksPath ?? "",
          decisions: input.decisionsPath ?? "",
        }),
      events: [],
      createdAt: now,
      updatedAt: now,
    };

    this.insertFeature(feature);

    return this.getFeature(feature.id);
  }

  updateFeature(featureId: string, input: UpdateFeatureInput): Feature {
    const feature = this.getFeature(featureId);
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const nextFeature: Feature = {
      ...feature,
      name:
        input.name === undefined
          ? feature.name
          : assertNonEmptyString(input.name, "name"),
      summary:
        input.summary === undefined
          ? feature.summary
          : assertOptionalString(input.summary, "summary"),
      source: input.source ? assertSource(input.source) : feature.source,
      artifactFolderPath:
        input.artifactFolderPath === undefined
          ? feature.artifactFolderPath
          : assertOptionalString(input.artifactFolderPath, "artifactFolderPath"),
      prdPath:
        input.prdPath === undefined
          ? feature.prdPath
          : assertOptionalString(input.prdPath, "prdPath"),
      specPath:
        input.specPath === undefined
          ? feature.specPath
          : assertOptionalString(input.specPath, "specPath"),
      planPath:
        input.planPath === undefined
          ? feature.planPath
          : assertOptionalString(input.planPath, "planPath"),
      tasksPath:
        input.tasksPath === undefined
          ? feature.tasksPath
          : assertOptionalString(input.tasksPath, "tasksPath"),
      decisionsPath:
        input.decisionsPath === undefined
          ? feature.decisionsPath
          : assertOptionalString(input.decisionsPath, "decisionsPath"),
      status: input.status ? assertFeatureStatus(input.status) : feature.status,
      artifacts: input.artifacts ?? feature.artifacts,
      updatedAt,
    };

    this.updateFeatureRow(nextFeature);

    return this.getFeature(feature.id);
  }

  approveFeatureArtifact(
    featureId: string,
    input: ApproveFeatureArtifactInput,
  ): Feature {
    const feature = this.getFeature(featureId);
    const artifactName = assertFeatureApprovalArtifactName(input.artifactName);
    const config = featureApprovalConfig[artifactName];

    if (featureStatusRank[feature.status] >= featureStatusRank[config.status]) {
      return feature;
    }

    const updatedAt = input.createdAt ?? new Date().toISOString();
    const nextFeature: Feature = {
      ...feature,
      status: config.status,
      updatedAt,
    };
    const event = createFeatureEvent({
      featureId: feature.id,
      type: assertFeatureEventType(config.eventType),
      actor: input.actor ? assertActor(input.actor) : "human",
      message: input.message ?? config.message,
      createdAt: updatedAt,
      fromStatus: feature.status,
      toStatus: nextFeature.status,
      metadata: { artifactName },
    });

    this.inTransaction(() => {
      this.updateFeatureRow(nextFeature);
      this.insertFeatureEvent(event);
    });

    return this.getFeature(feature.id);
  }

  deleteFeature(featureId: string): void {
    this.getFeature(featureId);
    this.database.prepare("DELETE FROM features WHERE id = ?").run(featureId);
  }

  listBoardData(projectId?: string): BoardData {
    const projects = projectId
      ? this.database
          .prepare("SELECT * FROM projects WHERE id = ? ORDER BY created_at")
          .all(projectId)
      : this.database.prepare("SELECT * FROM projects ORDER BY created_at").all();

    if (projectId && projects.length === 0) {
      throw new NotFoundError(`Project "${projectId}" was not found.`);
    }

    const features = projectId
      ? this.database
          .prepare("SELECT * FROM features WHERE project_id = ? ORDER BY created_at")
          .all(projectId)
      : this.database.prepare("SELECT * FROM features ORDER BY created_at").all();
    const taskRows = projectId
      ? this.database
          .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at")
          .all(projectId)
      : this.database.prepare("SELECT * FROM tasks ORDER BY created_at").all();

    const projectModels = (projects as ProjectRow[]).map(projectFromRow);

    return {
      projects: projectModels,
      features: (features as FeatureRow[]).map((row) =>
        this.featureWithEvents(featureFromRow(row)),
      ),
      tasks: (taskRows as TaskRow[]).map((row) =>
        taskFromRow(row, this.listTaskEvents(row.id)),
      ),
      latestWorkflowRuns: projectModels
        .map((project) => this.latestWorkflowRunForProject(project.id))
        .filter((run): run is WorkflowRun => Boolean(run)),
      automationSettings: this.getAutomationSettings(),
    };
  }

  getTask(taskId: string): PersistedTask {
    const row = this.database
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(taskId) as TaskRow | undefined;

    if (!row) {
      throw new NotFoundError(`Task "${taskId}" was not found.`);
    }

    return taskFromRow(row, this.listTaskEvents(taskId));
  }

  createTask(input: CreateTaskInput): PersistedTask {
    const now = input.createdAt ?? new Date().toISOString();
    const task: PersistedTask = {
      id: input.id ?? `task-${randomUUID()}`,
      projectId: assertNonEmptyString(input.projectId, "projectId"),
      featureId: assertNonEmptyString(input.featureId, "featureId"),
      title: assertNonEmptyString(input.title, "title"),
      description: assertNonEmptyString(input.description, "description"),
      status: input.status ? assertStatus(input.status) : "backlog",
      owner: input.owner ? assertOwner(input.owner) : "unassigned",
      mode: input.mode ? assertMode(input.mode) : "spec",
      risk: input.risk ? assertRisk(input.risk) : "low",
      source: input.source ? assertSource(input.source) : "manual",
      labels: input.labels ? assertStringArray(input.labels, "labels") : [],
      acceptanceCriteria: input.acceptanceCriteria
        ? assertStringArray(input.acceptanceCriteria, "acceptanceCriteria")
        : [],
      dependencies: input.dependencies
        ? assertStringArray(input.dependencies, "dependencies")
        : [],
      branch: input.branch ?? "",
      worktree: input.worktree ?? "",
      github: input.github ?? {},
      handoff: input.handoff ?? { available: false, contextPaths: [] },
      events: [],
      createdAt: now,
      updatedAt: now,
    };
    const createdEvent = createTaskEvent({
      taskId: task.id,
      type: "TASK_CREATED",
      actor: "human",
      message: "Created task in local LoopBoard.",
      createdAt: now,
      toStatus: task.status,
      toOwner: task.owner,
    });

    this.assertProjectFeaturePair(task.projectId, task.featureId);
    this.inTransaction(() => {
      this.insertTask(task);
      this.insertTaskEvent(createdEvent);
    });

    return this.getTask(task.id);
  }

  updateTask(taskId: string, input: UpdateTaskInput): PersistedTask {
    const task = this.getTask(taskId);
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const nextOwner = input.owner ? assertOwner(input.owner) : task.owner;

    if (
      nextOwner !== task.owner &&
      !canTransitionOwner(task.owner, nextOwner)
    ) {
      throw new UnsupportedTransitionError(
        `Task owner cannot transition from "${task.owner}" to "${nextOwner}".`,
      );
    }

    const nextTask: PersistedTask = {
      ...task,
      title:
        input.title === undefined
          ? task.title
          : assertNonEmptyString(input.title, "title"),
      description:
        input.description === undefined
          ? task.description
          : assertNonEmptyString(input.description, "description"),
      owner: nextOwner,
      mode: input.mode ? assertMode(input.mode) : task.mode,
      risk: input.risk ? assertRisk(input.risk) : task.risk,
      labels:
        input.labels === undefined
          ? task.labels
          : assertStringArray(input.labels, "labels"),
      acceptanceCriteria:
        input.acceptanceCriteria === undefined
          ? task.acceptanceCriteria
          : assertStringArray(input.acceptanceCriteria, "acceptanceCriteria"),
      dependencies:
        input.dependencies === undefined
          ? task.dependencies
          : assertStringArray(input.dependencies, "dependencies"),
      branch: input.branch === undefined ? task.branch : input.branch,
      worktree: input.worktree === undefined ? task.worktree : input.worktree,
      github: input.github === undefined ? task.github : input.github,
      handoff: input.handoff === undefined ? task.handoff : input.handoff,
      updatedAt,
    };
    const changedFields = changedTaskFields(task, nextTask);

    if (changedFields.length === 0) {
      return task;
    }

    const event = createTaskEvent({
      taskId: task.id,
      type: "OWNER_CHANGED",
      actor: input.actor ? assertActor(input.actor) : "human",
      message:
        input.message ??
        `Updated task ${changedFields.length === 1 ? "field" : "fields"}: ${changedFields.join(", ")}.`,
      createdAt: updatedAt,
      fromOwner: task.owner,
      toOwner: nextTask.owner,
      metadata: { changedFields: changedFields.join(",") },
    });

    this.inTransaction(() => {
      this.updateTaskRow(nextTask);
      this.insertTaskEvent(event);
    });

    return this.getTask(task.id);
  }

  moveTask(
    taskId: string,
    toStatus: KanbanStatus,
    actor: TaskEvent["actor"] = "human",
  ): PersistedTask {
    const task = this.getTask(taskId);
    const status = assertStatus(toStatus, "toStatus");
    const eventActor = assertActor(actor);
    const moved = moveTaskToStatus({ task, toStatus: status, actor: eventActor });

    if (moved === task) {
      return task;
    }

    const newEvents = moved.events.slice(task.events.length);
    this.inTransaction(() => {
      this.updateTaskRow({ ...task, status: moved.status, updatedAt: moved.updatedAt });
      for (const event of newEvents) {
        this.insertTaskEvent(event);
      }
    });

    return this.getTask(task.id);
  }

  applyTaskAction(taskId: string, action: TaskAction): PersistedTask {
    const task = this.getTask(taskId);
    const project = this.getProject(task.projectId);
    const updatedAt = new Date().toISOString();
    const policy = evaluateTaskActionPolicy({
      action,
      task,
      approved: action === "approve-ao-ready",
      automationSettings: this.getAutomationSettings(),
      projectPolicy: project.automationPolicy,
    });

    if (policy.kind === "deny") {
      throw new ValidationError(policy.message);
    }

    if (action === "mark-ao-ready" && policy.kind === "requires-approval") {
      throw new ValidationError(policy.message);
    }

    if (
      action === "remove-ao-ready" &&
      !task.github.issueNumber &&
      !task.github.issueUrl
    ) {
      throw new ValidationError("Removing AO ready requires a linked GitHub issue.");
    }

    const updated = applyTaskAction({
      task,
      action,
      createdAt: updatedAt,
    }) as PersistedTask;
    const labelReadyTask =
      action === "assign-ai" || action === "approve-ao-ready"
        ? applyAoReadyLabelForRiskPolicy({
            task: updated,
            updatedAt,
            automationSettings: this.getAutomationSettings(),
            projectPolicy: project.automationPolicy,
          })
        : updated;
    const newEvents = updated.events.slice(task.events.length);
    const labelEvents = labelReadyTask.events.slice(updated.events.length);

    this.inTransaction(() => {
      if (labelReadyTask !== task) {
        this.updateTaskRow(labelReadyTask);
      }

      for (const event of [...newEvents, ...labelEvents]) {
        this.insertTaskEvent(event);
      }
    });

    return this.getTask(task.id);
  }

  syncTaskGitHubIssueLabels(
    taskId: string,
    input: {
      issueLabels: string[];
      syncedAt?: string;
      actor?: TaskEvent["actor"];
      message?: string;
    },
  ): PersistedTask {
    const task = this.getTask(taskId);
    const syncedAt = input.syncedAt ?? new Date().toISOString();
    const issueLabels = assertStringArray(input.issueLabels, "issueLabels");
    const actor = input.actor ? assertActor(input.actor) : "system";
    const message =
      input.message ?? "Synced linked GitHub issue labels with LoopBoard state.";

    if (!hasLinkedGitHubIssue(task)) {
      throw new ValidationError("Syncing GitHub issue labels requires a linked issue.");
    }

    const nextTask: PersistedTask = {
      ...task,
      github: {
        ...task.github,
        issueLabels,
        issueLastSyncedAt: syncedAt,
      },
      updatedAt: syncedAt,
    };

    if (
      JSON.stringify(task.github.issueLabels ?? []) === JSON.stringify(issueLabels) &&
      task.github.issueLastSyncedAt === syncedAt
    ) {
      return task;
    }

    const event = createTaskEvent({
      taskId: task.id,
      type: "ISSUE_LABELS_SYNCED",
      actor,
      message,
      createdAt: syncedAt,
      metadata: {
        issueNumber: task.github.issueNumber ?? null,
        issueLabels: issueLabels.join(","),
      },
    });

    this.inTransaction(() => {
      this.updateTaskRow(nextTask);
      this.insertTaskEvent(event);
    });

    return this.getTask(task.id);
  }

  syncTaskGitHubPullRequest(
    taskId: string,
    input: {
      github: GitHubState;
      syncedAt?: string;
      actor?: TaskEvent["actor"];
      message?: string;
    },
  ): PersistedTask {
    const task = this.getTask(taskId);
    const syncedAt = input.syncedAt ?? new Date().toISOString();
    const actor = input.actor ? assertActor(input.actor) : "system";
    const nextGithub: GitHubState = {
      ...task.github,
      ...input.github,
      prCiLastSyncedAt: syncedAt,
    };
    if (nextGithub.ciStatus !== "failing") {
      nextGithub.ciFailureSummary = undefined;
    }
    nextGithub.deliveryStatus = normalizeGitHubDeliveryStatus(nextGithub);

    const shouldMoveToNeedsReview =
      nextGithub.pullRequestState === "open" &&
      task.status !== "needs-review" &&
      task.status !== "human-working" &&
      task.status !== "blocked" &&
      task.status !== "done";
    const shouldMarkDone =
      nextGithub.pullRequestState === "merged" &&
      task.status !== "done";

    const nextTask: PersistedTask = {
      ...task,
      status: shouldMarkDone
        ? "done"
        : shouldMoveToNeedsReview
          ? "needs-review"
          : task.status,
      mode:
        shouldMarkDone || shouldMoveToNeedsReview
          ? "review"
          : task.mode,
      github: nextGithub,
      updatedAt: syncedAt,
    };
    const events: TaskEvent[] = [];
    const metadata = {
      issueNumber: nextGithub.issueNumber ?? null,
      pullRequestNumber: nextGithub.pullRequestNumber ?? null,
      pullRequestUrl: nextGithub.pullRequestUrl ?? null,
      pullRequestBranch: nextGithub.pullRequestBranch ?? null,
      pullRequestState: nextGithub.pullRequestState ?? null,
      ciStatus: nextGithub.ciStatus ?? null,
      ciFailureSummary: nextGithub.ciFailureSummary ?? null,
      reviewStatus: nextGithub.reviewStatus ?? null,
      reviewUrl: nextGithub.reviewUrl ?? null,
      deliveryStatus: nextGithub.deliveryStatus ?? null,
      prCiLastSyncedAt: nextGithub.prCiLastSyncedAt ?? null,
    };

    if (
      nextGithub.pullRequestNumber &&
      (task.github.pullRequestNumber !== nextGithub.pullRequestNumber ||
        !task.github.pullRequestUrl)
    ) {
      events.push(
        createTaskEvent({
          taskId: task.id,
          type: "PR_OPENED",
          actor,
          message:
            input.message ??
            `Discovered GitHub pull request #${nextGithub.pullRequestNumber}.`,
          createdAt: syncedAt,
          metadata,
        }),
      );
    }

    if (task.github.ciStatus !== nextGithub.ciStatus) {
      if (nextGithub.ciStatus === "pending") {
        events.push(
          createTaskEvent({
            taskId: task.id,
            type: "CI_RUNNING",
            actor,
            message: `CI is running for pull request #${nextGithub.pullRequestNumber}.`,
            createdAt: syncedAt,
            metadata,
          }),
        );
      }

      if (nextGithub.ciStatus === "failing") {
        events.push(
          createTaskEvent({
            taskId: task.id,
            type: "CI_FAILED",
            actor,
            message: nextGithub.ciFailureSummary
              ? `CI failed for pull request #${nextGithub.pullRequestNumber}: ${nextGithub.ciFailureSummary}`
              : `CI failed for pull request #${nextGithub.pullRequestNumber}.`,
            createdAt: syncedAt,
            metadata,
          }),
        );
      }

      if (nextGithub.ciStatus === "passing") {
        events.push(
          createTaskEvent({
            taskId: task.id,
            type: "CI_PASSED",
            actor,
            message: `CI passed for pull request #${nextGithub.pullRequestNumber}.`,
            createdAt: syncedAt,
            metadata,
          }),
        );
      }
    }

    if (task.github.reviewStatus !== nextGithub.reviewStatus) {
      if (nextGithub.reviewStatus === "requested") {
        events.push(
          createTaskEvent({
            taskId: task.id,
            type: "REVIEW_REQUESTED",
            actor,
            message: `Review requested on pull request #${nextGithub.pullRequestNumber}.`,
            createdAt: syncedAt,
            metadata,
          }),
        );
      }

      if (nextGithub.reviewStatus === "changes-requested") {
        events.push(
          createTaskEvent({
            taskId: task.id,
            type: "REVIEW_CHANGES_REQUESTED",
            actor,
            message: `Changes requested on pull request #${nextGithub.pullRequestNumber}.`,
            createdAt: syncedAt,
            metadata,
          }),
        );
      }

      if (nextGithub.reviewStatus === "approved") {
        events.push(
          createTaskEvent({
            taskId: task.id,
            type: "REVIEW_APPROVED",
            actor,
            message: `Pull request #${nextGithub.pullRequestNumber} was approved.`,
            createdAt: syncedAt,
            metadata,
          }),
        );
      }
    }

    if (shouldMoveToNeedsReview) {
      events.push(
        createTaskEvent({
          taskId: task.id,
          type: "TASK_MOVED",
          actor,
          message: "Moved to Needs Review after pull request sync.",
          createdAt: syncedAt,
          fromStatus: task.status,
          toStatus: "needs-review",
          metadata,
        }),
      );
    }

    if (
      nextGithub.pullRequestState === "merged" &&
      task.github.pullRequestState !== "merged"
    ) {
      events.push(
        createTaskEvent({
          taskId: task.id,
          type: "DONE",
          actor,
          message: `Pull request #${nextGithub.pullRequestNumber} was merged.`,
          createdAt: syncedAt,
          fromStatus: task.status,
          toStatus: "done",
          metadata,
        }),
      );
    }

    if (
      JSON.stringify(task.github) === JSON.stringify(nextGithub) &&
      task.status === nextTask.status &&
      task.mode === nextTask.mode
    ) {
      return task;
    }

    this.inTransaction(() => {
      this.updateTaskRow(nextTask);
      for (const event of events) {
        this.insertTaskEvent(event);
      }
    });

    return this.getTask(task.id);
  }

  appendTaskEvent(taskId: string, input: AppendTaskEventInput): PersistedTask {
    const task = this.getTask(taskId);
    const event = createTaskEvent({
      taskId: task.id,
      type: assertEventType(input.type),
      actor: assertActor(input.actor),
      message: assertNonEmptyString(input.message, "message"),
      createdAt: input.createdAt ?? new Date().toISOString(),
      fromStatus: input.fromStatus ? assertStatus(input.fromStatus, "fromStatus") : undefined,
      toStatus: input.toStatus ? assertStatus(input.toStatus, "toStatus") : undefined,
      fromOwner: input.fromOwner ? assertOwner(input.fromOwner, "fromOwner") : undefined,
      toOwner: input.toOwner ? assertOwner(input.toOwner, "toOwner") : undefined,
      metadata: sanitizePayload(input.metadata),
    });

    this.insertTaskEvent(event);

    return this.getTask(task.id);
  }

  appendFeatureEvent(
    featureId: string,
    input: AppendFeatureEventInput,
  ): Feature {
    const feature = this.getFeature(featureId);
    const event = createFeatureEvent({
      featureId: feature.id,
      type: assertFeatureEventType(input.type),
      actor: assertActor(input.actor),
      message: assertNonEmptyString(input.message, "message"),
      createdAt: input.createdAt ?? new Date().toISOString(),
      fromStatus: input.fromStatus
        ? assertFeatureStatus(input.fromStatus)
        : undefined,
      toStatus: input.toStatus ? assertFeatureStatus(input.toStatus) : undefined,
      metadata: sanitizePayload(input.metadata),
    });

    this.insertFeatureEvent(event);

    return this.getFeature(feature.id);
  }

  linkGitHubIssue(
    taskId: string,
    input: {
      issueNumber: number;
      issueUrl: string;
      issueLabels: string[];
      createdAt?: string;
    },
  ): PersistedTask {
    const task = this.getTask(taskId);
    const createdAt = input.createdAt ?? new Date().toISOString();
    const issueNumber = Number.isInteger(input.issueNumber)
      ? input.issueNumber
      : 0;

    if (issueNumber <= 0) {
      throw new ValidationError("issueNumber must be a positive integer.");
    }

    const issueUrl = assertNonEmptyString(input.issueUrl, "issueUrl");
    const issueLabels = assertStringArray(input.issueLabels, "issueLabels");
    const nextTask: PersistedTask = {
      ...task,
      github: {
        ...task.github,
        issueNumber,
        issueUrl,
        issueState: "open",
        issueLabels,
        issueLastSyncedAt: createdAt,
      },
      updatedAt: createdAt,
    };
    const event = createTaskEvent({
      taskId: task.id,
      type: "ISSUE_CREATED",
      actor: "system",
      message: `Created GitHub issue #${issueNumber}.`,
      createdAt,
      metadata: {
        issueNumber,
        issueUrl,
        issueLabels: issueLabels.join(","),
      },
    });

    this.inTransaction(() => {
      this.updateTaskRow(nextTask);
      this.insertTaskEvent(event);
    });

    return this.getTask(task.id);
  }

  listWorkflows(projectId?: string): Workflow[] {
    const rows = projectId
      ? this.database
          .prepare("SELECT * FROM workflows WHERE project_id = ? ORDER BY updated_at")
          .all(projectId)
      : this.database.prepare("SELECT * FROM workflows ORDER BY updated_at").all();

    return (rows as WorkflowRow[]).map((row) => this.workflowWithGraph(row));
  }

  getWorkflow(workflowId: string): Workflow {
    const row = this.database
      .prepare("SELECT * FROM workflows WHERE id = ?")
      .get(workflowId) as WorkflowRow | undefined;

    if (!row) {
      throw new NotFoundError(`Workflow "${workflowId}" was not found.`);
    }

    return this.workflowWithGraph(row);
  }

  createWorkflow(input: CreateWorkflowInput): Workflow {
    this.getProject(assertNonEmptyString(input.projectId, "projectId"));
    const now = input.createdAt ?? new Date().toISOString();
    const workflowId = input.id ?? `workflow-${randomUUID()}`;
    const workflow: Workflow = {
      id: workflowId,
      projectId: assertNonEmptyString(input.projectId, "projectId"),
      name: assertNonEmptyString(input.name, "name"),
      description: assertOptionalString(input.description, "description"),
      version: assertPositiveInteger(input.version ?? 1, "version"),
      nodes: this.normalizeWorkflowNodes(workflowId, input.nodes ?? [], now),
      edges: this.normalizeWorkflowEdges(workflowId, input.edges ?? [], now),
      config: input.config ? assertRecord(input.config, "config") : {},
      createdAt: now,
      updatedAt: now,
    };

    this.assertWorkflowGraph(workflow);
    this.inTransaction(() => {
      this.insertWorkflow(workflow);
      for (const node of workflow.nodes) {
        this.insertWorkflowNode(node);
      }
      for (const edge of workflow.edges) {
        this.insertWorkflowEdge(edge);
      }
    });

    return this.getWorkflow(workflow.id);
  }

  updateWorkflow(workflowId: string, input: UpdateWorkflowInput): Workflow {
    const workflow = this.getWorkflow(workflowId);
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const nextWorkflow: Workflow = {
      ...workflow,
      name:
        input.name === undefined
          ? workflow.name
          : assertNonEmptyString(input.name, "name"),
      description:
        input.description === undefined
          ? workflow.description
          : assertOptionalString(input.description, "description"),
      version:
        input.version === undefined
          ? workflow.version
          : assertPositiveInteger(input.version, "version"),
      nodes:
        input.nodes === undefined
          ? workflow.nodes
          : this.normalizeWorkflowNodes(workflow.id, input.nodes, updatedAt),
      edges:
        input.edges === undefined
          ? workflow.edges
          : this.normalizeWorkflowEdges(workflow.id, input.edges, updatedAt),
      config:
        input.config === undefined ? workflow.config : assertRecord(input.config, "config"),
      updatedAt,
    };

    this.assertWorkflowGraph(nextWorkflow);
    this.inTransaction(() => {
      this.updateWorkflowRow(nextWorkflow);
      if (input.nodes !== undefined || input.edges !== undefined) {
        this.database
          .prepare("DELETE FROM workflow_edges WHERE workflow_id = ?")
          .run(workflow.id);
        this.database
          .prepare("DELETE FROM workflow_nodes WHERE workflow_id = ?")
          .run(workflow.id);
        for (const node of nextWorkflow.nodes) {
          this.insertWorkflowNode(node);
        }
        for (const edge of nextWorkflow.edges) {
          this.insertWorkflowEdge(edge);
        }
      }
    });

    return this.getWorkflow(workflow.id);
  }

  listWorkflowRuns(workflowId: string): WorkflowRun[] {
    this.getWorkflow(workflowId);
    const rows = this.database
      .prepare("SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at")
      .all(workflowId) as WorkflowRunRow[];

    return rows.map((row) =>
      workflowRunFromRow(row, this.listWorkflowRunSteps(row.id)),
    );
  }

  getLatestWorkflowRunForProject(projectId: string): WorkflowRun | undefined {
    this.getProject(assertNonEmptyString(projectId, "projectId"));
    return this.latestWorkflowRunForProject(projectId);
  }

  getWorkflowRun(runId: string): WorkflowRun {
    const row = this.database
      .prepare("SELECT * FROM workflow_runs WHERE id = ?")
      .get(runId) as WorkflowRunRow | undefined;

    if (!row) {
      throw new NotFoundError(`Workflow run "${runId}" was not found.`);
    }

    return workflowRunFromRow(row, this.listWorkflowRunSteps(row.id));
  }

  createWorkflowRun(input: CreateWorkflowRunInput): WorkflowRun {
    const workflow = this.getWorkflow(assertNonEmptyString(input.workflowId, "workflowId"));
    const projectId = input.projectId
      ? assertNonEmptyString(input.projectId, "projectId")
      : workflow.projectId;
    this.getProject(projectId);
    if (projectId !== workflow.projectId) {
      throw new ValidationError(
        `Workflow "${workflow.id}" does not belong to project "${projectId}".`,
      );
    }
    if (input.featureId) {
      this.assertProjectFeaturePair(projectId, input.featureId);
    }

    const now = input.createdAt ?? new Date().toISOString();
    const runId = input.id ?? `workflow-run-${randomUUID()}`;
    const run: WorkflowRun = {
      id: runId,
      workflowId: workflow.id,
      projectId,
      featureId: input.featureId,
      status: input.status ? assertWorkflowRunStatus(input.status) : "queued",
      currentNodeId: input.currentNodeId
        ? assertNonEmptyString(input.currentNodeId, "currentNodeId")
        : undefined,
      inputArtifacts: input.inputArtifacts
        ? assertWorkflowArtifacts(input.inputArtifacts, "inputArtifacts")
        : [],
      outputArtifacts: input.outputArtifacts
        ? assertWorkflowArtifacts(input.outputArtifacts, "outputArtifacts")
        : [],
      executionLogs: input.executionLogs
        ? assertWorkflowLogs(input.executionLogs, "executionLogs")
        : [],
      steps: this.normalizeWorkflowRunSteps(runId, input.steps ?? [], now),
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      createdAt: now,
      updatedAt: now,
    };

    const nodeIds = new Set(workflow.nodes.map((node) => node.id));
    if (run.currentNodeId && !nodeIds.has(run.currentNodeId)) {
      throw new ValidationError("currentNodeId must reference a workflow node.");
    }
    for (const step of run.steps) {
      if (!nodeIds.has(step.workflowNodeId)) {
        throw new ValidationError(
          "workflow run steps must reference nodes in the workflow.",
        );
      }
    }

    this.inTransaction(() => {
      this.insertWorkflowRun(run);
      for (const step of run.steps) {
        this.insertWorkflowRunStep(step);
      }
    });

    return this.getWorkflowRun(run.id);
  }

  updateWorkflowRun(runId: string, input: UpdateWorkflowRunInput): WorkflowRun {
    const run = this.getWorkflowRun(assertNonEmptyString(runId, "runId"));
    const workflow = this.getWorkflow(run.workflowId);
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const nextRun: WorkflowRun = {
      ...run,
      status:
        input.status === undefined
          ? run.status
          : assertWorkflowRunStatus(input.status),
      currentNodeId:
        input.currentNodeId === undefined
          ? run.currentNodeId
          : input.currentNodeId === null
            ? undefined
            : assertNonEmptyString(input.currentNodeId, "currentNodeId"),
      inputArtifacts:
        input.inputArtifacts === undefined
          ? run.inputArtifacts
          : assertWorkflowArtifacts(input.inputArtifacts, "inputArtifacts"),
      outputArtifacts:
        input.outputArtifacts === undefined
          ? run.outputArtifacts
          : assertWorkflowArtifacts(input.outputArtifacts, "outputArtifacts"),
      executionLogs:
        input.executionLogs === undefined
          ? run.executionLogs
          : assertWorkflowLogs(input.executionLogs, "executionLogs"),
      startedAt:
        input.startedAt === undefined
          ? run.startedAt
          : input.startedAt === null
            ? undefined
            : assertOptionalString(input.startedAt, "startedAt"),
      completedAt:
        input.completedAt === undefined
          ? run.completedAt
          : input.completedAt === null
            ? undefined
            : assertOptionalString(input.completedAt, "completedAt"),
      updatedAt,
    };

    const nodeIds = new Set(workflow.nodes.map((node) => node.id));
    if (nextRun.currentNodeId && !nodeIds.has(nextRun.currentNodeId)) {
      throw new ValidationError("currentNodeId must reference a workflow node.");
    }

    this.updateWorkflowRunRow(nextRun);
    return this.getWorkflowRun(run.id);
  }

  upsertWorkflowRunStep(
    runId: string,
    input: UpsertWorkflowRunStepInput,
  ): WorkflowRun {
    const run = this.getWorkflowRun(assertNonEmptyString(runId, "runId"));
    const workflow = this.getWorkflow(run.workflowId);
    const nodeId = assertNonEmptyString(input.workflowNodeId, "workflowNodeId");

    if (!workflow.nodes.some((node) => node.id === nodeId)) {
      throw new ValidationError(
        "workflow run steps must reference nodes in the workflow.",
      );
    }

    const existingStep = input.id
      ? run.steps.find((step) => step.id === input.id)
      : undefined;
    const now = input.updatedAt ?? new Date().toISOString();
    const step: WorkflowRunStep = {
      id: input.id ?? `workflow-run-step-${randomUUID()}`,
      runId: run.id,
      workflowNodeId: nodeId,
      status: assertWorkflowRunStepStatus(input.status),
      attempt: assertPositiveInteger(input.attempt ?? existingStep?.attempt ?? 1, "attempt"),
      inputArtifacts:
        input.inputArtifacts === undefined
          ? existingStep?.inputArtifacts ?? []
          : assertWorkflowArtifacts(input.inputArtifacts, "inputArtifacts"),
      outputArtifacts:
        input.outputArtifacts === undefined
          ? existingStep?.outputArtifacts ?? []
          : assertWorkflowArtifacts(input.outputArtifacts, "outputArtifacts"),
      executionLogs:
        input.executionLogs === undefined
          ? existingStep?.executionLogs ?? []
          : assertWorkflowLogs(input.executionLogs, "executionLogs"),
      error:
        input.error === undefined
          ? existingStep?.error
          : input.error === null
            ? undefined
            : assertOptionalString(input.error, "error"),
      requireApproval: Boolean(
        input.requireApproval ?? existingStep?.requireApproval ?? false,
      ),
      approvedAt:
        input.approvedAt === undefined
          ? existingStep?.approvedAt
          : input.approvedAt === null
            ? undefined
            : assertOptionalString(input.approvedAt, "approvedAt"),
      startedAt:
        input.startedAt === undefined
          ? existingStep?.startedAt
          : input.startedAt === null
            ? undefined
            : assertOptionalString(input.startedAt, "startedAt"),
      completedAt:
        input.completedAt === undefined
          ? existingStep?.completedAt
          : input.completedAt === null
            ? undefined
            : assertOptionalString(input.completedAt, "completedAt"),
      createdAt: existingStep?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    };

    if (existingStep) {
      this.updateWorkflowRunStepRow(step);
    } else {
      this.insertWorkflowRunStep(step);
    }

    return this.getWorkflowRun(run.id);
  }

  listEngineJobs(options: ListEngineJobsOptions = {}): EngineJob[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (options.projectId) {
      clauses.push("project_id = ?");
      params.push(assertNonEmptyString(options.projectId, "projectId"));
    }

    if (options.taskId) {
      clauses.push("task_id = ?");
      params.push(assertNonEmptyString(options.taskId, "taskId"));
    }

    if (options.workflowRunId) {
      clauses.push("workflow_run_id = ?");
      params.push(assertNonEmptyString(options.workflowRunId, "workflowRunId"));
    }

    if (options.workflowNodeId) {
      clauses.push("workflow_node_id = ?");
      params.push(assertNonEmptyString(options.workflowNodeId, "workflowNodeId"));
    }

    if (options.backend) {
      clauses.push("backend = ?");
      params.push(assertExecutorBackend(options.backend));
    }

    if (options.kind) {
      clauses.push("kind = ?");
      params.push(assertEngineJobKind(options.kind));
    }

    if (options.status !== undefined) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      if (statuses.length === 0) {
        throw new ValidationError("status filter must include at least one value.");
      }

      clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses.map((status) => assertEngineJobStatus(status)));
    }

    const limit =
      options.limit === undefined
        ? undefined
        : assertPositiveInteger(options.limit, "limit");
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitClause = limit === undefined ? "" : " LIMIT ?";

    const rows = this.database
      .prepare(
        `
          SELECT * FROM engine_jobs
          ${whereClause}
          ORDER BY queued_at DESC, created_at DESC
          ${limitClause}
        `,
      )
      .all(...params, ...(limit === undefined ? [] : [limit])) as EngineJobRow[];

    return rows.map(engineJobFromRow);
  }

  getEngineJobMetrics(
    projectId: string,
    windowHours = 24,
  ): EngineJobMetricsSnapshot {
    const normalizedProjectId = assertNonEmptyString(projectId, "projectId");
    const normalizedWindowHours = assertPositiveInteger(windowHours, "windowHours");
    this.getProject(normalizedProjectId);

    const since = new Date(
      Date.now() - normalizedWindowHours * 60 * 60 * 1000,
    ).toISOString();

    const statusRows = this.database
      .prepare(
        `
          SELECT status, COUNT(*) AS count
          FROM engine_jobs
          WHERE project_id = ? AND queued_at >= ?
          GROUP BY status
        `,
      )
      .all(normalizedProjectId, since) as Array<{
      status: EngineJobStatus;
      count: number;
    }>;

    const counts: Record<EngineJobStatus, number> = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const row of statusRows) {
      counts[row.status] = row.count;
    }

    const durationRow = this.database
      .prepare(
        `
          SELECT AVG(
            (strftime('%s', completed_at) - strftime('%s', started_at)) * 1000.0
          ) AS averageDurationMs
          FROM engine_jobs
          WHERE project_id = ?
            AND queued_at >= ?
            AND started_at IS NOT NULL
            AND completed_at IS NOT NULL
        `,
      )
      .get(normalizedProjectId, since) as { averageDurationMs: number | null };

    const completed = counts.completed;
    const failed = counts.failed;
    const terminal = completed + failed;

    return {
      windowHours: normalizedWindowHours,
      since,
      queued: counts.queued,
      running: counts.running,
      completed,
      failed,
      averageDurationMs: durationRow.averageDurationMs,
      failureRate: terminal > 0 ? failed / terminal : null,
    };
  }

  getEngineJob(jobId: string): EngineJob {
    const row = this.database
      .prepare("SELECT * FROM engine_jobs WHERE id = ?")
      .get(assertNonEmptyString(jobId, "jobId")) as EngineJobRow | undefined;

    if (!row) {
      throw new NotFoundError(`Engine job "${jobId}" was not found.`);
    }

    return engineJobFromRow(row);
  }

  createEngineJob(input: CreateEngineJobInput): EngineJob {
    const kind = assertEngineJobKind(input.kind);
    const backend = assertExecutorBackend(input.backend);
    const projectId = input.projectId
      ? assertNonEmptyString(input.projectId, "projectId")
      : undefined;
    const taskId = input.taskId
      ? assertNonEmptyString(input.taskId, "taskId")
      : undefined;
    const workflowRunId = input.workflowRunId
      ? assertNonEmptyString(input.workflowRunId, "workflowRunId")
      : undefined;
    const workflowNodeId = input.workflowNodeId
      ? assertNonEmptyString(input.workflowNodeId, "workflowNodeId")
      : undefined;

    this.assertEngineJobReferences({
      projectId,
      taskId,
      workflowRunId,
      workflowNodeId,
    });

    const now = input.createdAt ?? new Date().toISOString();
    const job: EngineJob = {
      id: input.id ?? `engine-job-${randomUUID()}`,
      kind,
      status: input.status ? assertEngineJobStatus(input.status) : "queued",
      backend,
      projectId,
      taskId,
      workflowRunId,
      workflowNodeId,
      payload: input.payload ? assertRecord(input.payload, "payload") : {},
      result: input.result ? assertRecord(input.result, "result") : undefined,
      executionLogs: input.executionLogs
        ? assertEngineRunLogs(input.executionLogs, "executionLogs")
        : [],
      error: input.error ? assertOptionalString(input.error, "error") : undefined,
      attempt: assertPositiveInteger(input.attempt ?? 1, "attempt"),
      maxAttempts: assertPositiveInteger(input.maxAttempts ?? 3, "maxAttempts"),
      queuedAt: input.queuedAt ?? now,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      createdAt: now,
      updatedAt: now,
    };

    this.insertEngineJob(job);
    return this.getEngineJob(job.id);
  }

  updateEngineJob(jobId: string, input: UpdateEngineJobInput): EngineJob {
    const job = this.getEngineJob(assertNonEmptyString(jobId, "jobId"));
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const nextJob: EngineJob = {
      ...job,
      status:
        input.status === undefined ? job.status : assertEngineJobStatus(input.status),
      result:
        input.result === undefined
          ? job.result
          : input.result === null
            ? undefined
            : assertRecord(input.result, "result"),
      executionLogs:
        input.executionLogs === undefined
          ? job.executionLogs
          : assertEngineRunLogs(input.executionLogs, "executionLogs"),
      error:
        input.error === undefined
          ? job.error
          : input.error === null
            ? undefined
            : assertOptionalString(input.error, "error"),
      attempt:
        input.attempt === undefined
          ? job.attempt
          : assertPositiveInteger(input.attempt, "attempt"),
      startedAt:
        input.startedAt === undefined
          ? job.startedAt
          : input.startedAt === null
            ? undefined
            : assertOptionalString(input.startedAt, "startedAt"),
      completedAt:
        input.completedAt === undefined
          ? job.completedAt
          : input.completedAt === null
            ? undefined
            : assertOptionalString(input.completedAt, "completedAt"),
      updatedAt,
    };

    this.updateEngineJobRow(nextJob);
    return this.getEngineJob(job.id);
  }

  appendEngineLogEntry(
    jobId: string,
    entry: EngineRunLogEntry,
  ): EngineJob {
    const job = this.getEngineJob(assertNonEmptyString(jobId, "jobId"));
    const [validatedEntry] = assertEngineRunLogs([entry], "entry");
    const updatedAt = new Date().toISOString();
    const nextJob: EngineJob = {
      ...job,
      executionLogs: [...job.executionLogs, validatedEntry],
      updatedAt,
    };

    this.updateEngineJobRow(nextJob);
    return this.getEngineJob(job.id);
  }

  fetchNextQueuedJob(): EngineJob | undefined {
    const row = this.database
      .prepare(
        `
          SELECT * FROM engine_jobs
          WHERE status = 'queued'
          ORDER BY queued_at ASC, created_at ASC
          LIMIT 1
        `,
      )
      .get() as EngineJobRow | undefined;

    return row ? engineJobFromRow(row) : undefined;
  }

  getActiveTaskRunJobForTask(taskId: string): EngineJob | undefined {
    const row = this.database
      .prepare(
        `
          SELECT * FROM engine_jobs
          WHERE task_id = ? AND kind = 'task-run' AND status IN ('queued', 'running')
          ORDER BY queued_at DESC, created_at DESC
          LIMIT 1
        `,
      )
      .get(assertNonEmptyString(taskId, "taskId")) as EngineJobRow | undefined;

    return row ? engineJobFromRow(row) : undefined;
  }

  hasActiveTaskRunJob(taskId: string): boolean {
    return this.getActiveTaskRunJobForTask(taskId) !== undefined;
  }

  countActiveTaskRunJobs(): number {
    const row = this.database
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM engine_jobs
          WHERE kind = 'task-run' AND status IN ('queued', 'running')
        `,
      )
      .get() as { count: number };

    return row.count;
  }

  enqueueTaskRunJob(input: EnqueueTaskRunJobInput): EnqueueTaskRunJobResult {
    const taskId = assertNonEmptyString(input.taskId, "taskId");
    const projectId = assertNonEmptyString(input.projectId, "projectId");
    const backend = assertExecutorBackend(input.backend);
    const payload = assertRecord(input.payload, "payload");

    const existing = this.getActiveTaskRunJobForTask(taskId);
    if (existing) {
      return { job: existing, created: false };
    }

    const job = this.createEngineJob({
      kind: "task-run",
      backend,
      projectId,
      taskId,
      payload,
      maxAttempts: input.maxAttempts,
    });

    return { job, created: true };
  }

  getEngineSchedulerStatus(): EngineSchedulerStatus {
    const row = this.database
      .prepare("SELECT * FROM engine_scheduler_state WHERE id = 'default'")
      .get() as EngineSchedulerStateRow | undefined;

    if (!row) {
      throw new NotFoundError("Engine scheduler state was not found.");
    }

    return engineSchedulerFromRow(row);
  }

  updateEngineSchedulerStatus(
    input: UpdateEngineSchedulerInput,
  ): EngineSchedulerStatus {
    const current = this.getEngineSchedulerStatus();
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const nextStatus: EngineSchedulerStatus = {
      status:
        input.status === undefined
          ? current.status
          : assertEngineSchedulerState(input.status),
      lastTickAt:
        input.lastTickAt === undefined
          ? current.lastTickAt
          : input.lastTickAt === null
            ? undefined
            : assertOptionalString(input.lastTickAt, "lastTickAt"),
      tickCount:
        input.tickCount === undefined
          ? current.tickCount
          : assertPositiveInteger(input.tickCount, "tickCount"),
      lastError:
        input.lastError === undefined
          ? current.lastError
          : input.lastError === null
            ? undefined
            : assertOptionalString(input.lastError, "lastError"),
      updatedAt,
    };

    this.database
      .prepare(
        `
          UPDATE engine_scheduler_state
          SET status = ?,
              last_tick_at = ?,
              tick_count = ?,
              last_error = ?,
              updated_at = ?
          WHERE id = 'default'
        `,
      )
      .run(
        nextStatus.status,
        nextStatus.lastTickAt ?? null,
        String(nextStatus.tickCount),
        nextStatus.lastError ?? null,
        nextStatus.updatedAt,
      );

    return this.getEngineSchedulerStatus();
  }

  private listTaskEvents(taskId: string): TaskEvent[] {
    const rows = this.database
      .prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at")
      .all(taskId) as TaskEventRow[];

    return rows.map(eventFromRow);
  }

  private listFeatureEvents(featureId: string): FeatureEvent[] {
    const rows = this.database
      .prepare("SELECT * FROM feature_events WHERE feature_id = ? ORDER BY created_at")
      .all(featureId) as FeatureEventRow[];

    return rows.map(featureEventFromRow);
  }

  private featureWithEvents(feature: Feature): Feature {
    return {
      ...feature,
      events: this.listFeatureEvents(feature.id),
    };
  }

  private assertProjectFeaturePair(projectId: string, featureId: string): void {
    const project = this.database
      .prepare("SELECT id FROM projects WHERE id = ?")
      .get(projectId);

    if (!project) {
      throw new NotFoundError(`Project "${projectId}" was not found.`);
    }

    const feature = this.database
      .prepare("SELECT project_id FROM features WHERE id = ?")
      .get(featureId) as { project_id: string } | undefined;

    if (!feature) {
      throw new NotFoundError(`Feature "${featureId}" was not found.`);
    }

    if (feature.project_id !== projectId) {
      throw new ValidationError(
        `Feature "${featureId}" does not belong to project "${projectId}".`,
      );
    }
  }

  private assertEngineJobReferences({
    projectId,
    taskId,
    workflowRunId,
    workflowNodeId,
  }: {
    projectId?: string;
    taskId?: string;
    workflowRunId?: string;
    workflowNodeId?: string;
  }): void {
    if (projectId) {
      this.getProject(projectId);
    }

    if (taskId) {
      const task = this.getTask(taskId);
      if (projectId && task.projectId !== projectId) {
        throw new ValidationError(
          `Task "${taskId}" does not belong to project "${projectId}".`,
        );
      }
    }

    if (workflowRunId) {
      const run = this.getWorkflowRun(workflowRunId);
      if (projectId && run.projectId !== projectId) {
        throw new ValidationError(
          `Workflow run "${workflowRunId}" does not belong to project "${projectId}".`,
        );
      }
      if (taskId && run.featureId) {
        const task = this.getTask(taskId);
        if (task.featureId !== run.featureId) {
          throw new ValidationError(
            `Task "${taskId}" does not belong to workflow run feature "${run.featureId}".`,
          );
        }
      }
    }

    if (workflowNodeId) {
      if (!workflowRunId) {
        throw new ValidationError(
          "workflowNodeId requires workflowRunId for validation.",
        );
      }

      const run = this.getWorkflowRun(workflowRunId);
      const workflow = this.getWorkflow(run.workflowId);
      if (!workflow.nodes.some((node) => node.id === workflowNodeId)) {
        throw new ValidationError(
          "workflowNodeId must reference a node in the workflow run's workflow.",
        );
      }
    }
  }

  private workflowWithGraph(row: WorkflowRow): Workflow {
    const nodes = this.database
      .prepare("SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY created_at")
      .all(row.id) as WorkflowNodeRow[];
    const edges = this.database
      .prepare("SELECT * FROM workflow_edges WHERE workflow_id = ? ORDER BY created_at")
      .all(row.id) as WorkflowEdgeRow[];

    return workflowFromRow(
      row,
      nodes.map(workflowNodeFromRow),
      edges.map(workflowEdgeFromRow),
    );
  }

  private listWorkflowRunSteps(runId: string): WorkflowRunStep[] {
    const rows = this.database
      .prepare("SELECT * FROM workflow_run_steps WHERE run_id = ? ORDER BY created_at")
      .all(runId) as WorkflowRunStepRow[];

    return rows.map(workflowRunStepFromRow);
  }

  private latestWorkflowRunForProject(projectId: string): WorkflowRun | undefined {
    const row = this.database
      .prepare(
        `
          SELECT * FROM workflow_runs
          WHERE project_id = ?
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 1
        `,
      )
      .get(projectId) as WorkflowRunRow | undefined;

    return row
      ? workflowRunFromRow(row, this.listWorkflowRunSteps(row.id))
      : undefined;
  }

  private normalizeWorkflowNodes(
    workflowId: string,
    nodes: NonNullable<CreateWorkflowInput["nodes"]>,
    timestamp: string,
  ): WorkflowNode[] {
    return nodes.map((node) => ({
      id: assertNonEmptyString(node.id, "node.id"),
      workflowId,
      type: assertNonEmptyString(node.type, "node.type"),
      name: assertNonEmptyString(node.name, "node.name"),
      mode: assertWorkflowNodeMode(node.mode),
      position: assertWorkflowPosition(node.position),
      inputArtifacts: assertWorkflowArtifacts(
        node.inputArtifacts,
        "node.inputArtifacts",
      ),
      outputArtifacts: assertWorkflowArtifacts(
        node.outputArtifacts,
        "node.outputArtifacts",
      ),
      requireApproval: Boolean(node.requireApproval),
      maxRetries: assertNonNegativeInteger(node.maxRetries, "node.maxRetries"),
      riskPolicy: assertWorkflowRiskPolicy(node.riskPolicy),
      config: assertRecord(node.config, "node.config"),
      currentState: assertWorkflowNodeState(node.currentState),
      createdAt: node.createdAt ?? timestamp,
      updatedAt: node.updatedAt ?? timestamp,
    }));
  }

  private normalizeWorkflowEdges(
    workflowId: string,
    edges: NonNullable<CreateWorkflowInput["edges"]>,
    timestamp: string,
  ): WorkflowEdge[] {
    return edges.map((edge) => ({
      id: assertNonEmptyString(edge.id, "edge.id"),
      workflowId,
      sourceNodeId: assertNonEmptyString(edge.sourceNodeId, "edge.sourceNodeId"),
      targetNodeId: assertNonEmptyString(edge.targetNodeId, "edge.targetNodeId"),
      label: assertOptionalString(edge.label, "edge.label"),
      condition: assertRecord(edge.condition, "edge.condition"),
      createdAt: edge.createdAt ?? timestamp,
      updatedAt: edge.updatedAt ?? timestamp,
    }));
  }

  private normalizeWorkflowRunSteps(
    runId: string,
    steps: NonNullable<CreateWorkflowRunInput["steps"]>,
    timestamp: string,
  ): WorkflowRunStep[] {
    return steps.map((step) => ({
      id: assertNonEmptyString(step.id, "step.id"),
      runId,
      workflowNodeId: assertNonEmptyString(
        step.workflowNodeId,
        "step.workflowNodeId",
      ),
      status: assertWorkflowRunStepStatus(step.status),
      attempt: assertPositiveInteger(step.attempt, "step.attempt"),
      inputArtifacts: assertWorkflowArtifacts(
        step.inputArtifacts,
        "step.inputArtifacts",
      ),
      outputArtifacts: assertWorkflowArtifacts(
        step.outputArtifacts,
        "step.outputArtifacts",
      ),
      executionLogs: assertWorkflowLogs(step.executionLogs, "step.executionLogs"),
      error: step.error ? assertOptionalString(step.error, "step.error") : undefined,
      requireApproval: Boolean(step.requireApproval),
      approvedAt: step.approvedAt,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      createdAt: step.createdAt ?? timestamp,
      updatedAt: step.updatedAt ?? timestamp,
    }));
  }

  private assertWorkflowGraph(workflow: Workflow): void {
    const nodeIds = new Set<string>();
    for (const node of workflow.nodes) {
      if (nodeIds.has(node.id)) {
        throw new ValidationError(`Workflow node id "${node.id}" is duplicated.`);
      }
      nodeIds.add(node.id);
    }

    const edgeIds = new Set<string>();
    for (const edge of workflow.edges) {
      if (edgeIds.has(edge.id)) {
        throw new ValidationError(`Workflow edge id "${edge.id}" is duplicated.`);
      }
      edgeIds.add(edge.id);
      if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
        throw new ValidationError(
          "Workflow edges must reference nodes in the same workflow.",
        );
      }
    }
  }

  private insertProject(project: Project): void {
    this.database
      .prepare(
        `
          INSERT INTO projects (
            id, name, description, repository, repo_path, is_git_repository,
            current_branch, default_branch, github_remote_url, spec_kit_root,
            github_repository, specs_path, tasks_path, workflows_path, handoffs_path,
            automation_policy, engine_settings, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        project.id,
        project.name,
        project.description,
        project.repository,
        project.repoPath,
        project.isGitRepository ? "true" : "false",
        project.currentBranch,
        project.defaultBranch,
        project.githubRemoteUrl,
        project.specKitRoot,
        project.githubRepository,
        project.specsPath,
        project.tasksPath,
        project.workflowsPath,
        project.handoffsPath,
        json(project.automationPolicy),
        json(project.engineSettings),
        project.createdAt,
        project.updatedAt,
      );
  }

  private updateProjectRow(project: Project): void {
    this.database
      .prepare(
        `
          UPDATE projects
          SET name = ?, description = ?, repository = ?, repo_path = ?,
            is_git_repository = ?, current_branch = ?, default_branch = ?,
            github_remote_url = ?, github_repository = ?, spec_kit_root = ?, specs_path = ?,
            tasks_path = ?, workflows_path = ?, handoffs_path = ?, automation_policy = ?,
            engine_settings = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        project.name,
        project.description,
        project.repository,
        project.repoPath,
        project.isGitRepository ? "true" : "false",
        project.currentBranch,
        project.defaultBranch,
        project.githubRemoteUrl,
        project.githubRepository,
        project.specKitRoot,
        project.specsPath,
        project.tasksPath,
        project.workflowsPath,
        project.handoffsPath,
        json(project.automationPolicy),
        json(project.engineSettings),
        project.updatedAt,
        project.id,
      );
  }

  private insertFeature(feature: Feature): void {
    this.database
      .prepare(
        `
          INSERT INTO features (
            id, project_id, name, summary, source, artifact_folder_path,
            prd_path, spec_path, plan_path, tasks_path, decisions_path,
            status, artifacts, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        feature.id,
        feature.projectId,
        feature.name,
        feature.summary,
        feature.source,
        feature.artifactFolderPath,
        feature.prdPath,
        feature.specPath,
        feature.planPath,
        feature.tasksPath,
        feature.decisionsPath,
        feature.status,
        json(feature.artifacts),
        feature.createdAt,
        feature.updatedAt,
      );
  }

  private insertFeatureEvent(event: FeatureEvent): void {
    this.database
      .prepare(
        `
          INSERT INTO feature_events (
            id, feature_id, type, actor, message, from_status, to_status,
            payload, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        event.id,
        event.featureId,
        event.type,
        event.actor,
        event.message,
        event.fromStatus ?? null,
        event.toStatus ?? null,
        json(event.metadata ?? {}),
        event.createdAt,
      );
  }

  private updateFeatureRow(feature: Feature): void {
    this.database
      .prepare(
        `
          UPDATE features
          SET name = ?, summary = ?, source = ?, artifact_folder_path = ?,
            prd_path = ?, spec_path = ?, plan_path = ?, tasks_path = ?,
            decisions_path = ?, status = ?, artifacts = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        feature.name,
        feature.summary,
        feature.source,
        feature.artifactFolderPath,
        feature.prdPath,
        feature.specPath,
        feature.planPath,
        feature.tasksPath,
        feature.decisionsPath,
        feature.status,
        json(feature.artifacts),
        feature.updatedAt,
        feature.id,
      );
  }

  private insertTask(task: PersistedTask): void {
    this.database
      .prepare(
        `
          INSERT INTO tasks (
            id, project_id, feature_id, title, description, status, owner, mode,
            risk, source, labels, acceptance_criteria, dependencies, branch,
            worktree, github, handoff, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        task.id,
        task.projectId,
        task.featureId,
        task.title,
        task.description,
        task.status,
        task.owner,
        task.mode,
        task.risk,
        task.source,
        json(task.labels),
        json(task.acceptanceCriteria),
        json(task.dependencies),
        task.branch,
        task.worktree,
        json(task.github),
        json(task.handoff),
        task.createdAt,
        task.updatedAt,
      );
  }

  private updateTaskRow(task: PersistedTask): void {
    this.database
      .prepare(
        `
          UPDATE tasks
          SET title = ?, description = ?, status = ?, owner = ?, mode = ?,
            risk = ?, labels = ?, acceptance_criteria = ?, dependencies = ?,
            branch = ?, worktree = ?, github = ?, handoff = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        task.title,
        task.description,
        task.status,
        task.owner,
        task.mode,
        task.risk,
        json(task.labels),
        json(task.acceptanceCriteria),
        json(task.dependencies),
        task.branch,
        task.worktree,
        json(task.github),
        json(task.handoff),
        task.updatedAt,
        task.id,
      );
  }

  private insertTaskEvent(event: TaskEvent): void {
    this.database
      .prepare(
        `
          INSERT INTO task_events (
            id, task_id, type, actor, message, from_status, to_status,
            from_owner, to_owner, payload, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        event.id,
        event.taskId,
        event.type,
        event.actor,
        event.message,
        event.fromStatus ?? null,
        event.toStatus ?? null,
        event.fromOwner ?? null,
        event.toOwner ?? null,
        json(event.metadata ?? {}),
        event.createdAt,
      );
  }

  private insertWorkflow(workflow: Workflow): void {
    this.database
      .prepare(
        `
          INSERT INTO workflows (
            id, project_id, name, description, version, config, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        workflow.id,
        workflow.projectId,
        workflow.name,
        workflow.description,
        String(workflow.version),
        json(workflow.config),
        workflow.createdAt,
        workflow.updatedAt,
      );
  }

  private updateWorkflowRow(workflow: Workflow): void {
    this.database
      .prepare(
        `
          UPDATE workflows
          SET name = ?, description = ?, version = ?, config = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        workflow.name,
        workflow.description,
        String(workflow.version),
        json(workflow.config),
        workflow.updatedAt,
        workflow.id,
      );
  }

  private insertWorkflowNode(node: WorkflowNode): void {
    this.database
      .prepare(
        `
          INSERT INTO workflow_nodes (
            id, workflow_id, type, name, mode, position, input_artifacts,
            output_artifacts, require_approval, max_retries, risk_policy, config,
            current_state, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        node.id,
        node.workflowId,
        node.type,
        node.name,
        node.mode,
        json(node.position),
        json(node.inputArtifacts),
        json(node.outputArtifacts),
        node.requireApproval ? "true" : "false",
        String(node.maxRetries),
        node.riskPolicy,
        json(node.config),
        node.currentState,
        node.createdAt,
        node.updatedAt,
      );
  }

  private insertWorkflowEdge(edge: WorkflowEdge): void {
    this.database
      .prepare(
        `
          INSERT INTO workflow_edges (
            id, workflow_id, source_node_id, target_node_id, label, dashed, condition,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        edge.id,
        edge.workflowId,
        edge.sourceNodeId,
        edge.targetNodeId,
        edge.label,
        edge.dashed ? 1 : 0,
        json(edge.condition),
        edge.createdAt,
        edge.updatedAt,
      );
  }

  private insertWorkflowRun(run: WorkflowRun): void {
    this.database
      .prepare(
        `
          INSERT INTO workflow_runs (
            id, workflow_id, project_id, feature_id, status, current_node_id,
            input_artifacts, output_artifacts, execution_logs, started_at,
            completed_at, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        run.id,
        run.workflowId,
        run.projectId,
        run.featureId ?? null,
        run.status,
        run.currentNodeId ?? null,
        json(run.inputArtifacts),
        json(run.outputArtifacts),
        json(run.executionLogs),
        run.startedAt ?? null,
        run.completedAt ?? null,
        run.createdAt,
        run.updatedAt,
      );
  }

  private updateWorkflowRunRow(run: WorkflowRun): void {
    this.database
      .prepare(
        `
          UPDATE workflow_runs
          SET status = ?,
              current_node_id = ?,
              input_artifacts = ?,
              output_artifacts = ?,
              execution_logs = ?,
              started_at = ?,
              completed_at = ?,
              updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        run.status,
        run.currentNodeId ?? null,
        json(run.inputArtifacts),
        json(run.outputArtifacts),
        json(run.executionLogs),
        run.startedAt ?? null,
        run.completedAt ?? null,
        run.updatedAt,
        run.id,
      );
  }

  private insertWorkflowRunStep(step: WorkflowRunStep): void {
    this.database
      .prepare(
        `
          INSERT INTO workflow_run_steps (
            id, run_id, workflow_node_id, status, attempt, input_artifacts,
            output_artifacts, execution_logs, error, require_approval, approved_at,
            started_at, completed_at, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        step.id,
        step.runId,
        step.workflowNodeId,
        step.status,
        String(step.attempt),
        json(step.inputArtifacts),
        json(step.outputArtifacts),
        json(step.executionLogs),
        step.error ?? null,
        step.requireApproval ? "true" : "false",
        step.approvedAt ?? null,
        step.startedAt ?? null,
        step.completedAt ?? null,
        step.createdAt,
        step.updatedAt,
      );
  }

  private updateWorkflowRunStepRow(step: WorkflowRunStep): void {
    this.database
      .prepare(
        `
          UPDATE workflow_run_steps
          SET status = ?,
              attempt = ?,
              input_artifacts = ?,
              output_artifacts = ?,
              execution_logs = ?,
              error = ?,
              require_approval = ?,
              approved_at = ?,
              started_at = ?,
              completed_at = ?,
              updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        step.status,
        String(step.attempt),
        json(step.inputArtifacts),
        json(step.outputArtifacts),
        json(step.executionLogs),
        step.error ?? null,
        step.requireApproval ? "true" : "false",
        step.approvedAt ?? null,
        step.startedAt ?? null,
        step.completedAt ?? null,
        step.updatedAt,
        step.id,
      );
  }

  private insertEngineJob(job: EngineJob): void {
    this.database
      .prepare(
        `
          INSERT INTO engine_jobs (
            id, kind, status, backend, project_id, task_id, workflow_run_id,
            workflow_node_id, payload, result, execution_logs, error, attempt,
            max_attempts, queued_at, started_at, completed_at, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        job.id,
        job.kind,
        job.status,
        job.backend,
        job.projectId ?? null,
        job.taskId ?? null,
        job.workflowRunId ?? null,
        job.workflowNodeId ?? null,
        json(job.payload),
        job.result ? json(job.result) : null,
        json(job.executionLogs),
        job.error ?? null,
        String(job.attempt),
        String(job.maxAttempts),
        job.queuedAt,
        job.startedAt ?? null,
        job.completedAt ?? null,
        job.createdAt,
        job.updatedAt,
      );
  }

  private updateEngineJobRow(job: EngineJob): void {
    this.database
      .prepare(
        `
          UPDATE engine_jobs
          SET status = ?,
              result = ?,
              execution_logs = ?,
              error = ?,
              attempt = ?,
              started_at = ?,
              completed_at = ?,
              updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        job.status,
        job.result ? json(job.result) : null,
        json(job.executionLogs),
        job.error ?? null,
        String(job.attempt),
        job.startedAt ?? null,
        job.completedAt ?? null,
        job.updatedAt,
        job.id,
      );
  }

  private inTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN;");
    try {
      const result = operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }
}

const changedTaskFields = (current: PersistedTask, next: PersistedTask): string[] => {
  const fields: (keyof PersistedTask)[] = [
    "title",
    "description",
    "owner",
    "mode",
    "risk",
    "labels",
    "acceptanceCriteria",
    "dependencies",
    "branch",
    "worktree",
    "github",
    "handoff",
  ];

  return fields.filter((field) => JSON.stringify(current[field]) !== JSON.stringify(next[field]));
};

const addUniqueLabels = (labels: string[] = [], additions: string[]): string[] =>
  Array.from(new Set([...labels, ...additions]));

const hasLinkedGitHubIssue = (task: PersistedTask): boolean =>
  Boolean(task.github.issueNumber || task.github.issueUrl);

const hasAoReadyApproval = (task: PersistedTask): boolean =>
  task.risk === "low" || Boolean(task.github.aoReadyApprovedAt);

const applyAoReadyLabelForRiskPolicy = ({
  task,
  updatedAt,
  automationSettings,
  projectPolicy,
}: {
  task: PersistedTask;
  updatedAt: string;
  automationSettings: AutomationSettings;
  projectPolicy: ProjectAutomationPolicy;
}): PersistedTask => {
  const policy = evaluateTaskPolicy({
    operation: "mark-ao-ready",
    task,
    automated: true,
    automationSettings,
    projectPolicy,
  });

  if (
    !hasLinkedGitHubIssue(task) ||
    task.owner !== "ai" ||
    policy.kind !== "allow" ||
    !hasAoReadyApproval(task) ||
    task.github.issueLabels?.includes("ao-ready")
  ) {
    return task;
  }

  const labels = addUniqueLabels(task.github.issueLabels, ["ao-ready"]);
  const event = createTaskEvent({
    taskId: task.id,
    type: "HANDOFF_READY",
    actor: "system",
    message: "Applied ao-ready label for Agent Orchestrator handoff.",
    createdAt: updatedAt,
    metadata: {
      issueNumber: task.github.issueNumber ?? null,
      issueLabels: labels.join(","),
      risk: task.risk,
    },
  });

  return {
    ...task,
    github: {
      ...task.github,
      issueLabels: labels,
      issueLastSyncedAt: updatedAt,
    },
    updatedAt,
    events: [...task.events, event],
  };
};
