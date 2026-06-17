import {
  UnsupportedTransitionError,
  type LoopBoardRepository,
} from "@/lib/db/loopboard-repository";
import {
  ENGINE_JOB_AWAITING_EXTERNAL_SYNC_KEY,
  syncInFlightEngineJobs,
  type EngineSyncResult,
} from "@/lib/engine/engine-sync-service";
import {
  createExecutorRegistryForRepository,
  resolveExecutorConfigForJob,
  type ExecutorRegistry,
  type ExecutorResult,
} from "@/lib/engine/executor-registry";
import type {
  EngineJob,
  EngineRunLogEntry,
  EngineSchedulerState,
  EngineSchedulerStatus,
} from "@/lib/engine/loop-engine-types";
import {
  defaultAutomationSettings,
  evaluateEnginePolicy,
  evaluateGlobalAutomationPolicy,
  type AutomationSettings,
  type PolicyDecision,
} from "@/lib/policies/automation-policy";
import { redactSensitiveText } from "@/lib/security/safe-context";
import {
  completeWorkflowStepFromEngineJob,
} from "@/lib/workflows/workflow-runner";
import { enqueueTaskLoopJobs } from "@/lib/engine/task-loop-planner";
import {
  maybeFollowUpAfterCompletedJob,
  type AutoAdvanceResult,
} from "@/lib/engine/auto-advance";

export type SchedulerAction = "start" | "stop" | "pause";

export type TickMode = "automated" | "manual";

export type TickPlan =
  | { action: "skip"; code: string; reason: string }
  | { action: "idle"; reason: string }
  | { action: "process"; jobId: string };

export type SchedulerTransitionResult =
  | { ok: true; status: EngineSchedulerState }
  | { ok: false; code: string; message: string };

export type JobProcessResult = {
  status: EngineJob["status"];
  attempt: number;
  error?: string;
  result?: Record<string, unknown>;
  executionLogs: EngineRunLogEntry[];
  startedAt?: string;
  completedAt?: string;
};

export type TickResult = {
  plan: TickPlan;
  job?: EngineJob;
  schedulerStatus: EngineSchedulerStatus;
  taskLoopPickup?: {
    enqueued: number;
    skipped: number;
    deduped: number;
  };
  engineSync?: EngineSyncResult;
  autoAdvance?: AutoAdvanceResult;
  chainedTicks?: number;
};

export class LoopSchedulerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly reasons: string[] = [],
    readonly statusCode = 403,
  ) {
    super(message);
  }
}

const nowIso = (): string => new Date().toISOString();

export const DEFAULT_TASK_LOOP_CONCURRENCY_LIMIT = 1;
export const DEFAULT_AUTO_ADVANCE_CHAIN_LIMIT = 25;

export type TaskLoopPickupPlan = {
  shouldEnqueue: boolean;
  enqueueLimit: number;
};

export const planTaskLoopPickup = (input: {
  tickMode: TickMode;
  schedulerStatus: EngineSchedulerStatus;
  policyDecision: PolicyDecision;
  activeTaskRunJobs: number;
  concurrencyLimit?: number;
}): TaskLoopPickupPlan => {
  const limit = input.concurrencyLimit ?? DEFAULT_TASK_LOOP_CONCURRENCY_LIMIT;
  const availableSlots = Math.max(0, limit - input.activeTaskRunJobs);

  if (input.tickMode !== "automated") {
    return { shouldEnqueue: false, enqueueLimit: 0 };
  }

  if (input.schedulerStatus.status !== "running") {
    return { shouldEnqueue: false, enqueueLimit: 0 };
  }

  if (input.policyDecision.kind !== "allow") {
    return { shouldEnqueue: false, enqueueLimit: 0 };
  }

  return {
    shouldEnqueue: availableSlots > 0,
    enqueueLimit: availableSlots,
  };
};

export const redactEngineLogEntry = (
  entry: EngineRunLogEntry,
): EngineRunLogEntry => ({
  ...entry,
  message: redactSensitiveText(entry.message),
  metadata: entry.metadata
    ? Object.fromEntries(
        Object.entries(entry.metadata).map(([key, value]) => [
          key,
          typeof value === "string" ? redactSensitiveText(value) : value,
        ]),
      )
    : undefined,
});

