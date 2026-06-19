import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { NotFoundError, ValidationError } from "@/lib/db/loopboard-repository";
import type { ListEngineJobsOptions } from "@/lib/db/loopboard-repository";
import type {
  EngineJob,
  EngineJobStatus,
  EngineRunLogEntry,
  EngineSchedulerStatus,
  ExecutorBackend,
} from "@/lib/engine/loop-engine-types";
import { readAoWorkerPoolSnapshot } from "@/lib/engine/ao-worker-pool-types";
import {
  LoopScheduler,
  redactEngineLogEntry,
  type TickMode,
  type TickPlan,
  type TickResult,
} from "@/lib/engine/loop-scheduler";
import {
  startSchedulerBackgroundTicks,
  stopSchedulerBackgroundTicks,
} from "@/lib/engine/scheduler-interval";
import {
  assertEnginePolicyAllowed,
  describeEffectiveAutomationPolicy,
  type PolicyDecision,
} from "@/lib/policies/automation-policy";
import {
  extractWorkflowRunPauseReason,
  isProjectAutoAdvanceEnabled,
  type AutoAdvanceStopReason,
} from "@/lib/engine/auto-advance";
import {
  cancelEngineJob,
  describeEngineJobOperatorActions,
  describeWorkflowRunEngineResume,
  retryEngineJob,
  type EngineJobOperatorActionState,
  type EngineJobOperatorActions,
  type WorkflowRunEngineResumeAction,
} from "@/lib/engine/engine-job-recovery";
import type { WorkflowRun } from "@/lib/loopboard";
import { redactSensitiveText } from "@/lib/security/safe-context";
import { resumeWorkflowRunFromEngine } from "@/lib/workflows/workflow-runner";

const ENGINE_JOB_STATUSES: EngineJobStatus[] = [
  "queued",
  "running",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
];

export type EngineJobSummary = {
  id: string;
  kind: EngineJob["kind"];
  status: EngineJobStatus;
  backend: EngineJob["backend"];
  runtimeLabel?: string;
  projectId?: string;
  taskId?: string;
  workflowRunId?: string;
  workflowNodeId?: string;
  attempt: number;
  maxAttempts: number;
  error?: string;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  logCount: number;
  lastLogMessage?: string;
  aoWorkerPool?: import("@/lib/engine/ao-worker-pool-types").AoWorkerPoolSnapshot;
};

export type EngineQueueCounts = Record<EngineJobStatus, number>;

export type EngineJobPolicyDecision = {
  timestamp: string;
  message: string;
  code?: string;
  kind?: string;
};

export type EngineJobDetail = EngineJobSummary & {
  executionLogs: EngineRunLogEntry[];
  payloadSummary: Record<string, unknown>;
  resultSummary?: Record<string, unknown>;
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
  policyDecisions: EngineJobPolicyDecision[];
  externalSessionIds: string[];
  operatorActions: EngineJobOperatorActions;
};

export type EngineJobRecoveryResponse = {
  job: EngineJobSummary;
};

export type WorkflowRunEngineResumeResponse = {
  run: WorkflowRun;
  resume: WorkflowRunEngineResumeAction;
};

export type EngineJobListResponse = {
  jobs: EngineJobSummary[];
};

export type EngineJobMetrics = {
  windowHours: number;
  since: string;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  averageDurationMs: number | null;
  failureRate: number | null;
};

export type EngineAutoAdvanceStatus = {
  projectEnabled: boolean;
  globallyEnabled: boolean;
  active: boolean;
  pauseReason?: AutoAdvanceStopReason;
  workflowRunId?: string;
};

export type EngineStatusResponse = {
  scheduler: EngineSchedulerStatus;
  queueCounts: EngineQueueCounts;
  recentJobs: EngineJobSummary[];
  automationPolicy: PolicyDecision;
  autoAdvance?: EngineAutoAdvanceStatus;
  workflowRunResume?: WorkflowRunEngineResumeAction;
  activeJobCount: number;
  metrics?: EngineJobMetrics;
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
  const aoWorkerPool = readAoWorkerPoolSnapshot(job.result);
  const executor =
    job.payload.executor &&
    typeof job.payload.executor === "object" &&
    !Array.isArray(job.payload.executor)
      ? (job.payload.executor as Record<string, unknown>)
      : undefined;
  const runtimeLabel =
    job.payload.nodeType === "agent-orchestrator-implement"
      ? `Agent Orchestrator · ${
          executor?.aoAgentPlugin === "cursor"
            ? "Cursor"
            : executor?.aoAgentPlugin === "codex"
              ? "Codex"
              : "Claude Code"
        }`
      : undefined;

  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    backend: job.backend,
    ...(runtimeLabel ? { runtimeLabel } : {}),
    projectId: job.projectId,
    taskId: job.taskId,
    workflowRunId: job.workflowRunId,
    workflowNodeId: job.workflowNodeId,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    error: job.error ? redactSensitiveText(job.error) : undefined,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    logCount: redactedLogs.length,
    lastLogMessage: lastLog?.message,
    ...(aoWorkerPool ? { aoWorkerPool } : {}),
  };
};

const redactUnknownValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactUnknownValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactUnknownValue(entry)]),
    );
  }

  return value;
};

const readJobExcerpt = (
  job: EngineJob,
  field: "stdoutSummary" | "stderrSummary",
): string | undefined => {
  const fromResult = job.result?.[field];
  if (typeof fromResult === "string" && fromResult.trim().length > 0) {
    return redactSensitiveText(fromResult).slice(0, 2000);
  }

  for (const entry of [...job.executionLogs].reverse()) {
    const fromLog = entry.metadata?.[field];
    if (typeof fromLog === "string" && fromLog.trim().length > 0) {
      return redactSensitiveText(fromLog).slice(0, 2000);
    }
  }

  return undefined;
};

const extractPolicyDecisions = (
  logs: EngineRunLogEntry[],
): EngineJobPolicyDecision[] =>
  logs
    .filter(
      (entry) =>
        typeof entry.metadata?.policyCode === "string" ||
        typeof entry.metadata?.policyKind === "string" ||
        entry.message.toLowerCase().includes("policy"),
    )
    .map((entry) => ({
      timestamp: entry.timestamp,
      message: entry.message,
      ...(typeof entry.metadata?.policyCode === "string"
        ? { code: entry.metadata.policyCode }
        : {}),
      ...(typeof entry.metadata?.policyKind === "string"
        ? { kind: entry.metadata.policyKind }
        : {}),
    }));

const extractExternalSessionIds = (job: EngineJob): string[] => {
  const sessionIds = new Set<string>();

  if (typeof job.result?.externalSessionId === "string") {
    sessionIds.add(job.result.externalSessionId);
  }

  for (const entry of job.executionLogs) {
    if (typeof entry.metadata?.sessionId === "string") {
      sessionIds.add(entry.metadata.sessionId);
    }

    if (typeof entry.metadata?.externalSessionId === "string") {
      sessionIds.add(entry.metadata.externalSessionId);
    }
  }

  return [...sessionIds];
};

export const buildEngineJobDetail = (
  job: EngineJob,
  repository: LoopBoardRepository,
): EngineJobDetail => {
  const summary = summarizeEngineJob(job);
  const payloadSummary = redactUnknownValue(job.payload) as Record<string, unknown>;
  const resultSummary =
    job.result === undefined
      ? undefined
      : (redactUnknownValue(job.result) as Record<string, unknown>);

  return {
    ...summary,
    executionLogs: job.executionLogs.map(redactEngineLogEntry),
    payloadSummary,
    ...(resultSummary ? { resultSummary } : {}),
    ...(readJobExcerpt(job, "stdoutSummary")
      ? { stdoutExcerpt: readJobExcerpt(job, "stdoutSummary") }
      : {}),
    ...(readJobExcerpt(job, "stderrSummary")
      ? { stderrExcerpt: readJobExcerpt(job, "stderrSummary") }
      : {}),
    policyDecisions: extractPolicyDecisions(job.executionLogs),
    externalSessionIds: extractExternalSessionIds(job),
    operatorActions: describeEngineJobOperatorActions(repository, job),
  };
};

export const parseEngineJobListQuery = (url: URL): ListEngineJobsOptions => {
  const options: ListEngineJobsOptions = {};
  const projectId = url.searchParams.get("projectId");
  const taskId = url.searchParams.get("taskId");
  const workflowRunId = url.searchParams.get("workflowRunId");
  const backend = url.searchParams.get("backend");
  const kind = url.searchParams.get("kind");
  const status = url.searchParams.get("status");
  const limit = url.searchParams.get("limit");

  if (projectId?.trim()) {
    options.projectId = projectId.trim();
  }

  if (taskId?.trim()) {
    options.taskId = taskId.trim();
  }

  if (workflowRunId?.trim()) {
    options.workflowRunId = workflowRunId.trim();
  }

  if (backend?.trim()) {
    options.backend = backend.trim() as ExecutorBackend;
  }

  if (kind?.trim()) {
    options.kind = kind.trim() as EngineJob["kind"];
  }

  if (status?.trim()) {
    const statuses = status
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0) as EngineJobStatus[];

    if (statuses.length === 1) {
      options.status = statuses[0];
    } else if (statuses.length > 1) {
      options.status = statuses;
    }
  }

  if (limit?.trim()) {
    const parsedLimit = Number(limit);
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      throw new ValidationError("limit must be a positive integer.");
    }

    options.limit = parsedLimit;
  }

  return options;
};

