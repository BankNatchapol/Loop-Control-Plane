import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { ValidationError } from "@/lib/db/loopboard-repository";
import {
  summarizeEngineJob,
  type EngineJobSummary,
} from "@/lib/api/engine-actions";
import {
  enqueueTaskLoopJobs,
  evaluateTaskPickupPolicy,
  scanTaskLoopCandidates,
  type TaskLoopCandidate,
  type TaskLoopSkipReason,
} from "@/lib/engine/task-loop-planner";
import {
  assertEnginePolicyAllowed,
} from "@/lib/policies/automation-policy";
import type { PolicyDecision } from "@/lib/policies/automation-policy";

export type TaskLoopScanResponse = {
  eligible: TaskLoopCandidate[];
  skipped: TaskLoopSkipReason[];
};

export type TaskLoopEnqueueResponse = {
  policy: PolicyDecision;
  enqueued: EngineJobSummary[];
  skipped: TaskLoopSkipReason[];
  deduped: EngineJobSummary[];
};

const readOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const readTaskLoopScanInput = (
  body: unknown,
): {
  projectId?: string;
  taskId?: string;
  automated: boolean;
} => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { automated: false };
  }

  const payload = body as {
    projectId?: unknown;
    taskId?: unknown;
    automated?: unknown;
  };

  return {
    projectId: readOptionalString(payload.projectId),
    taskId: readOptionalString(payload.taskId),
    automated: payload.automated === true,
  };
};

export const readTaskLoopEnqueueInput = (
  body: unknown,
): {
  taskId: string;
  automated: boolean;
} => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Task loop request payload must be an object.");
  }

  const taskId = readOptionalString((body as { taskId?: unknown }).taskId);
  if (!taskId) {
    throw new ValidationError("taskId is required.");
  }

  return {
    taskId,
    automated: (body as { automated?: unknown }).automated === true,
  };
};

export const scanTaskLoop = (
  repository: LoopBoardRepository,
  input: ReturnType<typeof readTaskLoopScanInput>,
): TaskLoopScanResponse =>
  scanTaskLoopCandidates(repository, {
    projectId: input.projectId,
    taskId: input.taskId,
    automated: input.automated,
    dryRun: true,
    recordSkips: false,
  });

export const enqueueTaskLoop = (
  repository: LoopBoardRepository,
  input: ReturnType<typeof readTaskLoopEnqueueInput>,
): TaskLoopEnqueueResponse => {
  const task = repository.getTask(input.taskId);
  const project = repository.getProject(task.projectId);

  if (input.automated) {
    assertEnginePolicyAllowed({
      operation: "scheduler-control",
      automationSettings: repository.getAutomationSettings(),
      projectPolicy: project.automationPolicy,
      engineSettings: project.engineSettings,
    });
  }

  const policy = evaluateTaskPickupPolicy(
    repository,
    task,
    project,
    input.automated,
  );

  const result = enqueueTaskLoopJobs(repository, {
    projectId: project.id,
    taskId: task.id,
    trigger: "manual",
    automated: input.automated,
    recordSkips: true,
  });

  return {
    policy,
    enqueued: result.enqueued.map(summarizeEngineJob),
    skipped: result.skipped,
    deduped: result.deduped.map(summarizeEngineJob),
  };
};
