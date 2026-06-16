import {
  TaskContextService,
  type TaskContextInput,
} from "@/lib/context/task-context-service";
import type {
  LoopBoardRepository,
  PersistedTask,
} from "@/lib/db/loopboard-repository";
import { resolveExecutorConfigWithFallbacks } from "@/lib/engine/executor-config-resolver";
import type { ExecutorContext, ExecutorResult } from "@/lib/engine/executor-registry";
import { executeDeterministicStubJob } from "@/lib/engine/stub-executor-job";
import {
  isExecutorBackend,
  parseTaskRunJobPayload,
  validateExecutorConfig,
  type EngineJob,
  type EngineRunLogEntry,
  type ExecutorBackend,
  type ExecutorConfig,
  type TaskRunJobPayload,
} from "@/lib/engine/loop-engine-types";
import type { Feature, Project, WorkflowNode } from "@/lib/loopboard";
import {
  ENGINE_JOB_AWAITING_EXTERNAL_SYNC_KEY,
} from "@/lib/engine/engine-sync-service";
import {
  formatExternalUntrustedValue,
  redactSensitiveText,
} from "@/lib/security/safe-context";

export type TaskRunExecutorDeps = {
  repository: LoopBoardRepository;
  contextService?: TaskContextService;
  invokeBackend?: TaskRunBackendInvoker;
};

export type TaskRunBackendInvoker = (
  context: ExecutorContext,
  config: ExecutorConfig,
) => Promise<ExecutorResult>;

const TRIVIAL_COMPLETION_LABEL = "engine-trivial";
const EXECUTOR_LABEL_PREFIX = "executor-backend:";

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

export const isTrivialDemoTask = (task: PersistedTask): boolean =>
  task.labels.includes(TRIVIAL_COMPLETION_LABEL);

export const readTaskExecutorBackendLabel = (
  task: PersistedTask,
): ExecutorBackend | undefined => {
  for (const label of task.labels) {
    if (!label.startsWith(EXECUTOR_LABEL_PREFIX)) {
      continue;
    }

    const backend = label.slice(EXECUTOR_LABEL_PREFIX.length);
    if (isExecutorBackend(backend)) {
      return backend;
    }
  }

  return undefined;
};

export const resolveTaskRunExecutorConfig = (input: {
  payload: TaskRunJobPayload;
  task: PersistedTask;
  project: Project;
  workflowNode?: Pick<WorkflowNode, "type" | "config">;
}): ExecutorConfig => {
  const payloadValidation = validateExecutorConfig(input.payload.executorConfig);
  const payloadConfig = payloadValidation.ok ? payloadValidation.config : undefined;

  return resolveExecutorConfigWithFallbacks({
    ...(payloadConfig ? { explicitConfig: payloadConfig } : {}),
    project: input.project,
    task: input.task,
    taskAction: input.payload.action,
    ...(input.workflowNode ? { workflowNode: input.workflowNode } : {}),
  });
};

export const loadTaskContextInput = (
  repository: LoopBoardRepository,
  taskId: string,
): TaskContextInput => {
  const task = repository.getTask(taskId);
  const board = repository.listBoardData(task.projectId);
  const project = board.projects.find((candidate) => candidate.id === task.projectId);
  const feature = board.features.find((candidate) => candidate.id === task.featureId);

  if (!project) {
    throw new Error(`Project "${task.projectId}" was not found for task "${task.id}".`);
  }

  if (!feature) {
    throw new Error(`Feature "${task.featureId}" was not found for task "${task.id}".`);
  }

  return { task, project, feature };
};

const resolveWorkflowNodeFallback = (
  repository: LoopBoardRepository,
  job: EngineJob,
): Pick<WorkflowNode, "type" | "config"> | undefined => {
  if (!job.workflowNodeId) {
    return undefined;
  }

  if (!job.workflowRunId) {
    return undefined;
  }

  const run = repository.getWorkflowRun(job.workflowRunId);
  const workflow = repository.getWorkflow(run.workflowId);
  const node = workflow.nodes.find((candidate) => candidate.id === job.workflowNodeId);

  return node;
};

