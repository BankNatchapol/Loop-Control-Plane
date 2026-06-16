import type {
  EngineJob,
  EngineRunLogEntry,
  ExecutorBackend,
  ExecutorConfig,
} from "@/lib/engine/loop-engine-types";
import { validateLocalDirectory } from "@/lib/system/local-command-runner";

export type BackendPollStatus = "running" | "completed" | "failed" | "cancelled";

export type BackendPollResult = {
  status: BackendPollStatus;
  summary: string;
  artifacts?: Record<string, unknown>;
};

export type BackendAvailabilityResult = {
  backend: ExecutorBackend;
  available: boolean;
  message: string;
  version?: string;
};

export type BackendExecutionContext = {
  job: EngineJob;
  config: ExecutorConfig;
  /** Absolute path to the project repository root. */
  projectRepoPath: string;
  /** Resolved working directory constrained under `projectRepoPath`. */
  cwd: string;
  signal?: AbortSignal;
};

export type BackendExecutionResult = {
  success: boolean;
  externalSessionId?: string;
  stdoutSummary?: string;
  stderrSummary?: string;
  error?: string;
  errorCode?: string;
  result?: Record<string, unknown>;
  logs: EngineRunLogEntry[];
};

export type BackendPollContext = Pick<
  BackendExecutionContext,
  "projectRepoPath" | "cwd" | "config"
>;

/**
 * Contract for external agent backends (Cursor, Claude Code, Codex, Agent Orchestrator).
 *
 * Implementations must:
 * - Resolve cwd through {@link resolveBackendWorkingDirectory} (or equivalent validation)
 * - Invoke fixed CLI argv via process-runner profiles — never interpolate `config.command`
 * - Treat stdout/stderr as untrusted and redact before persisting summaries
 */
export interface BackendAdapter {
  readonly backend: ExecutorBackend;
  checkAvailability(): Promise<BackendAvailabilityResult>;
  execute(context: BackendExecutionContext): Promise<BackendExecutionResult>;
  cancel(jobId: string): Promise<void>;
  poll?(job: EngineJob, context: BackendPollContext): Promise<BackendPollResult>;
}

export class BackendAdapterError extends Error {
  constructor(
    message: string,
    readonly code = "backend_adapter_failed",
    readonly statusCode = 500,
  ) {
    super(message);
  }
}

export const EXTERNAL_EXECUTOR_BACKENDS: readonly ExecutorBackend[] = [
  "cursor",
  "claude-code",
  "codex",
  "agent-orchestrator",
] as const;

export const isExternalExecutorBackend = (
  backend: ExecutorBackend,
): backend is Exclude<ExecutorBackend, "stub"> =>
  (EXTERNAL_EXECUTOR_BACKENDS as readonly string[]).includes(backend);

/**
 * External backends use audited argv profiles only. Legacy `command` strings are rejected.
 */
export const assertSafeBackendConfig = (config: ExecutorConfig): void => {
  if (!isExternalExecutorBackend(config.backend)) {
    return;
  }

  if (typeof config.command === "string" && config.command.trim().length > 0) {
    throw new BackendAdapterError(
      `Backend "${config.backend}" does not accept shell command strings from node config.`,
      "shell_command_rejected",
      400,
    );
  }
};

export const resolveBackendWorkingDirectory = (
  config: ExecutorConfig,
  projectRepoPath: string,
): string => {
  const requested = config.cwd ?? config.workingDirectory ?? projectRepoPath;

  return validateLocalDirectory({
    path: requested,
    basePath: projectRepoPath,
    missingCode: "backend_cwd_missing",
    notDirectoryCode: "backend_cwd_not_directory",
    traversalCode: "backend_cwd_traversal_rejected",
  });
};

export const buildBackendExecutionContext = (input: {
  job: EngineJob;
  config: ExecutorConfig;
  projectRepoPath: string;
  signal?: AbortSignal;
}): BackendExecutionContext => {
  assertSafeBackendConfig(input.config);

  return {
    job: input.job,
    config: input.config,
    projectRepoPath: input.projectRepoPath,
    cwd: resolveBackendWorkingDirectory(input.config, input.projectRepoPath),
    ...(input.signal ? { signal: input.signal } : {}),
  };
};
