import { TaskContextService } from "@/lib/context/task-context-service";
import { syncProjectAoRuntime } from "@/lib/ao-bridge/ao-task-linker";
import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import type {
  BackendAdapter,
} from "@/lib/engine/backends/backend-adapter";
import { resolveBackendWorkingDirectory } from "@/lib/engine/backends/backend-adapter";
import type { BackendAdapterRegistry } from "@/lib/engine/backends/backend-adapter-registry";
import { createBackendAdapterRegistry } from "@/lib/engine/backends/backend-adapter-registry";
import { resolveExecutorConfigForJob } from "@/lib/engine/executor-registry";
import type { ExecutorResult } from "@/lib/engine/executor-registry";
import {
  finalizeTaskRunFailure,
  finalizeTaskRunSuccess,
  loadTaskContextInput,
  refreshTaskContextArtifacts,
} from "@/lib/engine/task-run-executor";
import type { EngineJob, EngineRunLogEntry } from "@/lib/engine/loop-engine-types";
import { parseTaskRunJobPayload } from "@/lib/engine/loop-engine-types";
import { isExternalExecutorBackend } from "@/lib/engine/backends/backend-adapter";
import { redactEngineLogEntry } from "@/lib/engine/loop-scheduler";
import { githubTokenFromEnv } from "@/lib/github/github-connection";
import { syncGitHubPullRequest } from "@/lib/github/github-prs";
import {
  externalUntrustedPrefix,
  formatExternalUntrustedValue,
  redactSensitiveText,
} from "@/lib/security/safe-context";
import { completeWorkflowStepFromEngineJob } from "@/lib/workflows/workflow-runner";
import { maybeFollowUpAfterCompletedJob } from "@/lib/engine/auto-advance";

export const ENGINE_JOB_AWAITING_EXTERNAL_SYNC_KEY = "awaitingExternalSync";

export type EngineSyncResult = {
  examined: number;
  stillRunning: number;
  completed: number;
  failed: number;
  timedOut: number;
  prSynced: number;
};

export type EngineSyncDeps = {
  repository: LoopBoardRepository;
  adapterRegistry?: BackendAdapterRegistry;
  contextService?: TaskContextService;
  syncPullRequest?: typeof syncGitHubPullRequest;
  resolveGitHubToken?: () => string;
  now?: () => Date;
};

const emptyEngineSyncResult = (): EngineSyncResult => ({
  examined: 0,
  stillRunning: 0,
  completed: 0,
  failed: 0,
  timedOut: 0,
  prSynced: 0,
});

const nowIso = (now: () => Date): string => now().toISOString();

const engineLogEntry = (
  level: EngineRunLogEntry["level"],
  message: string,
  metadata: EngineRunLogEntry["metadata"] = {},
  timestamp: string,
): EngineRunLogEntry =>
  redactEngineLogEntry({
    timestamp,
    level,
    message,
    metadata,
  });

export const resolveJobExecutorConfigForSync = (
  job: EngineJob,
): ReturnType<typeof resolveExecutorConfigForJob> => {
  const payload = parseTaskRunJobPayload(job.payload);
  if (payload) {
    return payload.executorConfig;
  }

  return resolveExecutorConfigForJob(job);
};

export const isEngineJobAwaitingExternalSync = (job: EngineJob): boolean =>
  job.status === "running" &&
  job.result?.[ENGINE_JOB_AWAITING_EXTERNAL_SYNC_KEY] === true;

export const resolveEngineJobPollDeadlineMs = (
  job: EngineJob,
  timeoutMs: number | undefined,
): number | undefined => {
  if (!job.startedAt || !timeoutMs || timeoutMs <= 0) {
    return undefined;
  }

  const startedAtMs = Date.parse(job.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return undefined;
  }

  return startedAtMs + timeoutMs;
};

export const hasEngineJobPollTimedOut = (
  job: EngineJob,
  timeoutMs: number | undefined,
  now: () => Date,
): boolean => {
  const deadline = resolveEngineJobPollDeadlineMs(job, timeoutMs);
  return deadline !== undefined && now().getTime() >= deadline;
};

const readUntrustedSummary = (summary: string | undefined): string => {
  const sanitized = summary ? redactSensitiveText(summary).trim() : "";
  if (!sanitized) {
    return `${externalUntrustedPrefix} External backend reported no summary.`;
  }

  return sanitized.startsWith(externalUntrustedPrefix)
    ? sanitized
    : formatExternalUntrustedValue(sanitized);
};

