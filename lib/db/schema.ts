import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type {
  EngineJobKind,
  EngineJobStatus,
  EngineRunLogEntry,
  EngineSchedulerState,
  ExecutorBackend,
} from "@/lib/engine/loop-engine-types";
import type {
  AoRuntimeState,
  Feature,
  FeatureEvent,
  FeatureEventType,
  FeatureArtifactStatus,
  FeatureStatus,
  GitHubState,
  HandoffState,
  KanbanStatus,
  Project,
  ProjectAutomationPolicy,
  RiskLevel,
  TaskEvent,
  TaskEventType,
  TaskMode,
  TaskOwner,
  TaskSource,
  Workflow,
  WorkflowArtifact,
  WorkflowEdge,
  WorkflowLogEntry,
  WorkflowNode,
  WorkflowNodeMode,
  WorkflowNodeState,
  WorkflowRiskPolicy,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunStep,
  WorkflowRunStepStatus,
} from "@/lib/loopboard";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey().$type<Project["id"]>(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  repository: text("repository").notNull(),
  repoPath: text("repo_path").notNull(),
  isGitRepository: text("is_git_repository").notNull().$type<"true" | "false">(),
  currentBranch: text("current_branch").notNull(),
  defaultBranch: text("default_branch").notNull(),
  githubRemoteUrl: text("github_remote_url").notNull(),
  githubRepository: text("github_repository").notNull(),
  specKitRoot: text("spec_kit_root").notNull(),
  specsPath: text("specs_path").notNull(),
  tasksPath: text("tasks_path").notNull(),
  workflowsPath: text("workflows_path").notNull(),
  handoffsPath: text("handoffs_path").notNull(),
  automationPolicy: text("automation_policy", { mode: "json" })
    .notNull()
    .$type<ProjectAutomationPolicy>(),
  engineSettings: text("engine_settings", { mode: "json" })
    .notNull()
    .$type<Project["engineSettings"]>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  updatedAt: text("updated_at").notNull(),
});