export const listEngineJobsForApi = (
  repository: LoopBoardRepository,
  options: ListEngineJobsOptions = {},
): EngineJobListResponse => {
  if (options.projectId) {
    repository.getProject(options.projectId);
  }

  return {
    jobs: repository.listEngineJobs(options).map(summarizeEngineJob),
  };
};

export const getEngineJobDetail = (
  repository: LoopBoardRepository,
  jobId: string,
): EngineJobDetail =>
  buildEngineJobDetail(repository.getEngineJob(jobId), repository);

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
  const requestedProjectId =
    options.projectId === undefined
      ? undefined
      : options.projectId.trim().length > 0
        ? options.projectId
        : undefined;

  // Silently fall back to global scope when the client sends a stale project ID
  // (e.g. after a DB reset). Throwing 404 here would break the engine panel UI.
  let projectId: string | undefined = requestedProjectId;
  if (requestedProjectId) {
    try {
      repository.getProject(requestedProjectId);
    } catch (err) {
      if (err instanceof NotFoundError) {
        projectId = undefined;
      } else {
        throw err;
      }
    }
  }

  const jobsForCounts = repository.listEngineJobs({ projectId });
  const recentJobs = repository
    .listEngineJobs({ projectId, limit: 10 })
    .map(summarizeEngineJob);
  const automationSettings = repository.getAutomationSettings();

  let autoAdvance: EngineAutoAdvanceStatus | undefined;
  if (projectId) {
    const project = repository.getProject(projectId);
    const latestRun = repository.getLatestWorkflowRunForProject(projectId);
    const projectEnabled = project.engineSettings.autoAdvanceEnabled === true;
    const globallyEnabled = automationSettings.globalAutoRunEnabled;
    const pauseReason = latestRun
      ? extractWorkflowRunPauseReason(
          latestRun,
          latestRun.workflowId
            ? repository.getWorkflow(latestRun.workflowId)
            : undefined,
        )
      : undefined;

    autoAdvance = {
      projectEnabled,
      globallyEnabled,
      active: isProjectAutoAdvanceEnabled(project, automationSettings),
      ...(pauseReason ? { pauseReason, workflowRunId: latestRun?.id } : {}),
    };
  }

  const queueCounts = buildEngineQueueCounts(jobsForCounts);
  const latestRunForResume =
    projectId === undefined
      ? undefined
      : repository.getLatestWorkflowRunForProject(projectId);

  return {
    scheduler: repository.getEngineSchedulerStatus(),
    queueCounts,
    recentJobs,
    automationPolicy: describeEffectiveAutomationPolicy({
      automationSettings,
      ...(projectId
        ? {
            projectPolicy: repository.getProject(projectId).automationPolicy,
            engineSettings: repository.getProject(projectId).engineSettings,
          }
        : {}),
    }),
    autoAdvance,
    ...(latestRunForResume
      ? {
          workflowRunResume: describeWorkflowRunEngineResume(
            repository,
            latestRunForResume.id,
          ),
        }
      : {}),
    activeJobCount: queueCounts.queued + queueCounts.running,
    ...(projectId
      ? { metrics: repository.getEngineJobMetrics(projectId) }
      : {}),
  };
};

export const startEngineScheduler = (
  repository: LoopBoardRepository,
): EngineSchedulerActionResponse => {
  assertEnginePolicyAllowed({
    operation: "scheduler-control",
    automationSettings: repository.getAutomationSettings(),
  });

  const scheduler = new LoopScheduler(repository).start();
  startSchedulerBackgroundTicks();

  return { scheduler };
};

export const stopEngineScheduler = (
  repository: LoopBoardRepository,
): EngineSchedulerActionResponse => {
  stopSchedulerBackgroundTicks();

  return {
    scheduler: new LoopScheduler(repository).stop(),
  };
};

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

export const retryEngineJobForApi = (
  repository: LoopBoardRepository,
  jobId: string,
): EngineJobRecoveryResponse => ({
  job: summarizeEngineJob(retryEngineJob(repository, jobId)),
});

export const cancelEngineJobForApi = async (
  repository: LoopBoardRepository,
  jobId: string,
): Promise<EngineJobRecoveryResponse> => ({
  job: summarizeEngineJob(await cancelEngineJob(repository, jobId)),
});

export const resumeWorkflowRunFromEngineForApi = async (
  repository: LoopBoardRepository,
  runId: string,
): Promise<WorkflowRunEngineResumeResponse> => ({
  resume: describeWorkflowRunEngineResume(repository, runId),
  run: await resumeWorkflowRunFromEngine({ repository, runId }),
});

export type {
  EngineJobOperatorActionState,
  EngineJobOperatorActions,
  WorkflowRunEngineResumeAction,
};