export const pickupTaskForEngineRun = (
  repository: LoopBoardRepository,
  task: PersistedTask,
  job: EngineJob,
  payload: TaskRunJobPayload,
): PersistedTask => {
  let current = task;

  if (current.status === "ready") {
    current = repository.applyTaskAction(current.id, "assign-ai");
  }

  return repository.appendTaskEvent(current.id, {
    type: "ENGINE_PICKUP",
    actor: "system",
    message: "Engine picked up task for automated execution.",
    fromStatus: task.status,
    toStatus: current.status,
    fromOwner: task.owner,
    toOwner: current.owner,
    metadata: {
      jobId: job.id,
      trigger: payload.trigger,
      backend: job.backend,
      action: payload.action,
    },
  });
};

export const refreshTaskContextArtifacts = (
  repository: LoopBoardRepository,
  contextService: TaskContextService,
  taskId: string,
  mode: "full" | "handoff-and-events" = "full",
): void => {
  const input = loadTaskContextInput(repository, taskId);
  const task = repository.getTask(taskId);

  if (mode === "full") {
    contextService.generateTaskContext(input);
    return;
  }

  contextService.refreshHandoff(input);
  contextService.exportEvents(task);
};

export const finalizeTaskRunSuccess = (
  repository: LoopBoardRepository,
  contextService: TaskContextService,
  taskId: string,
  job: EngineJob,
  executorResult: ExecutorResult,
): PersistedTask => {
  const task = repository.getTask(taskId);
  let current = task;

  if (isTrivialDemoTask(task)) {
    current = repository.applyTaskAction(task.id, "mark-done");
  } else {
    current = repository.moveTask(task.id, "needs-review", "system");
  }

  current = repository.appendTaskEvent(current.id, {
    type: "ENGINE_TASK_COMPLETED",
    actor: "system",
    message:
      executorResult.stdoutSummary ??
      "Engine task run completed successfully.",
    metadata: {
      jobId: job.id,
      backend: job.backend,
      attempt: job.attempt,
      ...(executorResult.stderrSummary
        ? { stderrSummary: executorResult.stderrSummary }
        : {}),
    },
  });

  refreshTaskContextArtifacts(repository, contextService, current.id, "full");

  return repository.getTask(current.id);
};

export const finalizeTaskRunFailure = (
  repository: LoopBoardRepository,
  contextService: TaskContextService,
  taskId: string,
  job: EngineJob,
  error: string,
  willRetry: boolean,
): PersistedTask => {
  const redactedError = redactSensitiveText(error);

  let current = repository.appendTaskEvent(taskId, {
    type: "ENGINE_TASK_FAILED",
    actor: "system",
    message: willRetry
      ? `Engine task run failed and will retry: ${redactedError}`
      : `Engine task run failed: ${redactedError}`,
    metadata: {
      jobId: job.id,
      backend: job.backend,
      attempt: job.attempt,
      willRetry,
    },
  });

  if (!willRetry) {
    current = repository.applyTaskAction(current.id, "mark-blocked");
  }

  refreshTaskContextArtifacts(repository, contextService, current.id, "handoff-and-events");

  return repository.getTask(current.id);
};

export const defaultTaskRunBackendInvoker: TaskRunBackendInvoker = async (
  context,
  config,
) => executeDeterministicStubJob({ ...context, config });