export const features = sqliteTable(
  "features",
  {
    id: text("id").primaryKey().$type<Feature["id"]>(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    summary: text("summary").notNull(),
    source: text("source").notNull().$type<TaskSource>(),
    artifactFolderPath: text("artifact_folder_path").notNull(),
    prdPath: text("prd_path").notNull(),
    specPath: text("spec_path").notNull(),
    planPath: text("plan_path").notNull(),
    tasksPath: text("tasks_path").notNull(),
    decisionsPath: text("decisions_path").notNull(),
    status: text("status").notNull().$type<FeatureStatus>(),
    artifacts: text("artifacts", { mode: "json" })
      .notNull()
      .$type<FeatureArtifactStatus>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("features_project_id_idx").on(table.projectId),
    index("features_status_idx").on(table.status),
    index("features_project_status_idx").on(table.projectId, table.status),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    featureId: text("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    status: text("status").notNull().$type<KanbanStatus>(),
    owner: text("owner").notNull().$type<TaskOwner>(),
    mode: text("mode").notNull().$type<TaskMode>(),
    risk: text("risk").notNull().$type<RiskLevel>(),
    source: text("source").notNull().$type<TaskSource>(),
    labels: text("labels", { mode: "json" }).notNull().$type<string[]>(),
    acceptanceCriteria: text("acceptance_criteria", { mode: "json" })
      .notNull()
      .$type<string[]>(),
    dependencies: text("dependencies", { mode: "json" })
      .notNull()
      .$type<string[]>(),
    branch: text("branch").notNull(),
    worktree: text("worktree").notNull(),
    github: text("github", { mode: "json" }).notNull().$type<GitHubState>(),
    handoff: text("handoff", { mode: "json" }).notNull().$type<HandoffState>(),
    aoRuntime: text("ao_runtime", { mode: "json" })
      .notNull()
      .$type<AoRuntimeState>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("tasks_project_id_idx").on(table.projectId),
    index("tasks_feature_id_idx").on(table.featureId),
    index("tasks_status_idx").on(table.status),
    index("tasks_owner_idx").on(table.owner),
    index("tasks_project_status_idx").on(table.projectId, table.status),
    index("tasks_feature_status_idx").on(table.featureId, table.status),
  ],
);

export const taskEvents = sqliteTable(
  "task_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    type: text("type").notNull().$type<TaskEventType>(),
    actor: text("actor").notNull().$type<TaskEvent["actor"]>(),
    message: text("message").notNull(),
    fromStatus: text("from_status").$type<KanbanStatus>(),
    toStatus: text("to_status").$type<KanbanStatus>(),
    fromOwner: text("from_owner").$type<TaskOwner>(),
    toOwner: text("to_owner").$type<TaskOwner>(),
    payload: text("payload", { mode: "json" })
      .notNull()
      .$type<Record<string, string | number | boolean | null>>(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("task_events_task_id_idx").on(table.taskId),
    index("task_events_created_at_idx").on(table.createdAt),
    index("task_events_task_created_at_idx").on(table.taskId, table.createdAt),
    index("task_events_type_idx").on(table.type),
  ],
);

export const featureEvents = sqliteTable(
  "feature_events",
  {
    id: text("id").primaryKey(),
    featureId: text("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    type: text("type").notNull().$type<FeatureEventType>(),
    actor: text("actor").notNull().$type<FeatureEvent["actor"]>(),
    message: text("message").notNull(),
    fromStatus: text("from_status").$type<FeatureStatus>(),
    toStatus: text("to_status").$type<FeatureStatus>(),
    payload: text("payload", { mode: "json" })
      .notNull()
      .$type<Record<string, string | number | boolean | null>>(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("feature_events_feature_id_idx").on(table.featureId),
    index("feature_events_created_at_idx").on(table.createdAt),
    index("feature_events_feature_created_at_idx").on(
      table.featureId,
      table.createdAt,
    ),
    index("feature_events_type_idx").on(table.type),
  ],
);

export const workflows = sqliteTable(
  "workflows",
  {
    id: text("id").primaryKey().$type<Workflow["id"]>(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    version: text("version").notNull(),
    config: text("config", { mode: "json" })
      .notNull()
      .$type<Record<string, unknown>>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("workflows_project_id_idx").on(table.projectId),
    index("workflows_project_updated_at_idx").on(table.projectId, table.updatedAt),
  ],
);

export const workflowNodes = sqliteTable(
  "workflow_nodes",
  {
    id: text("id").primaryKey().$type<WorkflowNode["id"]>(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    name: text("name").notNull(),
    mode: text("mode").notNull().$type<WorkflowNodeMode>(),
    position: text("position", { mode: "json" })
      .notNull()
      .$type<WorkflowNode["position"]>(),
    inputArtifacts: text("input_artifacts", { mode: "json" })
      .notNull()
      .$type<WorkflowArtifact[]>(),
    outputArtifacts: text("output_artifacts", { mode: "json" })
      .notNull()
      .$type<WorkflowArtifact[]>(),
    requireApproval: text("require_approval").notNull().$type<"true" | "false">(),
    maxRetries: text("max_retries").notNull(),
    riskPolicy: text("risk_policy").notNull().$type<WorkflowRiskPolicy>(),
    config: text("config", { mode: "json" })
      .notNull()
      .$type<Record<string, unknown>>(),
    currentState: text("current_state").notNull().$type<WorkflowNodeState>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("workflow_nodes_workflow_id_idx").on(table.workflowId),
    index("workflow_nodes_workflow_mode_idx").on(table.workflowId, table.mode),
    index("workflow_nodes_workflow_state_idx").on(
      table.workflowId,
      table.currentState,
    ),
  ],
);

export const workflowEdges = sqliteTable(
  "workflow_edges",
  {
    id: text("id").primaryKey().$type<WorkflowEdge["id"]>(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    sourceNodeId: text("source_node_id").notNull(),
    targetNodeId: text("target_node_id").notNull(),
    label: text("label").notNull(),
    dashed: integer("dashed").notNull().default(0),
    sourceHandle: text("source_handle"),
    targetHandle: text("target_handle"),
    condition: text("condition", { mode: "json" })
      .notNull()
      .$type<Record<string, unknown>>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("workflow_edges_workflow_id_idx").on(table.workflowId),
    index("workflow_edges_source_node_idx").on(table.workflowId, table.sourceNodeId),
    index("workflow_edges_target_node_idx").on(table.workflowId, table.targetNodeId),
  ],
);

export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey().$type<WorkflowRun["id"]>(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    featureId: text("feature_id").references(() => features.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().$type<WorkflowRunStatus>(),
    currentNodeId: text("current_node_id"),
    workflowVersion: text("workflow_version").notNull().default("1"),
    workflowSnapshot: text("workflow_snapshot", { mode: "json" })
      .notNull()
      .$type<Workflow>(),
    interruption: text("interruption", { mode: "json" })
      .$type<WorkflowRun["interruption"]>(),
    inputArtifacts: text("input_artifacts", { mode: "json" })
      .notNull()
      .$type<WorkflowArtifact[]>(),
    outputArtifacts: text("output_artifacts", { mode: "json" })
      .notNull()
      .$type<WorkflowArtifact[]>(),
    executionLogs: text("execution_logs", { mode: "json" })
      .notNull()
      .$type<WorkflowLogEntry[]>(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("workflow_runs_workflow_id_idx").on(table.workflowId),
    index("workflow_runs_project_id_idx").on(table.projectId),
    index("workflow_runs_feature_id_idx").on(table.featureId),
    index("workflow_runs_project_status_idx").on(table.projectId, table.status),
  ],
);

export const engineJobs = sqliteTable(
  "engine_jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull().$type<EngineJobKind>(),
    status: text("status").notNull().$type<EngineJobStatus>(),
    backend: text("backend").notNull().$type<ExecutorBackend>(),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    workflowRunId: text("workflow_run_id").references(() => workflowRuns.id, {
      onDelete: "set null",
    }),
    workflowNodeId: text("workflow_node_id"),
    payload: text("payload", { mode: "json" })
      .notNull()
      .$type<Record<string, unknown>>(),
    result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
    executionLogs: text("execution_logs", { mode: "json" })
      .notNull()
      .$type<EngineRunLogEntry[]>(),
    error: text("error"),
    attempt: text("attempt").notNull(),
    checkpoint: text("checkpoint", { mode: "json" })
      .notNull()
      .$type<WorkflowRunStep["checkpoint"]>(),
    maxAttempts: text("max_attempts").notNull(),
    queuedAt: text("queued_at").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("engine_jobs_status_idx").on(table.status),
    index("engine_jobs_status_queued_at_idx").on(table.status, table.queuedAt),
    index("engine_jobs_project_id_idx").on(table.projectId),
    index("engine_jobs_project_status_idx").on(table.projectId, table.status),
  ],
);

export const engineSchedulerState = sqliteTable("engine_scheduler_state", {
  id: text("id").primaryKey(),
  status: text("status").notNull().$type<EngineSchedulerState>(),
  lastTickAt: text("last_tick_at"),
  tickCount: text("tick_count").notNull(),
  lastError: text("last_error"),
  updatedAt: text("updated_at").notNull(),
});

export const workflowRunSteps = sqliteTable(
  "workflow_run_steps",
  {
    id: text("id").primaryKey().$type<WorkflowRunStep["id"]>(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    workflowNodeId: text("workflow_node_id").notNull(),
    status: text("status").notNull().$type<WorkflowRunStepStatus>(),
    attempt: text("attempt").notNull(),
    inputArtifacts: text("input_artifacts", { mode: "json" })
      .notNull()
      .$type<WorkflowArtifact[]>(),
    outputArtifacts: text("output_artifacts", { mode: "json" })
      .notNull()
      .$type<WorkflowArtifact[]>(),
    executionLogs: text("execution_logs", { mode: "json" })
      .notNull()
      .$type<WorkflowLogEntry[]>(),
    error: text("error"),
    requireApproval: text("require_approval").notNull().$type<"true" | "false">(),
    approvedAt: text("approved_at"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("workflow_run_steps_run_id_idx").on(table.runId),
    index("workflow_run_steps_node_id_idx").on(table.workflowNodeId),
    index("workflow_run_steps_run_status_idx").on(table.runId, table.status),
  ],
);

export type ProjectRow = typeof projects.$inferSelect;
export type FeatureRow = typeof features.$inferSelect;
export type FeatureEventRow = typeof featureEvents.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskEventRow = typeof taskEvents.$inferSelect;
export type WorkflowRow = typeof workflows.$inferSelect;
export type WorkflowNodeRow = typeof workflowNodes.$inferSelect;
export type WorkflowEdgeRow = typeof workflowEdges.$inferSelect;
export type EngineJobRow = typeof engineJobs.$inferSelect;
export type EngineSchedulerStateRow = typeof engineSchedulerState.$inferSelect;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type WorkflowRunStepRow = typeof workflowRunSteps.$inferSelect;
