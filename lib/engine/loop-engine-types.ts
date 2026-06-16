export type ExecutorBackend =
  | "stub"
  | "cursor"
  | "claude-code"
  | "codex"
  | "agent-orchestrator";

export type EngineJobKind = "demo-ping" | "task-run" | "workflow-step";

export type EngineJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type EngineSchedulerState = "stopped" | "running" | "paused";

export type ExecutorFanOutConfig = {
  maxConcurrency: number;
  issueIds: number[];
};

export type ExecutorConfig = {
  backend: ExecutorBackend;
  /** Legacy single command string; stub-only. External backends reject shell strings. */
  command?: string;
  /** CLI arguments passed without shell interpolation. */
  args?: string[];
  /** Legacy working directory field; prefer `cwd`. */
  workingDirectory?: string;
  /** Project-relative or absolute cwd constrained by process-runner validation. */
  cwd?: string;
  timeoutMs?: number;
  envAllowlist?: string[];
  /** Generated prompt file path relative to repo root (e.g. `.loopboard/tasks/.../task.md`). */
  promptFile?: string;
  /** Linked GitHub issue number for AO handoff or issue-scoped runs. */
  issueNumber?: number;
  /** Target git branch for agent worktrees or PR flows. */
  branch?: string;
  /** Parallel AO spawn settings for workflow fan-out nodes. */
  fanOut?: ExecutorFanOutConfig;
  /** Agent Orchestrator project id from `agent-orchestrator.yaml`. */
  aoProjectId?: string;
  /** Optional model id for Cursor / Claude / Codex backends. */
  model?: string;
};

export type WorkflowNodeExecutorConfig = Pick<
  ExecutorConfig,
  | "backend"
  | "args"
  | "cwd"
  | "timeoutMs"
  | "command"
  | "workingDirectory"
  | "promptFile"
  | "issueNumber"
  | "branch"
  | "fanOut"
  | "aoProjectId"
  | "model"
>;

export type EngineRunLogLevel = "info" | "warn" | "error";

export type EngineRunLogEntry = {
  timestamp: string;
  level: EngineRunLogLevel;
  message: string;
  metadata?: Record<string, unknown>;
};

export type TaskRunAction = "execute" | "review" | "handoff";

export type TaskRunTrigger = "scheduler" | "manual" | "workflow";

export type TaskRunJobPayload = {
  taskId: string;
  projectId: string;
  action: TaskRunAction;
  executorConfig: ExecutorConfig;
  contextPaths?: string[];
  trigger: TaskRunTrigger;
};

