import {
  UnsupportedTransitionError,
  type LoopBoardRepository,
} from "@/lib/db/loopboard-repository";
import {
  defaultExecutorRegistry,
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
  evaluateGlobalAutomationPolicy,
  type AutomationSettings,
  type PolicyDecision,
} from "@/lib/policies/automation-policy";
import { redactSensitiveText } from "@/lib/security/safe-context";

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
    executionLogs.push(
      engineLogEntry("info", "Engine job completed successfully.", {
        jobId: job.id,
        backend: job.backend,
      }, now),
    );

    return {
      status: "completed",
      attempt: job.attempt,
      result: executorResult.result,
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
    private readonly registry: ExecutorRegistry = defaultExecutorRegistry,
  ) {}

  getStatus(): EngineSchedulerStatus {
    return this.repository.getEngineSchedulerStatus();
  }

  start(
    automationSettings: AutomationSettings = this.repository.getAutomationSettings(),
  ): EngineSchedulerStatus {
    const policy = evaluateGlobalAutomationPolicy(automationSettings);
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
    const policy = evaluateGlobalAutomationPolicy(automationSettings);
    const nextJob = this.repository.fetchNextQueuedJob();
    const plan = planNextTick({
      schedulerStatus,
      policyDecision: policy,
      nextJob,
      tickMode: mode,
    });

    const tickCount = schedulerStatus.tickCount + 1;

    if (plan.action !== "process") {
      const updated = this.repository.updateEngineSchedulerStatus({
        lastTickAt: now,
        tickCount,
        lastError: plan.action === "skip" ? plan.reason : null,
      });

      return { plan, schedulerStatus: updated };
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

    const schedulerStatusAfterTick = this.repository.updateEngineSchedulerStatus({
      lastTickAt: now,
      tickCount,
      lastError: outcome.status === "failed" ? outcome.error ?? null : null,
    });

    return {
      plan,
      job,
      schedulerStatus: schedulerStatusAfterTick,
    };
  }
}

export {
  defaultAutomationSettings,
  evaluateGlobalAutomationPolicy,
  type AutomationSettings,
  type PolicyDecision,
};