const engineLogEntry = (
  level: EngineRunLogEntry["level"],
  message: string,
  metadata: EngineRunLogEntry["metadata"] = {},
  timestamp: string = nowIso(),
): EngineRunLogEntry =>
  redactEngineLogEntry({
    timestamp,
    level,
    message,
    metadata,
  });

export const applySchedulerTransition = (
  currentStatus: EngineSchedulerState,
  action: SchedulerAction,
): SchedulerTransitionResult => {
  if (action === "start") {
    if (currentStatus === "running") {
      return { ok: true, status: "running" };
    }

    if (currentStatus === "stopped" || currentStatus === "paused") {
      return { ok: true, status: "running" };
    }
  }

  if (action === "stop") {
    if (currentStatus === "stopped") {
      return { ok: true, status: "stopped" };
    }

    return { ok: true, status: "stopped" };
  }

  if (action === "pause") {
    if (currentStatus !== "running") {
      return {
        ok: false,
        code: "scheduler_not_running",
        message: "Only a running scheduler can be paused.",
      };
    }

    return { ok: true, status: "paused" };
  }

  return {
    ok: false,
    code: "scheduler_action_unknown",
    message: `Unknown scheduler action "${action as string}".`,
  };
};

export const planNextTick = (input: {
  schedulerStatus: EngineSchedulerStatus;
  policyDecision: PolicyDecision;
  nextJob?: EngineJob;
  tickMode: TickMode;
}): TickPlan => {
  const { schedulerStatus, policyDecision, nextJob, tickMode } = input;

  if (tickMode === "automated") {
    if (schedulerStatus.status === "stopped") {
      return {
        action: "skip",
        code: "scheduler_stopped",
        reason: "Scheduler is stopped; automatic ticks are skipped.",
      };
    }

    if (schedulerStatus.status === "paused") {
      return {
        action: "skip",
        code: "scheduler_paused",
        reason: "Scheduler is paused; automatic ticks are skipped.",
      };
    }

    if (policyDecision.kind === "deny") {
      return {
        action: "skip",
        code: policyDecision.code,
        reason: policyDecision.message,
      };
    }
  }

  if (!nextJob) {
    return {
      action: "idle",
      reason: "No queued engine jobs are waiting for execution.",
    };
  }

  return {
    action: "process",
    jobId: nextJob.id,
  };
};

export const processEngineJob = (input: {
  job: EngineJob;
  executorResult: ExecutorResult;
  startedAt: string;
  now?: string;
}): JobProcessResult => {
  const { job, executorResult, startedAt } = input;
  const now = input.now ?? nowIso();
  const executionLogs = [
    ...job.executionLogs,
    ...executorResult.logs.map(redactEngineLogEntry),
  ];

  if (executorResult.success) {
    if (executorResult.result?.[ENGINE_JOB_AWAITING_EXTERNAL_SYNC_KEY] === true) {
      executionLogs.push(
        engineLogEntry(
          "info",
          "Engine job handed off to external backend; awaiting sync poll.",
          {
            jobId: job.id,
            backend: job.backend,
          },
          now,
        ),
      );

      return {
        status: "running",
        attempt: job.attempt,
        result: executorResult.result,
        executionLogs,
        startedAt,
        completedAt: undefined,
      };
    }

    executionLogs.push(
      engineLogEntry("info", "Engine job completed successfully.", {
        jobId: job.id,
        backend: job.backend,
      }, now),
    );

    return {
      status: "completed",
      attempt: job.attempt,
      result: {
        ...(executorResult.result ?? {}),
        ...(executorResult.stdoutSummary ? { stdoutSummary: executorResult.stdoutSummary } : {}),
        ...(executorResult.stderrSummary ? { stderrSummary: executorResult.stderrSummary } : {}),
      },
      executionLogs,
      startedAt,
      completedAt: now,
    };
  }

  const redactedError = redactSensitiveText(
    executorResult.error ?? "Engine job failed without an error message.",
  );
  executionLogs.push(
    engineLogEntry("error", `Engine job failed: ${redactedError}`, {
      jobId: job.id,
      backend: job.backend,
    }, now),
  );

  const nextAttempt = job.attempt + 1;
  if (nextAttempt <= job.maxAttempts) {
    executionLogs.push(
      engineLogEntry(
        "warn",
        `Requeueing job for retry (${nextAttempt}/${job.maxAttempts}).`,
        { jobId: job.id, attempt: nextAttempt },
        now,
      ),
    );

    return {
      status: "queued",
      attempt: nextAttempt,
      error: redactedError,
      executionLogs,
      startedAt: undefined,
      completedAt: undefined,
    };
  }

  executionLogs.push(
    engineLogEntry(
      "error",
      `Engine job exhausted max attempts (${job.maxAttempts}).`,
      { jobId: job.id, attempt: nextAttempt },
      now,
    ),
  );

  return {
    status: "failed",
    attempt: nextAttempt,
    error: redactedError,
    executionLogs,
    startedAt,
    completedAt: now,
  };
};