export type EngineJob = {
  id: string;
  kind: EngineJobKind;
  status: EngineJobStatus;
  backend: ExecutorBackend;
  projectId?: string;
  taskId?: string;
  workflowRunId?: string;
  workflowNodeId?: string;
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
  executionLogs: EngineRunLogEntry[];
  error?: string;
  attempt: number;
  maxAttempts: number;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type EngineSchedulerStatus = {
  status: EngineSchedulerState;
  lastTickAt?: string;
  tickCount: number;
  lastError?: string;
  updatedAt: string;
};

export const EXECUTOR_CONFIG_KEY = "executor";

export const EXECUTOR_BACKENDS: readonly ExecutorBackend[] = [
  "stub",
  "cursor",
  "claude-code",
  "codex",
  "agent-orchestrator",
] as const;

export const IMPLEMENTED_EXECUTOR_BACKENDS: readonly ExecutorBackend[] = [
  "stub",
] as const;

export const isExecutorBackend = (value: unknown): value is ExecutorBackend =>
  typeof value === "string" &&
  (EXECUTOR_BACKENDS as readonly string[]).includes(value);

export const isEngineJobKind = (value: unknown): value is EngineJobKind =>
  value === "demo-ping" || value === "task-run" || value === "workflow-step";

export type ExecutorConfigValidationIssue = {
  field: string;
  message: string;
};

export type ExecutorConfigValidationResult =
  | { ok: true; config: ExecutorConfig }
  | { ok: false; code: string; message: string; issues: ExecutorConfigValidationIssue[] };

export type ExecutorResolutionResult =
  | { ok: true; backend: ExecutorBackend; jobKind: EngineJobKind }
  | { ok: false; code: string; message: string; reasons: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

export const readExecutorConfig = (
  config: Record<string, unknown>,
): ExecutorConfig | undefined => {
  const nested = config[EXECUTOR_CONFIG_KEY];
  if (nested !== undefined) {
    const validation = validateExecutorConfig(nested);
    return validation.ok ? validation.config : undefined;
  }

  if (!isExecutorBackend(config.backend)) {
    return undefined;
  }

  const validation = validateExecutorConfig(config);
  return validation.ok ? validation.config : undefined;
};

export const withExecutorConfig = (
  config: Record<string, unknown>,
  executorConfig: ExecutorConfig,
): Record<string, unknown> => ({
  ...config,
  [EXECUTOR_CONFIG_KEY]: executorConfig,
});

export const validateExecutorConfig = (
  value: unknown,
): ExecutorConfigValidationResult => {
  if (!isRecord(value)) {
    return {
      ok: false,
      code: "executor_config_invalid",
      message: "Executor config must be an object.",
      issues: [{ field: "executor", message: "Expected a JSON object." }],
    };
  }

  const issues: ExecutorConfigValidationIssue[] = [];

  if (!isExecutorBackend(value.backend)) {
    issues.push({
      field: "backend",
      message: `Backend must be one of: ${EXECUTOR_BACKENDS.join(", ")}.`,
    });
  }

  if (value.command !== undefined && typeof value.command !== "string") {
    issues.push({ field: "command", message: "Command must be a string." });
  }

  if (value.args !== undefined) {
    if (
      !Array.isArray(value.args) ||
      !value.args.every((entry) => typeof entry === "string")
    ) {
      issues.push({
        field: "args",
        message: "Args must be an array of strings.",
      });
    }
  }

  if (
    value.workingDirectory !== undefined &&
    typeof value.workingDirectory !== "string"
  ) {
    issues.push({
      field: "workingDirectory",
      message: "Working directory must be a string.",
    });
  }

  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    issues.push({ field: "cwd", message: "Working directory must be a string." });
  }

  if (value.timeoutMs !== undefined) {
    if (
      typeof value.timeoutMs !== "number" ||
      !Number.isFinite(value.timeoutMs) ||
      value.timeoutMs <= 0
    ) {
      issues.push({
        field: "timeoutMs",
        message: "Timeout must be a positive number of milliseconds.",
      });
    }
  }

  if (value.envAllowlist !== undefined && !isStringArray(value.envAllowlist)) {
    issues.push({
      field: "envAllowlist",
      message: "Environment allowlist must be an array of strings.",
    });
  }

  if (value.promptFile !== undefined) {
    if (typeof value.promptFile !== "string" || value.promptFile.trim().length === 0) {
      issues.push({
        field: "promptFile",
        message: "Prompt file must be a non-empty string path.",
      });
    } else if (/[;&|`$<>]/u.test(value.promptFile)) {
      issues.push({
        field: "promptFile",
        message: "Prompt file path cannot contain shell metacharacters.",
      });
    }
  }

  if (value.issueNumber !== undefined) {
    if (
      typeof value.issueNumber !== "number" ||
      !Number.isInteger(value.issueNumber) ||
      value.issueNumber <= 0
    ) {
      issues.push({
        field: "issueNumber",
        message: "Issue number must be a positive integer.",
      });
    }
  }

  if (value.branch !== undefined) {
    if (typeof value.branch !== "string" || value.branch.trim().length === 0) {
      issues.push({
        field: "branch",
        message: "Branch must be a non-empty string.",
      });
    }
  }

  if (value.aoProjectId !== undefined) {
    if (typeof value.aoProjectId !== "string" || value.aoProjectId.trim().length === 0) {
      issues.push({
        field: "aoProjectId",
        message: "Agent Orchestrator project id must be a non-empty string.",
      });
    }
  }

  if (value.model !== undefined) {
    if (typeof value.model !== "string" || value.model.trim().length === 0) {
      issues.push({
        field: "model",
        message: "Model must be a non-empty string.",
      });
    }
  }

  if (value.fanOut !== undefined) {
    if (!isRecord(value.fanOut)) {
      issues.push({
        field: "fanOut",
        message: "Fan-out config must be an object.",
      });
    } else {
      if (
        typeof value.fanOut.maxConcurrency !== "number" ||
        !Number.isInteger(value.fanOut.maxConcurrency) ||
        value.fanOut.maxConcurrency <= 0
      ) {
        issues.push({
          field: "fanOut.maxConcurrency",
          message: "Fan-out maxConcurrency must be a positive integer.",
        });
      }

      if (
        !Array.isArray(value.fanOut.issueIds) ||
        !value.fanOut.issueIds.every(
          (entry) => typeof entry === "number" && Number.isInteger(entry) && entry > 0,
        )
      ) {
        issues.push({
          field: "fanOut.issueIds",
          message: "Fan-out issueIds must be an array of positive integers.",
        });
      }
    }
  }

  if (issues.length > 0) {
    return {
      ok: false,
      code: "executor_config_invalid",
      message: "Executor config failed validation.",
      issues,
    };
  }

  const workingDirectory =
    typeof value.cwd === "string"
      ? value.cwd
      : typeof value.workingDirectory === "string"
        ? value.workingDirectory
        : undefined;

  const args = Array.isArray(value.args)
    ? value.args.filter((entry): entry is string => typeof entry === "string")
    : undefined;

  return {
    ok: true,
    config: {
      backend: value.backend as ExecutorBackend,
      ...(typeof value.command === "string" ? { command: value.command } : {}),
      ...(args && args.length > 0 ? { args } : {}),
      ...(workingDirectory ? { workingDirectory, cwd: workingDirectory } : {}),
      ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
      ...(isStringArray(value.envAllowlist)
        ? { envAllowlist: value.envAllowlist }
        : {}),
      ...(typeof value.promptFile === "string" ? { promptFile: value.promptFile } : {}),
      ...(typeof value.issueNumber === "number" ? { issueNumber: value.issueNumber } : {}),
      ...(typeof value.branch === "string" ? { branch: value.branch } : {}),
      ...(typeof value.aoProjectId === "string" ? { aoProjectId: value.aoProjectId } : {}),
      ...(typeof value.model === "string" ? { model: value.model } : {}),
      ...(isRecord(value.fanOut) &&
      typeof value.fanOut.maxConcurrency === "number" &&
      Array.isArray(value.fanOut.issueIds)
        ? {
            fanOut: {
              maxConcurrency: value.fanOut.maxConcurrency,
              issueIds: value.fanOut.issueIds.filter(
                (entry): entry is number =>
                  typeof entry === "number" && Number.isInteger(entry) && entry > 0,
              ),
            },
          }
        : {}),
    },
  };
};

export const defaultExecutorConfig = (
  backend: ExecutorBackend = "stub",
): ExecutorConfig => ({
  backend,
});

export const describeExecutorBackendAvailability = (
  backend: ExecutorBackend,
): { available: boolean; message: string } => {
  if (!(IMPLEMENTED_EXECUTOR_BACKENDS as readonly string[]).includes(backend)) {
    return {
      available: false,
      message: `Executor backend "${backend}" is recognized but not enabled in this phase.`,
    };
  }

  return {
    available: true,
    message: `Executor backend "${backend}" is available.`,
  };
};

export const resolveExecutorTarget = (
  backend: unknown,
  jobKind: unknown,
): ExecutorResolutionResult => {
  const reasons: string[] = [];

  if (!isExecutorBackend(backend)) {
    return {
      ok: false,
      code: "executor_backend_unknown",
      message: "Unknown executor backend.",
      reasons: [
        typeof backend === "string"
          ? `Backend "${backend}" is not supported.`
          : "Backend must be a supported executor identifier.",
        `Supported backends: ${EXECUTOR_BACKENDS.join(", ")}.`,
      ],
    };
  }

  if (!isEngineJobKind(jobKind)) {
    return {
      ok: false,
      code: "engine_job_kind_unknown",
      message: "Unknown engine job kind.",
      reasons: [
        typeof jobKind === "string"
          ? `Job kind "${jobKind}" is not supported.`
          : "Job kind must be a supported engine job identifier.",
        "Supported kinds: demo-ping, task-run, workflow-step.",
      ],
    };
  }

  const availability = describeExecutorBackendAvailability(backend);
  if (!availability.available) {
    reasons.push(availability.message);
    reasons.push(
      "Only the stub backend is registered for Phase 01; real CLI executors arrive in later phases.",
    );

    return {
      ok: false,
      code: "executor_backend_disabled",
      message: `Executor backend "${backend}" is not available.`,
      reasons,
    };
  }

  return { ok: true, backend, jobKind };
};

export const TASK_RUN_ACTIONS: readonly TaskRunAction[] = [
  "execute",
  "review",
  "handoff",
] as const;

export const TASK_RUN_TRIGGERS: readonly TaskRunTrigger[] = [
  "scheduler",
  "manual",
  "workflow",
] as const;

export const isTaskRunAction = (value: unknown): value is TaskRunAction =>
  typeof value === "string" &&
  (TASK_RUN_ACTIONS as readonly string[]).includes(value);

export const isTaskRunTrigger = (value: unknown): value is TaskRunTrigger =>
  typeof value === "string" &&
  (TASK_RUN_TRIGGERS as readonly string[]).includes(value);

export type TaskRunPayloadValidationResult =
  | { ok: true; payload: TaskRunJobPayload }
  | { ok: false; code: string; message: string; issues: ExecutorConfigValidationIssue[] };

export const buildTaskRunJobPayload = (
  input: TaskRunJobPayload,
): Record<string, unknown> => ({
  taskId: input.taskId,
  projectId: input.projectId,
  action: input.action,
  executorConfig: input.executorConfig,
  ...(input.contextPaths ? { contextPaths: input.contextPaths } : {}),
  trigger: input.trigger,
});

export const validateTaskRunJobPayload = (
  value: unknown,
): TaskRunPayloadValidationResult => {
  if (!isRecord(value)) {
    return {
      ok: false,
      code: "task_run_payload_invalid",
      message: "Task-run payload must be an object.",
      issues: [{ field: "payload", message: "Expected a JSON object." }],
    };
  }

  const issues: ExecutorConfigValidationIssue[] = [];

  if (typeof value.taskId !== "string" || value.taskId.trim().length === 0) {
    issues.push({ field: "taskId", message: "Task id is required." });
  }

  if (typeof value.projectId !== "string" || value.projectId.trim().length === 0) {
    issues.push({ field: "projectId", message: "Project id is required." });
  }

  if (!isTaskRunAction(value.action)) {
    issues.push({
      field: "action",
      message: `Action must be one of: ${TASK_RUN_ACTIONS.join(", ")}.`,
    });
  }

  if (!isTaskRunTrigger(value.trigger)) {
    issues.push({
      field: "trigger",
      message: `Trigger must be one of: ${TASK_RUN_TRIGGERS.join(", ")}.`,
    });
  }

  const executorValidation = validateExecutorConfig(value.executorConfig);
  if (!executorValidation.ok) {
    issues.push(...executorValidation.issues.map((issue) => ({
      field: `executorConfig.${issue.field}`,
      message: issue.message,
    })));
  }

  if (value.contextPaths !== undefined) {
    if (
      !Array.isArray(value.contextPaths) ||
      !value.contextPaths.every((entry) => typeof entry === "string")
    ) {
      issues.push({
        field: "contextPaths",
        message: "Context paths must be an array of strings.",
      });
    }
  }

  if (issues.length > 0) {
    return {
      ok: false,
      code: "task_run_payload_invalid",
      message: "Task-run payload failed validation.",
      issues,
    };
  }

  if (!executorValidation.ok) {
    return {
      ok: false,
      code: "task_run_payload_invalid",
      message: "Task-run payload failed validation.",
      issues,
    };
  }

  const contextPaths = Array.isArray(value.contextPaths)
    ? value.contextPaths.filter((entry): entry is string => typeof entry === "string")
    : undefined;

  return {
    ok: true,
    payload: {
      taskId: value.taskId as string,
      projectId: value.projectId as string,
      action: value.action as TaskRunAction,
      executorConfig: executorValidation.config,
      ...(contextPaths && contextPaths.length > 0 ? { contextPaths } : {}),
      trigger: value.trigger as TaskRunTrigger,
    },
  };
};

export const parseTaskRunJobPayload = (
  payload: Record<string, unknown>,
): TaskRunJobPayload | undefined => {
  const validation = validateTaskRunJobPayload(payload);
  return validation.ok ? validation.payload : undefined;
};