const executorResultFromPoll = (input: {
  pollStatus: "completed" | "failed" | "cancelled";
  summary: string;
  artifacts?: Record<string, unknown>;
}): ExecutorResult => ({
  success: input.pollStatus === "completed",
  stdoutSummary: readUntrustedSummary(input.summary),
  result: {
    ...(input.artifacts ?? {}),
    untrusted: true,
    [ENGINE_JOB_AWAITING_EXTERNAL_SYNC_KEY]: false,
  },
  logs: [],
  ...(input.pollStatus === "completed"
    ? {}
    : {
        error:
          input.pollStatus === "cancelled"
            ? readUntrustedSummary(input.summary)
            : readUntrustedSummary(input.summary),
      }),
});

const syncExternalPullRequestForTask = async (input: {
  repository: LoopBoardRepository;
  taskId: string;
  projectId: string;
  prUrl: string;
  syncPullRequest: typeof syncGitHubPullRequest;
  resolveGitHubToken: () => string;
  now: () => Date;
}): Promise<boolean> => {
  const project = input.repository.getProject(input.projectId);
  const task = input.repository.getTask(input.taskId);
  const token = input.resolveGitHubToken();

  const syncResult = await input.syncPullRequest({
    repository: project.githubRepository,
    token,
    task,
    explicitPullRequestUrl: input.prUrl,
    now: input.now(),
  });

  if (syncResult.status === "synced" && syncResult.github) {
    input.repository.syncTaskGitHubPullRequest(input.taskId, {
      github: syncResult.github,
      syncedAt: syncResult.syncedAt,
      message: readUntrustedSummary(syncResult.message),
    });
    return true;
  }

  if (syncResult.github?.pullRequestUrl) {
    input.repository.syncTaskGitHubPullRequest(input.taskId, {
      github: syncResult.github,
      syncedAt: syncResult.syncedAt,
      message: readUntrustedSummary(syncResult.message),
    });
    return true;
  }

  input.repository.appendTaskEvent(input.taskId, {
    type: "PR_OPENED",
    actor: "system",
    message: readUntrustedSummary(
      `External backend reported pull request ${input.prUrl}; GitHub sync returned ${syncResult.status}.`,
    ),
    metadata: {
      pullRequestUrl: input.prUrl,
      syncStatus: syncResult.status,
      untrusted: true,
    },
  });

  return false;
};

const reconcileTaskRunFromPoll = async (input: {
  repository: LoopBoardRepository;
  contextService: TaskContextService;
  job: EngineJob;
  executorResult: ExecutorResult;
  syncPullRequest: typeof syncGitHubPullRequest;
  resolveGitHubToken: () => string;
  now: () => Date;
}): Promise<number> => {
  const taskId = input.job.taskId;
  if (!taskId) {
    return 0;
  }

  const prUrl =
    typeof input.executorResult.result?.prUrl === "string"
      ? input.executorResult.result.prUrl
      : undefined;

  let prSynced = 0;
  if (prUrl && input.job.projectId) {
    const synced = await syncExternalPullRequestForTask({
      repository: input.repository,
      taskId,
      projectId: input.job.projectId,
      prUrl,
      syncPullRequest: input.syncPullRequest,
      resolveGitHubToken: input.resolveGitHubToken,
      now: input.now,
    });
    if (synced) {
      prSynced = 1;
    }
  }

  if (input.executorResult.success) {
    finalizeTaskRunSuccess(
      input.repository,
      input.contextService,
      taskId,
      input.job,
      input.executorResult,
    );
  } else {
    finalizeTaskRunFailure(
      input.repository,
      input.contextService,
      taskId,
      input.job,
      input.executorResult.error ??
        input.executorResult.stdoutSummary ??
        "External backend reported failure.",
      false,
    );
  }

  return prSynced;
};

const appendExternalSyncProgress = (
  repository: LoopBoardRepository,
  contextService: TaskContextService,
  job: EngineJob,
  summary: string,
): void => {
  if (!job.taskId) {
    return;
  }

  repository.appendTaskEvent(job.taskId, {
    type: "ENGINE_EXTERNAL_SYNC",
    actor: "system",
    message: readUntrustedSummary(summary),
    metadata: {
      jobId: job.id,
      backend: job.backend,
      untrusted: true,
    },
  });

  refreshTaskContextArtifacts(repository, contextService, job.taskId, "handoff-and-events");
};

