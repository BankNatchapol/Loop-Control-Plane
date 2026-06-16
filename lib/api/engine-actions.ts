import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { ValidationError } from "@/lib/db/loopboard-repository";
import type {
  EngineJob,
  EngineJobStatus,
  EngineRunLogEntry,
  EngineSchedulerStatus,
} from "@/lib/engine/loop-engine-types";
import {
  LoopScheduler,
  redactEngineLogEntry,
  type TickMode,
  type TickPlan,
  type TickResult,
} from "@/lib/engine/loop-scheduler";
import {
  describeEffectiveAutomationPolicy,
  type PolicyDecision,
} from "@/lib/policies/automation-policy";
import { redactSensitiveText } from "@/lib/security/safe-context";

const ENGINE_JOB_STATUSES: EngineJobStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
];

export type EngineJobSummary = {
  id: string;
  kind: EngineJob["kind"];
  status: EngineJobStatus;
  backend: EngineJob["backend"];
  projectId?: string;
  taskId?: string;
  attempt: number;
  maxAttempts: number;
  error?: string;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  logCount: number;
  lastLogMessage?: string;
};

export type EngineQueueCounts = Record<EngineJobStatus, number>;

export type EngineStatusResponse = {
  scheduler: EngineSchedulerStatus;
  queueCounts: EngineQueueCounts;
  recentJobs: EngineJobSummary[];
  automationPolicy: PolicyDecision;
};

export type EngineSchedulerActionResponse = {
  scheduler: EngineSchedulerStatus;
};

export type EngineTickResponse = {
  plan: TickPlan;
  job?: EngineJobSummary;
  scheduler: EngineSchedulerStatus;
};

export type EngineDemoJobResponse = {
  job: EngineJobSummary;
};

export const summarizeEngineJob = (job: EngineJob): EngineJobSummary => {
  const redactedLogs = job.executionLogs.map(redactEngineLogEntry);
  const lastLog = redactedLogs.at(-1);

  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    backend: job.backend,
    projectId: job.projectId,
    taskId: job.taskId,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    error: job.error ? redactSensitiveText(job.error) : undefined,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    logCount: redactedLogs.length,
    lastLogMessage: lastLog?.message,
  };
};

const emptyQueueCounts = (): EngineQueueCounts =>
  Object.fromEntries(
    ENGINE_JOB_STATUSES.map((status) => [status, 0]),
  ) as EngineQueueCounts;

export const buildEngineQueueCounts = (
  jobs: EngineJob[],
): EngineQueueCounts => {
  const counts = emptyQueueCounts();

  for (const job of jobs) {
    counts[job.status] += 1;
  }

  return counts;
};

export const getEngineStatus = (
  repository: LoopBoardRepository,
  options: { projectId?: string } = {},
): EngineStatusResponse => {
  const projectId =
    options.projectId === undefined
      ? undefined
      : options.projectId.trim().length > 0
        ? options.projectId
        : undefined;

  if (projectId) {
    repository.getProject(projectId);
  }

  const jobsForCounts = repository.listEngineJobs({ projectId });
  const recentJobs = repository
    .listEngineJobs({ projectId, limit: 10 })
    .map(summarizeEngineJob);

  return {
    scheduler: repository.getEngineSchedulerStatus(),
    queueCounts: buildEngineQueueCounts(jobsForCounts),
    recentJobs,
    automationPolicy: describeEffectiveAutomationPolicy({
      automationSettings: repository.getAutomationSettings(),
    }),
  };
};

export const startEngineScheduler = (
  repository: LoopBoardRepository,
): EngineSchedulerActionResponse => ({
  scheduler: new LoopScheduler(repository).start(),
});

export const stopEngineScheduler = (
  repository: LoopBoardRepository,
): EngineSchedulerActionResponse => ({
  scheduler: new LoopScheduler(repository).stop(),
});

export const tickEngine = async (
  repository: LoopBoardRepository,
  mode: TickMode = "manual",
): Promise<EngineTickResponse> => {
  const result: TickResult = await new LoopScheduler(repository).tick({ mode });

  return {
    plan: result.plan,
    job: result.job ? summarizeEngineJob(result.job) : undefined,
    scheduler: result.schedulerStatus,
  };
};

export const enqueueDemoPingJob = (
  repository: LoopBoardRepository,
  projectId: string,
): EngineDemoJobResponse => {
  const normalizedProjectId = projectId.trim();
  if (normalizedProjectId.length === 0) {
    throw new ValidationError("projectId is required.");
  }

  repository.getProject(normalizedProjectId);

  const job = repository.createEngineJob({
    kind: "demo-ping",
    backend: "stub",
    projectId: normalizedProjectId,
    payload: {
      source: "dashboard-demo",
    },
    executionLogs: [
      redactEngineLogEntry({
        timestamp: new Date().toISOString(),
        level: "info",
        message: "Demo ping job enqueued for manual tick execution.",
        metadata: { projectId: normalizedProjectId },
      }),
    ] satisfies EngineRunLogEntry[],
  });

  return { job: summarizeEngineJob(job) };
};

export const readEngineProjectId = (body: unknown): string => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Engine request payload must be an object.");
  }

  const projectId = (body as { projectId?: unknown }).projectId;
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    throw new ValidationError("projectId is required.");
  }

  return projectId.trim();
};

export const readEngineTickMode = (body: unknown): TickMode => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "manual";
  }

  const mode = (body as { mode?: unknown }).mode;
  if (mode === "automated" || mode === "manual") {
    return mode;
  }

  return "manual";
};
