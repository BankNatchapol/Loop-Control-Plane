import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import {
  createExecutorRegistryForRepository,
  type ExecutorRegistry,
} from "@/lib/engine/executor-registry";
import type { EngineJob, EngineRunLogEntry } from "@/lib/engine/loop-engine-types";
import { evaluateTaskPickupPolicy } from "@/lib/engine/task-loop-planner";
import {
  evaluateWorkflowNodePolicy,
  type PolicyDecision,
} from "@/lib/policies/automation-policy";
import { redactSensitiveText } from "@/lib/security/safe-context";

export class EngineJobRecoveryError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly reasons: string[] = [],
    readonly statusCode = 403,
  ) {
    super(message);
    this.name = "EngineJobRecoveryError";
  }
}

export type EngineJobOperatorActionState = {
  allowed: boolean;
  code?: string;
  message?: string;
};

export type EngineJobOperatorActions = {
  retry: EngineJobOperatorActionState;
  cancel: EngineJobOperatorActionState;
};

export type WorkflowRunEngineResumeAction = {
  allowed: boolean;
  code?: string;
  message?: string;
};

const nowIso = (): string => new Date().toISOString();

const logEntry = (
  level: EngineRunLogEntry["level"],
  message: string,
  metadata: EngineRunLogEntry["metadata"] = {},
): EngineRunLogEntry => ({
  timestamp: nowIso(),
  level,
  message,
  metadata,
});

const denyAction = (
  decision: PolicyDecision,
): EngineJobOperatorActionState => ({
  allowed: false,
  code: decision.code,
  message: decision.message,
});

const allowAction = (message?: string): EngineJobOperatorActionState => ({
  allowed: true,
  ...(message ? { message } : {}),
});

const blockAction = (
  code: string,
  message: string,
): EngineJobOperatorActionState => ({
  allowed: false,
  code,
  message,
});

const evaluateWorkflowStepOperatorPolicy = (
  repository: LoopBoardRepository,
  job: EngineJob,
): PolicyDecision => {
  if (!job.workflowRunId || !job.workflowNodeId) {
    return {
      kind: "deny",
      code: "engine_job_missing_workflow_context",
      message: "Workflow-step job is missing workflow context.",
      reasons: ["workflowRunId and workflowNodeId are required."],
    };
  }

  const run = repository.getWorkflowRun(job.workflowRunId);
  const workflow = run.workflowSnapshot?.nodes?.length
    ? run.workflowSnapshot
    : repository.getWorkflow(run.workflowId);
  const node = workflow.nodes.find((candidate) => candidate.id === job.workflowNodeId);

  if (!node) {
    return {
      kind: "deny",
      code: "workflow_node_not_found",
      message: "Workflow node for this engine job was not found.",
      reasons: [`Missing node id ${job.workflowNodeId}.`],
    };
  }

  const step = [...run.steps]
    .reverse()
    .find((candidate) => candidate.workflowNodeId === job.workflowNodeId);
  const project = repository.getProject(run.projectId);

  return evaluateWorkflowNodePolicy({
    node,
    automated: false,
    approved: Boolean(step?.approvedAt),
    automationSettings: repository.getAutomationSettings(),
    projectPolicy: project.automationPolicy,
  });
};