const finalizeTimedOutEngineJob = (input: {
  repository: LoopBoardRepository;
  contextService: TaskContextService;
  job: EngineJob;
  adapter: BackendAdapter;
  config: ReturnType<typeof resolveExecutorConfigForJob>;
  now: () => Date;
}): EngineSyncResult => {
  const timestamp = nowIso(input.now);
  const message =
    "External backend poll exceeded timeout. The external session remains running; review it manually or retry from the dashboard.";

  const executionLogs = [
    ...input.job.executionLogs,
    engineLogEntry(
      "error",
      message,
      {
        jobId: input.job.id,
        backend: input.job.backend,
        externalSessionId: input.job.result?.externalSessionId,
      },
      timestamp,
    ),
  ];

  input.repository.updateEngineJob(input.job.id, {
    status: "failed",
    error: message,
    result: {
      ...(input.job.result ?? {}),
      [ENGINE_JOB_AWAITING_EXTERNAL_SYNC_KEY]: false,
      pollTimedOut: true,
      branchLabel: "blocked",
      untrusted: true,
    },
    executionLogs,
    completedAt: timestamp,
    updatedAt: timestamp,
  });

  if (input.job.taskId) {
    finalizeTaskRunFailure(
      input.repository,
      input.contextService,
      input.job.taskId,
      input.job,
      message,
      false,
    );
  } else if (
    input.job.kind === "workflow-step" &&
    input.job.workflowRunId &&
    input.job.workflowNodeId
  ) {
    completeWorkflowStepFromEngineJob({
      repository: input.repository,
      job: {
        ...input.job,
        status: "failed",
        error: message,
        result: {
          ...(input.job.result ?? {}),
          branchLabel: "blocked",
          pollTimedOut: true,
        },
      },
      success: false,
      error: message,
      branchLabel: "blocked",
    });
  }

  return {
    examined: 1,
    stillRunning: 0,
    completed: 0,
    failed: 0,
    timedOut: 1,
    prSynced: 0,
  };
};

const reconcileCompletedEngineJob = async (input: {
  repository: LoopBoardRepository;
  contextService: TaskContextService;
  job: EngineJob;
  executorResult: ExecutorResult;
  syncPullRequest: typeof syncGitHubPullRequest;
  resolveGitHubToken: () => string;
  now: () => Date;
}): Promise<Pick<EngineSyncResult, "completed" | "failed" | "prSynced">> => {
  const timestamp = nowIso(input.now);
  const status = input.executorResult.success ? "completed" : "failed";

  input.repository.updateEngineJob(input.job.id, {
    status,
    result: input.executorResult.result ?? null,
    error: input.executorResult.error ?? null,
    executionLogs: [
      ...input.job.executionLogs,
      engineLogEntry(
        input.executorResult.success ? "info" : "error",
        input.executorResult.success
          ? "External backend sync completed successfully."
          : `External backend sync failed: ${input.executorResult.error ?? "unknown error"}`,
        { jobId: input.job.id, backend: input.job.backend },
        timestamp,
      ),
    ],
    completedAt: timestamp,
    updatedAt: timestamp,
  });

  let prSynced = 0;

  if (input.job.kind === "task-run" && input.job.taskId) {
    prSynced = await reconcileTaskRunFromPoll(input);
  } else if (
    input.job.kind === "workflow-step" &&
    input.job.workflowRunId &&
    input.job.workflowNodeId
  ) {
    const branchLabel =
      typeof input.executorResult.result?.branchLabel === "string"
        ? input.executorResult.result.branchLabel
        : undefined;

    completeWorkflowStepFromEngineJob({
      repository: input.repository,
      job: {
        ...input.job,
        status,
        result: input.executorResult.result,
        error: input.executorResult.error,
      },
      success: input.executorResult.success,
      error: input.executorResult.error,
      branchLabel,
    });

    const prUrl =
      typeof input.executorResult.result?.prUrl === "string"
        ? input.executorResult.result.prUrl
        : undefined;

    if (prUrl && input.job.projectId && input.job.taskId) {
      const synced = await syncExternalPullRequestForTask({
        repository: input.repository,
        taskId: input.job.taskId,
        projectId: input.job.projectId,
        prUrl,
        syncPullRequest: input.syncPullRequest,
        resolveGitHubToken: input.resolveGitHubToken,
        now: input.now,
      });
      if (synced) {
        prSynced = 1;
      }
    }
  }

  const updatedJob = input.repository.getEngineJob(input.job.id);
  maybeFollowUpAfterCompletedJob(input.repository, updatedJob, {
    tickMode: "automated",
    success: input.executorResult.success,
  });

  return {
    completed: input.executorResult.success ? 1 : 0,
    failed: input.executorResult.success ? 0 : 1,
    prSynced,
  };
};