export class LoopScheduler {
  constructor(
    private readonly repository: LoopBoardRepository,
    private readonly registry: ExecutorRegistry = createExecutorRegistryForRepository(
      repository,
    ),
  ) {}

  getStatus(): EngineSchedulerStatus {
    return this.repository.getEngineSchedulerStatus();
  }

  start(
    automationSettings: AutomationSettings = this.repository.getAutomationSettings(),
  ): EngineSchedulerStatus {
    const policy = evaluateEnginePolicy({
      operation: "scheduler-control",
      automationSettings,
    });
    if (policy.kind === "deny") {
      throw new LoopSchedulerError(policy.message, policy.code, policy.reasons);
    }

    const current = this.repository.getEngineSchedulerStatus();
    const transition = applySchedulerTransition(current.status, "start");
    if (!transition.ok) {
      throw new UnsupportedTransitionError(transition.message);
    }

    return this.repository.updateEngineSchedulerStatus({
      status: transition.status,
      lastError: null,
    });
  }

  stop(): EngineSchedulerStatus {
    const current = this.repository.getEngineSchedulerStatus();
    const transition = applySchedulerTransition(current.status, "stop");
    if (!transition.ok) {
      throw new UnsupportedTransitionError(transition.message);
    }

    return this.repository.updateEngineSchedulerStatus({
      status: transition.status,
    });
  }

  pause(): EngineSchedulerStatus {
    const current = this.repository.getEngineSchedulerStatus();
    const transition = applySchedulerTransition(current.status, "pause");
    if (!transition.ok) {
      throw new UnsupportedTransitionError(transition.message);
    }

    return this.repository.updateEngineSchedulerStatus({
      status: transition.status,
    });
  }