export const describeEngineJobOperatorActions = (
  repository: LoopBoardRepository,
  job: EngineJob,
): EngineJobOperatorActions => {
  if (job.status !== "failed" && job.status !== "interrupted") {
    return {
      retry: blockAction(
        "engine_job_not_retryable",
        "Only failed or interrupted engine jobs can be retried.",
      ),
      cancel: job.status === "queued" || job.status === "running"
        ? allowAction()
        : blockAction(
            "engine_job_not_cancellable",
            "Only queued or running engine jobs can be cancelled.",
          ),
    };
  }

  if (job.attempt > job.maxAttempts) {
    return {
      retry: blockAction(
        "engine_job_max_attempts_exhausted",
        `Job exhausted max attempts (${job.maxAttempts}).`,
      ),
      cancel: blockAction(
        "engine_job_not_cancellable",
        "Only queued or running engine jobs can be cancelled.",
      ),
    };
  }

  if (job.kind === "demo-ping") {
    return {
      retry: allowAction(),
      cancel: blockAction(
        "engine_job_not_cancellable",
        "Only queued or running engine jobs can be cancelled.",
      ),
    };
  }

  if (job.kind === "task-run") {
    if (!job.taskId) {
      return {
        retry: blockAction(
          "engine_job_missing_task",
          "Task-run job is missing a linked task.",
        ),
        cancel: blockAction(
          "engine_job_not_cancellable",
          "Only queued or running engine jobs can be cancelled.",
        ),
      };
    }

    const task = repository.getTask(job.taskId);
    const project = repository.getProject(task.projectId);
    const policy = evaluateTaskPickupPolicy(repository, task, project, false);

    return {
      retry:
        policy.kind === "allow"
          ? allowAction()
          : denyAction(policy),
      cancel: blockAction(
        "engine_job_not_cancellable",
        "Only queued or running engine jobs can be cancelled.",
      ),
    };
  }

  if (job.kind === "workflow-step") {
    const policy = evaluateWorkflowStepOperatorPolicy(repository, job);

    return {
      retry:
        policy.kind === "allow"
          ? allowAction()
          : denyAction(policy),
      cancel: blockAction(
        "engine_job_not_cancellable",
        "Only queued or running engine jobs can be cancelled.",
      ),
    };
  }

  return {
    retry: blockAction(
      "engine_job_retry_unsupported",
      "This engine job kind cannot be retried.",
    ),
    cancel: blockAction(
      "engine_job_not_cancellable",
      "Only queued or running engine jobs can be cancelled.",
    ),
  };
};

export const describeWorkflowRunEngineResume = (
  repository: LoopBoardRepository,
  runId: string,
): WorkflowRunEngineResumeAction => {
  const run = repository.getWorkflowRun(runId);

  if (run.status === "completed" || run.status === "cancelled") {
    return {
      allowed: false,
      code: "workflow_run_terminal",
      message: `Workflow run is ${run.status} and cannot be resumed.`,
    };
  }

  const workflow = run.workflowSnapshot?.nodes?.length
    ? run.workflowSnapshot
    : repository.getWorkflow(run.workflowId);
  const node = workflow.nodes.find((candidate) => candidate.id === run.currentNodeId);

  if (!node) {
    return {
      allowed: false,
      code: "workflow_node_not_found",
      message: "Workflow run current node was not found.",
    };
  }

  const step = [...run.steps]
    .reverse()
    .find((candidate) => candidate.workflowNodeId === node.id);

  if (run.status === "paused" && step?.status === "waiting-approval") {
    return {
      allowed: false,
      code: "workflow_approval_required",
      message: "Approve the waiting workflow step before resuming the run.",
    };
  }

  const operatorResumingFailedRun =
    run.status === "failed" || run.status === "interrupted";

  const policy = evaluateWorkflowNodePolicy({
    node,
    automated: false,
    approved: operatorResumingFailedRun || Boolean(step?.approvedAt),
    automationSettings: repository.getAutomationSettings(),
    projectPolicy: repository.getProject(run.projectId).automationPolicy,
  });

  if (policy.kind === "deny") {
    return {
      allowed: false,
      code: policy.code,
      message: policy.message,
    };
  }

  if (policy.kind === "requires-approval") {
    return {
      allowed: false,
      code: policy.code,
      message: policy.message,
    };
  }

  return { allowed: true };
};

const assertRetryAllowed = (
  repository: LoopBoardRepository,
  job: EngineJob,
): void => {
  const actions = describeEngineJobOperatorActions(repository, job);
  if (!actions.retry.allowed) {
    throw new EngineJobRecoveryError(
      actions.retry.message ?? "Engine job retry is not allowed.",
      actions.retry.code ?? "engine_job_retry_denied",
    );
  }
};

const releaseTaskRunLock = (
  repository: LoopBoardRepository,
  job: EngineJob,
): void => {
  if (!job.taskId) {
    return;
  }

  const task = repository.getTask(job.taskId);
  if (task.status !== "ai-running") {
    return;
  }

  repository.moveTask(task.id, "ready", "human");
  repository.appendTaskEvent(task.id, {
    type: "ENGINE_TASK_CANCELLED",
    actor: "human",
    message: `Engine job ${job.id} cancelled by operator.`,
    metadata: {
      jobId: job.id,
      backend: job.backend,
    },
  });
};