export const syncInFlightEngineJobs = async (
  deps: EngineSyncDeps,
): Promise<EngineSyncResult> => {
  const result = emptyEngineSyncResult();
  const repository = deps.repository;
  const contextService = deps.contextService ?? new TaskContextService();
  const adapterRegistry =
    deps.adapterRegistry ?? createBackendAdapterRegistry(repository, contextService);
  const syncPullRequest = deps.syncPullRequest ?? syncGitHubPullRequest;
  const resolveGitHubToken = deps.resolveGitHubToken ?? githubTokenFromEnv;
  const now = deps.now ?? (() => new Date());

  const runningJobs = repository
    .listEngineJobs({ status: "running" })
    .filter(isEngineJobAwaitingExternalSync);

  const aoProjectsToSync = new Set<string>();

  for (const job of runningJobs) {
    if (!isExternalExecutorBackend(job.backend)) {
      continue;
    }

    if (job.backend === "agent-orchestrator" && job.projectId) {
      aoProjectsToSync.add(job.projectId);
    }

    result.examined += 1;

    const adapter = adapterRegistry.get(job.backend);
    if (!adapter?.poll) {
      result.stillRunning += 1;
      continue;
    }

    if (!job.projectId) {
      result.failed += 1;
      continue;
    }

    const project = repository.getProject(job.projectId);
    const config = resolveJobExecutorConfigForSync(job);
    const pollContext = {
      projectRepoPath: project.repoPath,
      cwd: resolveBackendWorkingDirectory(config, project.repoPath),
      config,
    };

    if (hasEngineJobPollTimedOut(job, config.timeoutMs, now)) {
      const timedOut = finalizeTimedOutEngineJob({
        repository,
        contextService,
        job,
        adapter,
        config,
        now,
      });
      result.timedOut += timedOut.timedOut;
      result.failed += timedOut.timedOut;
      continue;
    }

    let pollResult;
    try {
      pollResult = await adapter.poll(job, pollContext);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "External backend poll failed unexpectedly.";

      appendExternalSyncProgress(repository, contextService, job, message);
      result.stillRunning += 1;
      continue;
    }

    if (pollResult.status === "running") {
      if (job.taskId && pollResult.summary.trim().length > 0) {
        appendExternalSyncProgress(repository, contextService, job, pollResult.summary);
      }

      repository.updateEngineJob(job.id, {
        result: {
          ...(job.result ?? {}),
          ...(pollResult.artifacts ?? {}),
          lastExternalSummary: readUntrustedSummary(pollResult.summary),
          lastPolledAt: nowIso(now),
        },
        updatedAt: nowIso(now),
      });

      result.stillRunning += 1;
      continue;
    }

    const executorResult = executorResultFromPoll({
      pollStatus: pollResult.status,
      summary: pollResult.summary,
      artifacts: pollResult.artifacts,
    });

    const reconciled = await reconcileCompletedEngineJob({
      repository,
      contextService,
      job,
      executorResult,
      syncPullRequest,
      resolveGitHubToken,
      now,
    });

    result.completed += reconciled.completed;
    result.failed += reconciled.failed;
    result.prSynced += reconciled.prSynced;
  }

  for (const projectId of aoProjectsToSync) {
    const project = repository.getProject(projectId);
    if (!project.engineSettings.agentOrchestrator?.enabled) {
      continue;
    }

    try {
      await syncProjectAoRuntime(
        repository,
        projectId,
        project.engineSettings.agentOrchestrator.projectId,
      );
    } catch {
      // AO daemon may be offline; task overlay sync is best-effort.
    }
  }

  return result;
};

export const refreshExternalSyncContextForTask = (
  repository: LoopBoardRepository,
  taskId: string,
  summary: string,
  contextService: TaskContextService = new TaskContextService(),
): void => {
  loadTaskContextInput(repository, taskId);
  repository.appendTaskEvent(taskId, {
    type: "ENGINE_EXTERNAL_SYNC",
    actor: "system",
    message: readUntrustedSummary(summary),
    metadata: { untrusted: true },
  });
  refreshTaskContextArtifacts(repository, contextService, taskId, "handoff-and-events");
};
