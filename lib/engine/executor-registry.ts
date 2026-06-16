import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { dispatchWorkflowStepJob } from "@/lib/engine/executors/workflow-step-dispatcher";
import { redactSensitiveText } from "@/lib/security/safe-context";

import {
  defaultExecutorConfig,
  describeExecutorBackendAvailability,
  isEngineJobKind,
  isExecutorBackend,
  resolveExecutorTarget,
  validateExecutorConfig,
  type EngineJob,
  type EngineJobKind,
  type EngineRunLogEntry,
  type ExecutorBackend,
  type ExecutorConfig,
  type ExecutorConfigValidationResult,
  type ExecutorResolutionResult,
} from "@/lib/engine/loop-engine-types";

export type ExecutorContext = {
  job: EngineJob;
  config: ExecutorConfig;
  signal?: AbortSignal;
};

export type ExecutorResult = {
  success: boolean;
  stdoutSummary?: string;
  stderrSummary?: string;
  result?: Record<string, unknown>;
  error?: string;
  logs: EngineRunLogEntry[];
};

export interface Executor {
  readonly backend: ExecutorBackend;
  readonly supportedJobKinds: readonly EngineJobKind[];
  canHandle(backend: ExecutorBackend, jobKind: EngineJobKind): boolean;
  execute(context: ExecutorContext): Promise<ExecutorResult>;
  cancel(jobId: string): Promise<void>;
}

export class ExecutorRegistryError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly reasons: string[] = [],
  ) {
    super(message);
  }
}

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

const activeStubJobs = new Set<string>();

export type StubExecutorOptions = {
  workflowStepHandler?: (context: ExecutorContext) => Promise<ExecutorResult>;
};

export class StubExecutor implements Executor {
  readonly backend = "stub" as const;
  readonly supportedJobKinds = [
    "demo-ping",
    "task-run",
    "workflow-step",
  ] as const;

  constructor(private readonly options: StubExecutorOptions = {}) {}

  canHandle(backend: ExecutorBackend, jobKind: EngineJobKind): boolean {
    return backend === this.backend && this.supportedJobKinds.includes(jobKind);
  }

  async execute(context: ExecutorContext): Promise<ExecutorResult> {
    if (context.job.kind === "workflow-step" && this.options.workflowStepHandler) {
      return this.options.workflowStepHandler(context);
    }

    activeStubJobs.add(context.job.id);

    const logs: EngineRunLogEntry[] = [
      logEntry("info", `Stub executor started ${context.job.kind} job.`, {
        jobId: context.job.id,
        backend: this.backend,
      }),
    ];

    if (context.signal?.aborted) {
      activeStubJobs.delete(context.job.id);
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

    activeStubJobs.delete(context.job.id);

    return {
      success: true,
      stdoutSummary: stdout,
      stderrSummary: stderr,
      result: {
        backend: this.backend,
        kind: context.job.kind,
        completedDeterministically: true,
      },
      logs,
    };
  }

  async cancel(jobId: string): Promise<void> {
    activeStubJobs.delete(jobId);
  }
}

export const defaultStubExecutor = new StubExecutor();

export const createExecutorRegistryForRepository = (
  repository: LoopBoardRepository,
): ExecutorRegistry =>
  new ExecutorRegistry([
    new StubExecutor({
      workflowStepHandler: (context) =>
        dispatchWorkflowStepJob(context, { repository }),
    }),
  ]);

export class ExecutorRegistry {
  private readonly executors = new Map<ExecutorBackend, Executor>();

  constructor(initialExecutors: Executor[] = [defaultStubExecutor]) {
    for (const executor of initialExecutors) {
      this.register(executor);
    }
  }

  register(executor: Executor): void {
    this.executors.set(executor.backend, executor);
  }

  listRegisteredBackends(): ExecutorBackend[] {
    return [...this.executors.keys()];
  }

  resolve(
    backend: unknown,
    jobKind: unknown,
  ): ExecutorResolutionResult & { executor?: Executor } {
    const target = resolveExecutorTarget(backend, jobKind);
    if (!target.ok) {
      return target;
    }

    const executor = this.executors.get(target.backend);
    if (!executor) {
      const availability = describeExecutorBackendAvailability(target.backend);
      return {
        ok: false,
        code: "executor_backend_disabled",
        message: `No executor registered for backend "${target.backend}".`,
        reasons: [
          availability.message,
          `Registered backends: ${this.listRegisteredBackends().join(", ") || "none"}.`,
        ],
      };
    }

    if (!executor.canHandle(target.backend, target.jobKind)) {
      return {
        ok: false,
        code: "executor_job_kind_unsupported",
        message: `Backend "${target.backend}" does not handle job kind "${target.jobKind}".`,
        reasons: [
          `Supported kinds for ${target.backend}: ${executor.supportedJobKinds.join(", ")}.`,
        ],
      };
    }

    return { ...target, executor };
  }

  requireExecutor(backend: unknown, jobKind: unknown): Executor {
    const resolution = this.resolve(backend, jobKind);
    if (!resolution.ok) {
      throw new ExecutorRegistryError(
        resolution.message,
        resolution.code,
        resolution.reasons,
      );
    }

    if (!resolution.executor) {
      throw new ExecutorRegistryError(
        `No executor registered for backend "${resolution.backend}".`,
        "executor_backend_disabled",
        [describeExecutorBackendAvailability(resolution.backend).message],
      );
    }

    return resolution.executor;
  }

  async executeJob(
    job: EngineJob,
    configInput: unknown,
    signal?: AbortSignal,
  ): Promise<ExecutorResult> {
    const configValidation = validateExecutorConfig(
      configInput ?? defaultExecutorConfig(job.backend),
    );
    if (!configValidation.ok) {
      throw new ExecutorRegistryError(
        configValidation.message,
        configValidation.code,
        configValidation.issues.map((issue) => `${issue.field}: ${issue.message}`),
      );
    }

    const executor = this.requireExecutor(
      configValidation.config.backend,
      job.kind,
    );

    return executor.execute({
      job,
      config: configValidation.config,
      signal,
    });
  }

  async cancelJob(job: EngineJob): Promise<void> {
    const executor = this.executors.get(job.backend);
    if (!executor) {
      throw new ExecutorRegistryError(
        `No executor registered for backend "${job.backend}".`,
        "executor_backend_disabled",
        [describeExecutorBackendAvailability(job.backend).message],
      );
    }

    await executor.cancel(job.id);
  }
}

export const defaultExecutorRegistry = new ExecutorRegistry();

export const parseExecutorConfig = (
  value: unknown,
): ExecutorConfigValidationResult => validateExecutorConfig(value);

export const explainExecutorResolution = (
  backend: unknown,
  jobKind: unknown,
  registry: ExecutorRegistry = defaultExecutorRegistry,
): ExecutorResolutionResult => registry.resolve(backend, jobKind);

export const isRegisteredExecutorBackend = (
  backend: unknown,
  registry: ExecutorRegistry = defaultExecutorRegistry,
): backend is ExecutorBackend =>
  isExecutorBackend(backend) && registry.listRegisteredBackends().includes(backend);

export const resolveExecutorConfigForJob = (
  job: Pick<EngineJob, "backend" | "kind" | "payload">,
): ExecutorConfig => {
  const payloadConfig = job.payload.executor;
  if (payloadConfig !== undefined) {
    const validation = validateExecutorConfig(payloadConfig);
    if (validation.ok) {
      return validation.config;
    }
  }

  return defaultExecutorConfig(job.backend);
};

export { validateExecutorConfig, resolveExecutorTarget, isExecutorBackend, isEngineJobKind };
