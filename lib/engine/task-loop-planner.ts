import type {
  EnqueueTaskRunJobResult,
  LoopBoardRepository,
  PersistedTask,
} from "@/lib/db/loopboard-repository";
import { resolveExecutorConfigWithFallbacks } from "@/lib/engine/executor-config-resolver";
import {
  isTaskStructurallyEligible,
  structuralIneligibilityReason,
  type TaskLoopCandidate,
  type TaskLoopSkipKind,
  type TaskLoopSkipReason,
} from "@/lib/engine/task-loop-eligibility";
import type { EngineJob, ExecutorConfig } from "@/lib/engine/loop-engine-types";
import {
  buildTaskRunJobPayload,
  type TaskRunAction,
  type TaskRunTrigger,
} from "@/lib/engine/loop-engine-types";
import type { Project } from "@/lib/loopboard";
import {
  evaluateEnginePolicy,
  evaluateTaskActionPolicy,
  type PolicyDecision,
} from "@/lib/policies/automation-policy";

export {
  isTaskStructurallyEligible,
  structuralIneligibilityReason,
  type TaskLoopCandidate,
  type TaskLoopSkipKind,
  type TaskLoopSkipReason,
} from "@/lib/engine/task-loop-eligibility";

export type TaskLoopPlannerOptions = {
  projectId?: string;
  taskId?: string;
  trigger?: TaskRunTrigger;
  action?: TaskRunAction;
  automated?: boolean;
  limit?: number;
  dryRun?: boolean;
  recordSkips?: boolean;
  executorConfig?: ExecutorConfig;
};

export type TaskLoopScanResult = {
  eligible: TaskLoopCandidate[];
  skipped: TaskLoopSkipReason[];
};

export type TaskLoopEnqueueResult = {
  enqueued: EngineJob[];
  skipped: TaskLoopSkipReason[];
  deduped: EngineJob[];
};

const skipFromPolicy = (
  taskId: string,
  policy: PolicyDecision,
): TaskLoopSkipReason => ({
  taskId,
  code: policy.code,
  kind: policy.kind as TaskLoopSkipKind,
  message: policy.message,
  reasons: policy.reasons,
});

export const evaluateTaskPickupPolicy = (
  repository: LoopBoardRepository,
  task: PersistedTask,
  project: Project,
  automated: boolean,
): PolicyDecision =>
  automated
    ? evaluateEnginePolicy({
        operation: "automated-task-pickup",
        task,
        automationSettings: repository.getAutomationSettings(),
        projectPolicy: project.automationPolicy,
      })
    : evaluateTaskActionPolicy({
        action: "assign-ai",
        task,
        automated: false,
        approved: Boolean(task.github.aoReadyApprovedAt),
        automationSettings: repository.getAutomationSettings(),
        projectPolicy: project.automationPolicy,
      });

const resolveExecutorConfig = (
  task: PersistedTask,
  project: Project,
  override?: ExecutorConfig,
  action: TaskRunAction = "execute",
): ExecutorConfig =>
  resolveExecutorConfigWithFallbacks({
    ...(override ? { explicitConfig: override } : {}),
    project,
    task,
    taskAction: action,
  });

const toCandidate = (task: PersistedTask): TaskLoopCandidate => ({
  taskId: task.id,
  projectId: task.projectId,
  title: task.title,
  status: task.status,
  owner: task.owner,
  risk: task.risk,
});

const recordPickupSkip = (
  repository: LoopBoardRepository,
  taskId: string,
  skip: TaskLoopSkipReason,
): void => {
  repository.appendTaskEvent(taskId, {
    type: "ENGINE_PICKUP_SKIPPED",
    actor: "system",
    message: skip.message,
    metadata: {
      policyCode: skip.code,
      skipKind: skip.kind,
      policyReasons: skip.reasons.join("; "),
    },
  });
};