export const executeTaskRunJob = async (
  context: ExecutorContext,
  deps: TaskRunExecutorDeps,
): Promise<ExecutorResult> => {
  const logs: EngineRunLogEntry[] = [
    logEntry("info", "Task-run executor started.", {
      jobId: context.job.id,
      backend: context.job.backend,
    }),
  ];

  const payload = parseTaskRunJobPayload(context.job.payload);
  if (!payload) {
    return {
      success: false,
      error: "Task-run job payload is invalid or incomplete.",
      logs: [
        ...logs,
        logEntry("error", "Task-run payload failed validation.", {
          jobId: context.job.id,
        }),
      ],
    };
  }

  const taskId = payload.taskId;
  const repository = deps.repository;
  const contextService = deps.contextService ?? new TaskContextService();
  const invokeBackend = deps.invokeBackend ?? defaultTaskRunBackendInvoker;

  let task: PersistedTask;
  let project: Project;
  let feature: Feature;

  try {
    const input = loadTaskContextInput(repository, taskId);
    task = input.task;
    project = input.project;
    feature = input.feature;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load task context input.";
    return {
      success: false,
      error: message,
      logs: [...logs, logEntry("error", message, { jobId: context.job.id })],
    };
  }

  const workflowNode = resolveWorkflowNodeFallback(repository, context.job);
  const resolvedConfig = resolveTaskRunExecutorConfig({
    payload,
    task,
    project,
    workflowNode,
  });

  logs.push(
    logEntry("info", "Resolved task-run executor backend.", {
      backend: resolvedConfig.backend,
      taskId,
    }),
  );

  try {
    contextService.generateTaskContext({ task, project, feature });
    logs.push(
      logEntry("info", "Generated task context artifacts.", { taskId }),
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to generate task context artifacts.";
    return {
      success: false,
      error: message,
      logs: [...logs, logEntry("error", message, { taskId })],
    };
  }

  try {
    task = pickupTaskForEngineRun(repository, task, context.job, payload);
    contextService.exportEvents(task);
    logs.push(
      logEntry("info", "Task transitioned for engine pickup.", {
        taskId,
        status: task.status,
      }),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to transition task for pickup.";
    return {
      success: false,
      error: message,
      logs: [...logs, logEntry("error", message, { taskId })],
    };
  }

  if (context.signal?.aborted) {
    return {
      success: false,
      error: "Execution cancelled before backend invocation.",
      logs: [
        ...logs,
        logEntry("warn", "Task-run executor cancelled before backend invocation.", {
          taskId,
        }),
      ],
    };
  }

  let executorResult: ExecutorResult;
  try {
    executorResult = await invokeBackend(context, resolvedConfig);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Backend invocation failed unexpectedly.";
    executorResult = {
      success: false,
      error: message,
      logs: [],
    };
  }

  logs.push(...executorResult.logs);

  const willRetry =
    !executorResult.success && context.job.attempt < context.job.maxAttempts;

  if (
    executorResult.success &&
    executorResult.result?.[ENGINE_JOB_AWAITING_EXTERNAL_SYNC_KEY] === true
  ) {
    repository.appendTaskEvent(taskId, {
      type: "ENGINE_EXTERNAL_SYNC",
      actor: "system",
      message: formatExternalUntrustedValue(
        executorResult.stdoutSummary ??
          "External backend session started; awaiting completion sync.",
      ),
      metadata: {
        jobId: context.job.id,
        backend: context.job.backend,
        ...(typeof executorResult.result.externalSessionId === "string"
          ? { externalSessionId: executorResult.result.externalSessionId }
          : {}),
        untrusted: true,
      },
    });
    refreshTaskContextArtifacts(repository, contextService, taskId, "handoff-and-events");
    logs.push(
      logEntry("info", "Task-run awaiting external backend sync.", { taskId }),
    );

    return {
      ...executorResult,
      logs,
    };
  }

  if (executorResult.success) {
    finalizeTaskRunSuccess(repository, contextService, taskId, context.job, executorResult);
    logs.push(
      logEntry("info", "Task-run finalized with success transition.", { taskId }),
    );

    return {
      ...executorResult,
      logs,
    };
  }

  finalizeTaskRunFailure(
    repository,
    contextService,
    taskId,
    context.job,
    executorResult.error ?? "Task-run backend failed without an error message.",
    willRetry,
  );

  logs.push(
    logEntry(
      willRetry ? "warn" : "error",
      willRetry
        ? "Task-run failed; task remains in AI Running for retry."
        : "Task-run failed; task marked blocked after exhausting retries.",
      { taskId, attempt: context.job.attempt, maxAttempts: context.job.maxAttempts },
    ),
  );

  return {
    ...executorResult,
    logs,
  };
};