  async tick(options: { mode?: TickMode } = {}): Promise<TickResult> {
    const mode = options.mode ?? "automated";
    const now = nowIso();
    const schedulerStatus = this.repository.getEngineSchedulerStatus();
    const automationSettings = this.repository.getAutomationSettings();
    const policy = evaluateEnginePolicy({
      operation: "scheduler-control",
      automationSettings,
    });

    const engineSync = await syncInFlightEngineJobs({
      repository: this.repository,
    });

    let taskLoopPickup: TickResult["taskLoopPickup"];
    const pickupPlan = planTaskLoopPickup({
      tickMode: mode,
      schedulerStatus,
      policyDecision: policy,
      activeTaskRunJobs: this.repository.countActiveTaskRunJobs(),
    });

    if (pickupPlan.shouldEnqueue) {
      const pickupResult = enqueueTaskLoopJobs(this.repository, {
        trigger: "scheduler",
        automated: true,
        limit: pickupPlan.enqueueLimit,
        recordSkips: true,
      });
      taskLoopPickup = {
        enqueued: pickupResult.enqueued.length,
        skipped: pickupResult.skipped.length,
        deduped: pickupResult.deduped.length,
      };
    }

    let lastResult: TickResult | undefined;
    let chainedTicks = 0;
    let tickCount = schedulerStatus.tickCount;

    while (chainedTicks < DEFAULT_AUTO_ADVANCE_CHAIN_LIMIT) {
      tickCount += 1;
      const nextJob = this.repository.fetchNextQueuedJob();
      const currentSchedulerStatus =
        chainedTicks === 0
          ? schedulerStatus
          : this.repository.getEngineSchedulerStatus();
      const plan = planNextTick({
        schedulerStatus: currentSchedulerStatus,
        policyDecision: policy,
        nextJob,
        tickMode: mode,
      });

      if (plan.action !== "process") {
        const updated = this.repository.updateEngineSchedulerStatus({
          lastTickAt: now,
          tickCount,
          lastError: plan.action === "skip" ? plan.reason : null,
        });

        lastResult = {
          plan,
          schedulerStatus: updated,
          taskLoopPickup,
          engineSync,
          chainedTicks,
        };
        break;
      }

      const running = this.repository.updateEngineJob(plan.jobId, {
        status: "running",
        startedAt: now,
      });

      running.executionLogs = [
        ...running.executionLogs,
        engineLogEntry("info", "Engine scheduler dequeued job for execution.", {
          jobId: running.id,
          attempt: running.attempt,
          mode,
        }, now),
      ];
      this.repository.updateEngineJob(running.id, {
        executionLogs: running.executionLogs,
      });

      let executorResult: ExecutorResult;
      try {
        executorResult = await this.registry.executeJob(
          running,
          resolveExecutorConfigForJob(running),
        );
      } catch (error) {
        executorResult = {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Executor failed unexpectedly.",
          logs: [],
        };
      }

      const outcome = processEngineJob({
        job: running,
        executorResult,
        startedAt: now,
        now,
      });

      const job = this.repository.updateEngineJob(running.id, {
        status: outcome.status,
        attempt: outcome.attempt,
        result: outcome.result ?? null,
        error: outcome.error ?? null,
        executionLogs: outcome.executionLogs,
        startedAt: outcome.startedAt ?? null,
        completedAt: outcome.completedAt ?? null,
        updatedAt: now,
      });

      if (
        job.kind === "workflow-step" &&
        (outcome.status === "completed" || outcome.status === "failed")
      ) {
        completeWorkflowStepFromEngineJob({
          repository: this.repository,
          job,
          success: outcome.status === "completed",
          error: outcome.error,
        });
      }

      const schedulerStatusAfterTick = this.repository.updateEngineSchedulerStatus({
        lastTickAt: now,
        tickCount,
        lastError: outcome.status === "failed" ? outcome.error ?? null : null,
      });

      const jobFinished =
        outcome.status === "completed" || outcome.status === "failed";
      const autoAdvance =
        jobFinished && job.status !== "queued"
          ? maybeFollowUpAfterCompletedJob(this.repository, job, {
              tickMode: mode,
              success: outcome.status === "completed",
            })
          : undefined;

      lastResult = {
        plan,
        job,
        schedulerStatus: schedulerStatusAfterTick,
        taskLoopPickup,
        engineSync,
        autoAdvance,
        chainedTicks,
      };

      const shouldChain =
        autoAdvance?.action === "advanced" &&
        autoAdvance.enqueuedJob === true &&
        this.repository.fetchNextQueuedJob() !== undefined;

      if (!shouldChain) {
        break;
      }

      chainedTicks += 1;
    }

    return (
      lastResult ?? {
        plan: {
          action: "idle",
          reason: "No queued engine jobs are waiting for execution.",
        },
        schedulerStatus: this.repository.updateEngineSchedulerStatus({
          lastTickAt: now,
          tickCount: schedulerStatus.tickCount + 1,
        }),
        taskLoopPickup,
        engineSync,
        chainedTicks: 0,
      }
    );
  }
}

export {
  defaultAutomationSettings,
  evaluateGlobalAutomationPolicy,
  type AutomationSettings,
  type PolicyDecision,
};
