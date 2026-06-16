import type {
  BackendExecutionContext,
  BackendExecutionResult,
} from "@/lib/engine/backends/backend-adapter";
import type { EngineRunLogEntry } from "@/lib/engine/loop-engine-types";
import type { ExecutorResult } from "@/lib/engine/executor-registry";
import {
  ProcessRunner,
  ProcessRunnerError,
  defaultProcessRunner,
  type ProcessCommandProfile,
  type ProcessRunResult,
} from "@/lib/engine/process-runner";
import { redactSensitiveText } from "@/lib/security/safe-context";

const activeBackendJobs = new Map<string, AbortController>();

const nowIso = (): string => new Date().toISOString();

export const backendLogEntry = (
  level: EngineRunLogEntry["level"],
  message: string,
  metadata: EngineRunLogEntry["metadata"] = {},
): EngineRunLogEntry => ({
  timestamp: nowIso(),
  level,
  message: redactSensitiveText(message),
  metadata,
});

export const summarizeBackendOutput = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const redacted = redactSensitiveText(trimmed);
  return redacted.length > 240 ? `${redacted.slice(0, 237)}...` : redacted;
};

export const backendUnavailableResult = (
  backend: string,
  message: string,
): BackendExecutionResult => ({
  success: false,
  error: message,
  errorCode: "backend_unavailable",
  logs: [
    backendLogEntry("error", message, { backend }),
  ],
});

export const runBackendProcessProfile = async (input: {
  profile: ProcessCommandProfile;
  args: string[];
  context: BackendExecutionContext;
  processRunner?: ProcessRunner;
}): Promise<{ run: ProcessRunResult; logs: EngineRunLogEntry[] }> => {
  const logs: EngineRunLogEntry[] = [];
  const runner = input.processRunner ?? defaultProcessRunner;

  logs.push(
    backendLogEntry("info", "Starting backend CLI invocation.", {
      backend: input.context.config.backend,
      profile: input.profile,
      jobId: input.context.job.id,
    }),
  );

  try {
    const run = await runner.run({
      profile: input.profile,
      args: input.args,
      cwd: input.context.cwd,
      projectRepoPath: input.context.projectRepoPath,
      timeoutMs: input.context.config.timeoutMs,
      envAllowlist: input.context.config.envAllowlist,
      signal: input.context.signal,
    });

    logs.push(
      backendLogEntry(run.success ? "info" : "error", "Backend CLI invocation finished.", {
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
        commandSummary: run.commandSummary,
      }),
    );

    return { run, logs };
  } catch (error) {
    if (error instanceof ProcessRunnerError && error.code === "process_profile_placeholder") {
      return {
        run: {
          success: false,
          exitCode: null,
          stdout: "",
          stderr: error.message,
          stdoutSummary: "",
          stderrSummary: summarizeBackendOutput(error.message) ?? error.message,
          timedOut: false,
          durationMs: 0,
          commandSummary: input.profile,
          profile: input.profile,
          command: input.profile,
          args: input.args,
        },
        logs: [
          ...logs,
          backendLogEntry("error", error.message, {
            code: error.code,
          }),
        ],
      };
    }

    const message =
      error instanceof Error ? error.message : "Backend CLI invocation failed unexpectedly.";

    return {
      run: {
        success: false,
        exitCode: null,
        stdout: "",
        stderr: message,
        stdoutSummary: "",
        stderrSummary: summarizeBackendOutput(message) ?? message,
        timedOut: false,
        durationMs: 0,
        commandSummary: input.profile,
        profile: input.profile,
        command: input.profile,
        args: input.args,
      },
      logs: [
        ...logs,
        backendLogEntry("error", message, {
          code:
            error instanceof ProcessRunnerError ? error.code : "backend_cli_failed",
        }),
      ],
    };
  }
};

export const processRunToBackendResult = (
  run: ProcessRunResult,
  logs: EngineRunLogEntry[],
): BackendExecutionResult => {
  const stdoutSummary = summarizeBackendOutput(run.stdoutSummary || run.stdout);
  const stderrSummary = summarizeBackendOutput(run.stderrSummary || run.stderr);

  if (run.timedOut) {
    return {
      success: false,
      error: "Backend CLI invocation timed out.",
      errorCode: "backend_timeout",
      stdoutSummary,
      stderrSummary,
      logs: [
        ...logs,
        backendLogEntry("error", "Backend CLI invocation timed out."),
      ],
    };
  }

  if (!run.success) {
    return {
      success: false,
      error: stderrSummary ?? stdoutSummary ?? `Backend CLI exited with code ${run.exitCode}.`,
      errorCode: run.exitCode === null ? "backend_cli_failed" : "backend_cli_failed",
      stdoutSummary,
      stderrSummary,
      logs,
    };
  }

  return {
    success: true,
    stdoutSummary,
    stderrSummary,
    result: {
      exitCode: run.exitCode,
      commandSummary: run.commandSummary,
    },
    logs,
  };
};

export const backendResultToExecutorResult = (
  result: BackendExecutionResult,
): ExecutorResult => ({
  success: result.success,
  stdoutSummary: result.stdoutSummary,
  stderrSummary: result.stderrSummary,
  error: result.error,
  result: {
    ...(result.result ?? {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.externalSessionId ? { externalSessionId: result.externalSessionId } : {}),
  },
  logs: result.logs,
});

export const trackBackendJob = (jobId: string): void => {
  activeBackendJobs.set(jobId, new AbortController());
};

export const releaseBackendJob = (jobId: string): void => {
  activeBackendJobs.delete(jobId);
};

export const cancelTrackedBackendJob = async (jobId: string): Promise<void> => {
  const controller = activeBackendJobs.get(jobId);
  if (controller) {
    controller.abort();
  }

  activeBackendJobs.delete(jobId);
};

export const truncatePromptForCli = (
  prompt: string,
  maxChars = 100_000,
): { prompt: string; truncated: boolean } => {
  if (prompt.length <= maxChars) {
    return { prompt, truncated: false };
  }

  return {
    prompt: `${prompt.slice(0, maxChars - 64)}\n\n[truncated for CLI argument length limits]`,
    truncated: true,
  };
};