export const assessTaskLoopCandidate = (
  repository: LoopBoardRepository,
  task: PersistedTask,
  project: Project,
  options: Pick<TaskLoopPlannerOptions, "automated">,
): { eligible?: TaskLoopCandidate; skipped?: TaskLoopSkipReason } => {
  const structuralSkip = structuralIneligibilityReason(task);
  if (structuralSkip) {
    return { skipped: structuralSkip };
  }

  if (repository.hasActiveTaskRunJob(task.id)) {
    return {
      skipped: {
        taskId: task.id,
        code: "task_run_job_in_flight",
        kind: "dedupe",
        message: "Task already has a queued or running task-run engine job.",
        reasons: ["Duplicate task-run jobs are blocked per task id."],
      },
    };
  }

  const policy = evaluateTaskPickupPolicy(
    repository,
    task,
    project,
    options.automated ?? false,
  );

  if (policy.kind !== "allow") {
    return { skipped: skipFromPolicy(task.id, policy) };
  }

  return { eligible: toCandidate(task) };
};

export const scanTaskLoopCandidates = (
  repository: LoopBoardRepository,
  options: TaskLoopPlannerOptions = {},
): TaskLoopScanResult => {
  const board = repository.listBoardData(options.projectId);
  const projectsById = new Map(board.projects.map((project) => [project.id, project]));
  const tasks = options.taskId
    ? board.tasks.filter((task) => task.id === options.taskId)
    : board.tasks;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  const eligible: TaskLoopCandidate[] = [];
  const skipped: TaskLoopSkipReason[] = [];

  for (const task of tasks) {
    if (eligible.length >= limit) {
      break;
    }

    const project = projectsById.get(task.projectId);
    if (!project) {
      skipped.push({
        taskId: task.id,
        code: "project_not_found",
        kind: "ineligible",
        message: `Project "${task.projectId}" was not found for task pickup.`,
        reasons: ["Task project reference is invalid."],
      });
      continue;
    }

    const assessment = assessTaskLoopCandidate(repository, task, project, options);
    if (assessment.eligible) {
      eligible.push(assessment.eligible);
    } else if (assessment.skipped) {
      skipped.push(assessment.skipped);
    }
  }

  return { eligible, skipped };
};

export const enqueueTaskLoopJobs = (
  repository: LoopBoardRepository,
  options: TaskLoopPlannerOptions = {},
): TaskLoopEnqueueResult => {
  const scan = scanTaskLoopCandidates(repository, options);
  const enqueued: EngineJob[] = [];
  const deduped: EngineJob[] = [];
  const skipped = [...scan.skipped];
  const trigger = options.trigger ?? "scheduler";
  const action = options.action ?? "execute";
  const recordSkips = options.recordSkips ?? !options.dryRun;

  for (const skip of scan.skipped) {
    if (skip.kind === "dedupe") {
      const active = repository.getActiveTaskRunJobForTask(skip.taskId);
      if (active) {
        deduped.push(active);
      }
    }
  }

  if (options.dryRun) {
    return { enqueued, skipped, deduped };
  }

  for (const candidate of scan.eligible) {
    const task = repository.getTask(candidate.taskId);
    const project = repository.getProject(candidate.projectId);
    const executorConfig = resolveExecutorConfig(task, project, options.executorConfig, action);
    const payload = buildTaskRunJobPayload({
      taskId: task.id,
      projectId: project.id,
      action,
      executorConfig,
      ...(task.handoff.contextPaths.length > 0
        ? { contextPaths: task.handoff.contextPaths }
        : {}),
      trigger,
    });

    const result: EnqueueTaskRunJobResult = repository.enqueueTaskRunJob({
      taskId: task.id,
      projectId: project.id,
      backend: executorConfig.backend,
      payload,
    });

    if (result.created) {
      enqueued.push(result.job);
      continue;
    }

    deduped.push(result.job);
    skipped.push({
      taskId: task.id,
      code: "task_run_job_in_flight",
      kind: "dedupe",
      message: "Task already has a queued or running task-run engine job.",
      reasons: [`Existing job id: ${result.job.id}.`],
    });
  }

  if (recordSkips) {
    for (const skip of skipped) {
      if (skip.kind === "deny" || skip.kind === "requires-approval") {
        recordPickupSkip(repository, skip.taskId, skip);
      }
    }
  }

  return { enqueued, skipped, deduped };
};
