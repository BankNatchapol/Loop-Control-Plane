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

export type ExecutorConfig = {
  backend: ExecutorBackend;
  command?: string;
  workingDirectory?: string;
  timeoutMs?: number;
  envAllowlist?: string[];
};

export type EngineRunLogLevel = "info" | "warn" | "error";

export type EngineRunLogEntry = {
  timestamp: string;
  level: EngineRunLogLevel;
  message: string;
  metadata?: Record<string, unknown>;
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

  if (
    value.workingDirectory !== undefined &&
    typeof value.workingDirectory !== "string"
  ) {
    issues.push({
      field: "workingDirectory",
      message: "Working directory must be a string.",
    });
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

  if (issues.length > 0) {
    return {
      ok: false,
      code: "executor_config_invalid",
      message: "Executor config failed validation.",
      issues,
    };
  }

  return {
    ok: true,
    config: {
      backend: value.backend as ExecutorBackend,
      ...(typeof value.command === "string" ? { command: value.command } : {}),
      ...(typeof value.workingDirectory === "string"
        ? { workingDirectory: value.workingDirectory }
        : {}),
      ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
      ...(isStringArray(value.envAllowlist)
        ? { envAllowlist: value.envAllowlist }
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