const releaseWorkflowStepLock = (
  repository: LoopBoardRepository,
  job: EngineJob,
): void => {
  if (!job.workflowRunId || !job.workflowNodeId) {
    return;
  }

  const run = repository.getWorkflowRun(job.workflowRunId);
  const workflow = run.workflowSnapshot?.nodes?.length
    ? run.workflowSnapshot
    : repository.getWorkflow(run.workflowId);
  const node = workflow.nodes.find((candidate) => candidate.id === job.workflowNodeId);
  const step = [...run.steps]
    .reverse()
    .find((candidate) => candidate.workflowNodeId === job.workflowNodeId);

  if (!node || !step || step.status !== "running") {
    return;
  }

  const now = nowIso();
  const message = `Engine job ${job.id} cancelled by operator.`;

  repository.upsertWorkflowRunStep(run.id, {
    id: step.id,
    workflowNodeId: node.id,
    status: "failed",
    attempt: step.attempt,
    inputArtifacts: step.inputArtifacts,
    outputArtifacts: step.outputArtifacts,
    executionLogs: [
      ...step.executionLogs,
      {
        timestamp: now,
        level: "warn",
        message,
        metadata: {
          nodeId: node.id,
          engineJobId: job.id,
          cancelled: true,
        },
      },
    ],
    error: message,
    requireApproval: step.requireApproval,
    approvedAt: step.approvedAt,
    startedAt: step.startedAt,
    completedAt: now,
    updatedAt: now,
  });
};

export const retryEngineJob = (
  repository: LoopBoardRepository,
  jobId: string,
): EngineJob => {
  const job = repository.getEngineJob(jobId);
  assertRetryAllowed(repository, job);

  const now = nowIso();
  const retryLog = logEntry(
    "info",
    `Operator requeued failed engine job (attempt ${job.attempt}/${job.maxAttempts}).`,
    {
      jobId: job.id,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      operatorAction: "retry",
    },
  );

  return repository.updateEngineJob(job.id, {
    status: "queued",
    error: null,
    startedAt: null,
    completedAt: null,
    executionLogs: [...job.executionLogs, retryLog],
    updatedAt: now,
  });
};

export const cancelEngineJob = async (
  repository: LoopBoardRepository,
  jobId: string,
  registry: ExecutorRegistry = createExecutorRegistryForRepository(repository),
): Promise<EngineJob> => {
  const job = repository.getEngineJob(jobId);

  if (job.status !== "queued" && job.status !== "running") {
    throw new EngineJobRecoveryError(
      "Only queued or running engine jobs can be cancelled.",
      "engine_job_not_cancellable",
      [`Current status: ${job.status}.`],
      409,
    );
  }

  if (job.status === "running") {
    try {
      await registry.cancelJob(job);
    } catch {
      // Best-effort backend cancellation; persist cancelled state regardless.
    }
  }

  releaseTaskRunLock(repository, job);
  releaseWorkflowStepLock(repository, job);

  const now = nowIso();
  const cancelLog = logEntry("warn", "Engine job cancelled by operator.", {
    jobId: job.id,
    statusBeforeCancel: job.status,
    operatorAction: "cancel",
  });

  return repository.updateEngineJob(job.id, {
    status: "cancelled",
    error: redactSensitiveText(job.error ?? "Cancelled by operator."),
    completedAt: now,
    executionLogs: [...job.executionLogs, cancelLog],
    updatedAt: now,
  });
};

export const assertWorkflowRunEngineResumeAllowed = (
  repository: LoopBoardRepository,
  runId: string,
): void => {
  const resume = describeWorkflowRunEngineResume(repository, runId);
  if (!resume.allowed) {
    throw new EngineJobRecoveryError(
      resume.message ?? "Workflow run cannot be resumed from the engine.",
      resume.code ?? "workflow_engine_resume_denied",
    );
  }
};
