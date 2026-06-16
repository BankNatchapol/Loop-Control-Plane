import type {
  EngineJob,
  EngineRunLogEntry,
  ExecutorConfig,
} from "@/lib/engine/loop-engine-types";
import { redactSensitiveText } from "@/lib/security/safe-context";

export type StubExecutorContext = {
  job: EngineJob;
  config: ExecutorConfig;
  signal?: AbortSignal;
};

export type StubExecutorResult = {
  success: boolean;
  stdoutSummary?: string;
  stderrSummary?: string;
  result?: Record<string, unknown>;
  error?: string;
  logs: EngineRunLogEntry[];
};

const nowIso = (): string => new Date().toISOString();

const logEntry = (
  level: EngineRunLogEntry["level"],
  message: string,
  metadata: EngineRunLogEntry["metadata"] = {},
): EngineRunLogEntry => ({
  timestamp: nowIso(),
  level,
  message: redactSensitiveText(message),
  metadata,
});

const summarizeOutput = (value: string | undefined): string | undefined => {
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

export const executeDeterministicStubJob = async (
  context: StubExecutorContext,
): Promise<StubExecutorResult> => {
  const logs: EngineRunLogEntry[] = [
    logEntry("info", `Stub executor started ${context.job.kind} job.`, {
      jobId: context.job.id,
      backend: context.config.backend,
    }),
  ];

  if (context.signal?.aborted) {
    return {
      success: false,
      error: "Execution cancelled before stub executor completed.",
      logs: [
        ...logs,
        logEntry("warn", "Stub executor cancelled before completion."),
      ],
    };
  }

  const stdout = summarizeOutput(
    typeof context.config.command === "string"
      ? `stub stdout: ${context.config.command}`
      : `stub stdout: completed deterministically (${context.job.kind})`,
  );
  const stderr = summarizeOutput("stub stderr: (empty)");

  logs.push(
    logEntry("info", "Stub executor completed deterministically.", {
      stdoutSummary: stdout,
      stderrSummary: stderr,
    }),
  );

  return {
    success: true,
    stdoutSummary: stdout,
    stderrSummary: stderr,
    result: {
      backend: context.config.backend,
      kind: context.job.kind,
      completedDeterministically: true,
    },
    logs,
  };
};
