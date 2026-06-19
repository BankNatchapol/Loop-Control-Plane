import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import type {
  BackendAdapter,
  BackendExecutionContext,
  BackendExecutionResult,
  BackendPollContext,
  BackendPollResult,
} from "@/lib/engine/backends/backend-adapter";
import {
  backendLogEntry,
  backendUnavailableResult,
  releaseBackendJob,
  runBackendProcessProfile,
  trackBackendJob,
} from "@/lib/engine/backends/backend-common";
import {
  DEFAULT_AO_POLL_TIMEOUT_MS,
  describeAgentOrchestratorAvailability,
  ensureAoReadyHandoff,
  resolveAgentOrchestratorSettings,
  resolveIssueNumbersForExecution,
  resolveMaxConcurrentWorkers,
  type ResolvedAgentOrchestratorSettings,
} from "@/lib/engine/backends/agent-orchestrator-config";
import {
  buildAoArgs,
  extractAoSessionId,
  findSessionForRecord,
  mapAoSessionStatus,
  parseAoJsonSessions,
  type AoSessionJson,
} from "@/lib/engine/backends/ao-session-status";
import { runAoWorkerPool } from "@/lib/engine/backends/ao-worker-pool";
import type { AoSessionRecord } from "@/lib/engine/ao-worker-pool-types";
import { probeCliAvailabilityForBackend } from "@/lib/engine/backends/cli-availability";
import { ENGINE_JOB_AWAITING_EXTERNAL_SYNC_KEY } from "@/lib/engine/engine-sync-service";
import { parseTaskRunJobPayload } from "@/lib/engine/loop-engine-types";
import { parseWorkflowStepJobPayload } from "@/lib/engine/executors/workflow-step-types";
import {
  ProcessRunner,
  defaultProcessRunner,
  type ProcessRunResult,
} from "@/lib/engine/process-runner";

export type AgentOrchestratorBackendDeps = {
  repository?: LoopBoardRepository;
  processRunner?: ProcessRunner;
  availabilityCheck?: () => Promise<import("@/lib/engine/backends/backend-adapter").BackendAvailabilityResult>;
  sleep?: (ms: number) => Promise<void>;
};

export type { AoSessionRecord };

const activeAoSessionsByJob = new Map<string, Set<string>>();

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });

export {
  buildAoArgs,
  extractAoSessionId,
  findSessionForRecord,
  mapAoSessionStatus,
  parseAoJsonSessions,
};

export const mapPollStatusToBranchLabel = (
  status: BackendPollResult["status"],
): string => {
  if (status === "completed") {
    return "completed";
  }

  if (status === "cancelled") {
    return "cancelled";
  }

  return "blocked";
};

export const pollAoSessionsUntilTerminal = async (input: {
  records: AoSessionRecord[];
  context: BackendExecutionContext;
  settings: ResolvedAgentOrchestratorSettings;
  processRunner: ProcessRunner;
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{
  records: AoSessionRecord[];
  timedOut: boolean;
  logs: BackendExecutionResult["logs"];
}> => {
  const sleep = input.sleep ?? defaultSleep;
  const logs: BackendExecutionResult["logs"] = [];
  const deadline = Date.now() + input.timeoutMs;
  const records = input.records.map((record) => ({ ...record }));

  while (Date.now() < deadline) {
    const { run, logs: statusLogs } = await runBackendProcessProfile({
      profile: "ao",
      args: buildAoArgs({ command: "status", projectId: input.settings.projectId }),
      context: input.context,
      processRunner: input.processRunner,
    });

    logs.push(...statusLogs);

    if (!run.success) {
      return {
        records,
        timedOut: false,
        logs: [
          ...logs,
          backendLogEntry("error", "Agent Orchestrator status poll failed.", {
            stderrSummary: run.stderrSummary,
          }),
        ],
      };
    }

    const sessions = parseAoJsonSessions(run.stdout);
    let pending = 0;

    for (const record of records) {
      const session = findSessionForRecord(sessions, record);
      if (!session) {
        pending += 1;
        continue;
      }

      record.sessionId = session.id ?? record.sessionId;
      record.status = session.status ?? record.status;
      record.prUrl = session.pr?.url ?? record.prUrl ?? undefined;

      const mapped = mapAoSessionStatus(record.status);
      if (mapped === "running") {
        pending += 1;
      }
    }

    if (pending === 0) {
      logs.push(
        backendLogEntry("info", "All Agent Orchestrator sessions reached a terminal state.", {
          sessionCount: records.length,
        }),
      );
      return { records, timedOut: false, logs };
    }

    await sleep(input.settings.pollIntervalMs);
  }

  return {
    records,
    timedOut: true,
    logs: [
      ...logs,
      backendLogEntry("warn", "Agent Orchestrator poll exceeded timeout.", {
        timeoutMs: input.timeoutMs,
      }),
    ],
  };
};

/** @deprecated Use runAoWorkerPool instead. */
export const spawnAoSessionsWithConcurrency = async (input: {
  issueNumbers: number[];
  maxConcurrency: number;
  context: BackendExecutionContext;
  settings: ResolvedAgentOrchestratorSettings;
  processRunner: ProcessRunner;
}): Promise<{
  records: AoSessionRecord[];
  logs: BackendExecutionResult["logs"];
  spawnFailures: string[];
}> => {
  const logs: BackendExecutionResult["logs"] = [];
  const records: AoSessionRecord[] = [];
  const spawnFailures: string[] = [];
  const queue = [...input.issueNumbers];
  const concurrency = Math.max(1, input.maxConcurrency);

  const spawnIssue = async (issueNumber: number): Promise<void> => {
    const { run, logs: spawnLogs } = await runBackendProcessProfile({
      profile: "ao",
      args: buildAoArgs({
        command: "spawn",
        projectId: input.settings.projectId,
        issueNumber,
      }),
      context: input.context,
      processRunner: input.processRunner,
    });

    logs.push(...spawnLogs);

    if (!run.success) {
      spawnFailures.push(
        `Issue #${issueNumber}: ${run.stderrSummary || run.stdoutSummary || "spawn failed"}`,
      );
      records.push({ issueNumber, status: "failed" });
      return;
    }

    const sessionId = extractAoSessionId(run.stdout);
    records.push({
      issueNumber,
      ...(sessionId ? { sessionId } : {}),
      status: "spawning",
    });

    logs.push(
      backendLogEntry("info", "Spawned Agent Orchestrator session.", {
        issueNumber,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
  };

  while (queue.length > 0) {
    const batch = queue.splice(0, concurrency);
    await Promise.all(batch.map((issueNumber) => spawnIssue(issueNumber)));
  }

  return { records, logs, spawnFailures };
};

const summarizeSessionRecords = (records: AoSessionRecord[]): string => {
  if (records.length === 1) {
    const record = records[0]!;
    return `Issue #${record.issueNumber} reached ${record.status ?? "unknown"}.`;
  }

  const completed = records.filter(
    (record) => mapAoSessionStatus(record.status) === "completed",
  ).length;

  return `${completed}/${records.length} Agent Orchestrator sessions completed.`;
};

const readRecordedAoSessionIds = (result: Record<string, unknown> | undefined): string[] => {
  if (!result) {
    return [];
  }

  const ids = new Set<string>();
  if (typeof result.externalSessionId === "string" && result.externalSessionId.trim()) {
    ids.add(result.externalSessionId.trim());
  }

  if (Array.isArray(result.sessions)) {
    for (const value of result.sessions) {
      if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { sessionId?: unknown }).sessionId === "string"
      ) {
        const sessionId = (value as { sessionId: string }).sessionId.trim();
        if (sessionId) {
          ids.add(sessionId);
        }
      }
    }
  }

  return [...ids];
};

const resolveProjectForContext = (
  context: BackendExecutionContext,
  repository?: LoopBoardRepository,
) => {
  if (!repository) {
    return undefined;
  }

  const payload = parseTaskRunJobPayload(context.job.payload);
  const projectId = context.job.projectId ?? payload?.projectId;
  if (!projectId) {
    return undefined;
  }

  return repository.getProject(projectId);
};

const persistPoolSnapshot = (
  repository: LoopBoardRepository | undefined,
  jobId: string,
  snapshot: import("@/lib/engine/ao-worker-pool-types").AoWorkerPoolSnapshot,
) => {
  if (!repository) {
    return;
  }

  let job;
  try {
    job = repository.getEngineJob(jobId);
  } catch {
    return;
  }

  repository.updateEngineJob(jobId, {
    result: {
      ...(job.result ?? {}),
      aoWorkerPool: snapshot,
    },
  });
};

export const createAgentOrchestratorBackendAdapter = (
  deps: AgentOrchestratorBackendDeps = {},
): BackendAdapter => {
  const processRunner = deps.processRunner ?? defaultProcessRunner;

  const checkAvailability = async () => {
    if (deps.availabilityCheck) {
      return deps.availabilityCheck();
    }

    return probeCliAvailabilityForBackend("agent-orchestrator");
  };

  return {
    backend: "agent-orchestrator",

    async checkAvailability() {
      const cli = await checkAvailability();
      return {
        backend: "agent-orchestrator",
        ...describeAgentOrchestratorAvailability({
          cliAvailable: cli.available,
          cliMessage: cli.message,
        }),
        ...(cli.version ? { version: cli.version } : {}),
      };
    },

    async execute(context: BackendExecutionContext): Promise<BackendExecutionResult> {
      const cli = await checkAvailability();
      const project = resolveProjectForContext(context, deps.repository);
      const availability = describeAgentOrchestratorAvailability({
        cliAvailable: cli.available,
        cliMessage: cli.message,
        ...(project ? { project } : {}),
      });

      if (!availability.available) {
        return backendUnavailableResult("agent-orchestrator", availability.message);
      }

      if (!project) {
        return backendUnavailableResult(
          "agent-orchestrator",
          "Agent Orchestrator execution requires a project-bound engine job.",
        );
      }

      const settings = resolveAgentOrchestratorSettings({
        project,
        executorConfig: context.config,
      });

      trackBackendJob(context.job.id);
      const logs = [
        backendLogEntry("info", "Agent Orchestrator backend execution started.", {
          jobId: context.job.id,
          projectId: project.id,
        }),
      ];

      try {
        const payload = parseTaskRunJobPayload(context.job.payload);
        const taskId = context.job.taskId ?? payload?.taskId;
        const isFanOut = Boolean(context.config.fanOut?.issueIds?.length);

        if (!isFanOut && taskId && deps.repository) {
          const handoff = ensureAoReadyHandoff(deps.repository, taskId);
          if (!handoff.ok) {
            return {
              success: false,
              error: handoff.message,
              errorCode: "ao_handoff_not_ready",
              logs: [...logs, backendLogEntry("error", handoff.message)],
            };
          }
        }

        let issueNumbers = resolveIssueNumbersForExecution({
          config: context.config,
          ...(deps.repository ? { repository: deps.repository } : {}),
          ...(taskId ? { jobTaskId: taskId } : {}),
        });

        if (issueNumbers.length === 0) {
          const message =
            "Agent Orchestrator requires a linked GitHub issue number or fanOut.issueIds.";
          return {
            success: false,
            error: message,
            errorCode: "ao_issue_required",
            logs: [...logs, backendLogEntry("error", message)],
          };
        }

        issueNumbers = Array.from(new Set(issueNumbers));
        const maxConcurrentWorkers = resolveMaxConcurrentWorkers(project, context.config);
        const pollTimeoutMs = context.config.timeoutMs ?? DEFAULT_AO_POLL_TIMEOUT_MS;

        const spawnIssue = async (issueNumber: number) => {
          const { run, logs: spawnLogs } = await runBackendProcessProfile({
            profile: "ao",
            args: buildAoArgs({
              command: "spawn",
              projectId: settings.projectId,
              issueNumber,
            }),
            context,
            processRunner,
          });
          logs.push(...spawnLogs);

          if (!run.success) {
            return {
              error: run.stderrSummary || run.stdoutSummary || "spawn failed",
            };
          }

          const sessionId = extractAoSessionId(run.stdout);
          return sessionId ? { sessionId } : {};
        };

        const pollSessions = async (): Promise<AoSessionJson[]> => {
          const { run, logs: statusLogs } = await runBackendProcessProfile({
            profile: "ao",
            args: buildAoArgs({ command: "status", projectId: settings.projectId }),
            context,
            processRunner,
          });
          logs.push(...statusLogs);
          return run.success ? parseAoJsonSessions(run.stdout) : [];
        };

        if (!isFanOut) {
          const issueNumber = issueNumbers[0]!;
          const spawnResult = await spawnIssue(issueNumber);
          const records: AoSessionRecord[] = [
            {
              issueNumber,
              ...(spawnResult.sessionId ? { sessionId: spawnResult.sessionId } : {}),
              status: spawnResult.error ? "failed" : "spawning",
            },
          ];

          if (spawnResult.error && !spawnResult.sessionId) {
            return {
              success: false,
              error: spawnResult.error,
              errorCode: "ao_spawn_failed",
              logs,
            };
          }

          const snapshot = {
            maxWorkers: maxConcurrentWorkers > 0 ? maxConcurrentWorkers : 0,
            updatedAt: new Date().toISOString(),
            items: [
              {
                issueNumber,
                state: "running" as const,
                ...(spawnResult.sessionId ? { sessionId: spawnResult.sessionId } : {}),
              },
            ],
          };
          persistPoolSnapshot(deps.repository, context.job.id, snapshot);

          activeAoSessionsByJob.set(
            context.job.id,
            new Set(
              records
                .map((record) => record.sessionId)
                .filter((sessionId): sessionId is string => Boolean(sessionId)),
            ),
          );

          const externalSessionId = records[0]?.sessionId;
          const summary = `Spawned Agent Orchestrator session for issue #${issueNumber}.`;

          logs.push(
            backendLogEntry("info", "Agent Orchestrator handoff deferred to engine sync.", {
              issueNumber,
              ...(externalSessionId ? { sessionId: externalSessionId } : {}),
            }),
          );

          return {
            success: true,
            externalSessionId,
            stdoutSummary: summary,
            result: {
              [ENGINE_JOB_AWAITING_EXTERNAL_SYNC_KEY]: true,
              branchLabel: "running",
              externalSessionId,
              sessions: records,
              aoWorkerPool: snapshot,
              untrusted: true,
              pollStartedAt: new Date().toISOString(),
            },
            logs,
          };
        }

        const poolResult = await runAoWorkerPool({
          issueNumbers,
          maxConcurrentWorkers,
          timeoutMs: pollTimeoutMs,
          pollIntervalMs: settings.pollIntervalMs,
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          onSnapshot: (snapshot) => persistPoolSnapshot(deps.repository, context.job.id, snapshot),
          spawnOne: spawnIssue,
          pollSessions,
        });

        logs.push(...poolResult.logs);

        const spawnResult = {
          records: poolResult.records,
          spawnFailures: poolResult.spawnFailures,
        };

        activeAoSessionsByJob.set(
          context.job.id,
          new Set(
            spawnResult.records
              .map((record) => record.sessionId)
              .filter((sessionId): sessionId is string => Boolean(sessionId)),
          ),
        );

        if (spawnResult.records.length === 0) {
          return {
            success: false,
            error: "Agent Orchestrator did not spawn any sessions.",
            errorCode: "ao_spawn_failed",
            logs,
          };
        }

        const primarySession = spawnResult.records[0];
        const externalSessionId = primarySession?.sessionId;

        const sessionStatuses = poolResult.records.map((record) =>
          mapAoSessionStatus(record.status),
        );
        const allCompleted = sessionStatuses.every((status) => status === "completed");
        const anyFailed = sessionStatuses.some(
          (status) => status === "failed" || status === "cancelled",
        );

        const polledPrimarySession = poolResult.records[0];
        const aggregateStatus: BackendPollResult["status"] = poolResult.timedOut
          ? "failed"
          : allCompleted
            ? "completed"
            : anyFailed
              ? "failed"
              : "running";

        const summary = poolResult.timedOut
          ? "Agent Orchestrator poll exceeded timeout; external sessions remain running."
          : summarizeSessionRecords(poolResult.records);

        const branchLabel = mapPollStatusToBranchLabel(aggregateStatus);
        const polledExternalSessionId = polledPrimarySession?.sessionId;

        if (poolResult.timedOut) {
          return {
            success: false,
            error: summary,
            errorCode: "ao_poll_timeout",
            externalSessionId: polledExternalSessionId,
            stdoutSummary: summary,
            result: {
              branchLabel: "blocked",
              externalSessionId: polledExternalSessionId,
              sessions: poolResult.records,
              aoWorkerPool: poolResult.snapshot,
              pollTimedOut: true,
              untrusted: true,
            },
            logs,
          };
        }

        if (!allCompleted) {
          return {
            success: false,
            error: summary,
            errorCode: "ao_session_failed",
            externalSessionId: polledExternalSessionId,
            stdoutSummary: summary,
            result: {
              branchLabel,
              externalSessionId: polledExternalSessionId,
              sessions: poolResult.records,
              aoWorkerPool: poolResult.snapshot,
              untrusted: true,
              ...(poolResult.records.find((record) => record.prUrl)?.prUrl
                ? {
                    prUrl: poolResult.records.find((record) => record.prUrl)?.prUrl,
                  }
                : {}),
            },
            logs,
          };
        }

        return {
          success: true,
          externalSessionId: polledExternalSessionId,
          stdoutSummary: summary,
          result: {
            branchLabel,
            externalSessionId: polledExternalSessionId,
            sessions: poolResult.records,
            aoWorkerPool: poolResult.snapshot,
            untrusted: true,
            ...(poolResult.records.find((record) => record.prUrl)?.prUrl
              ? { prUrl: poolResult.records.find((record) => record.prUrl)?.prUrl }
              : {}),
          },
          logs,
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Agent Orchestrator backend failed unexpectedly.";

        return {
          success: false,
          error: message,
          errorCode: "backend_adapter_failed",
          logs: [...logs, backendLogEntry("error", message)],
        };
      } finally {
        releaseBackendJob(context.job.id);
      }
    },

    async cancel(jobId: string): Promise<void> {
      const trackedIds = activeAoSessionsByJob.get(jobId) ?? new Set<string>();
      let job;
      try {
        job = deps.repository?.getEngineJob(jobId);
      } catch {
        job = undefined;
      }

      for (const sessionId of readRecordedAoSessionIds(job?.result)) {
        trackedIds.add(sessionId);
      }

      if (!job || trackedIds.size === 0) {
        activeAoSessionsByJob.delete(jobId);
        return;
      }

      const taskPayload = parseTaskRunJobPayload(job.payload);
      const workflowPayload = parseWorkflowStepJobPayload(job.payload);
      const config = taskPayload?.executorConfig ?? workflowPayload?.executor;
      const projectId = job.projectId ?? taskPayload?.projectId;
      if (!config || !projectId || !deps.repository) {
        throw new Error("Agent Orchestrator cancellation requires persisted project and executor context.");
      }

      const project = deps.repository.getProject(projectId);
      const context: BackendExecutionContext = {
        job,
        config,
        projectRepoPath: project.repoPath,
        cwd: project.repoPath,
      };
      const failures: string[] = [];

      for (const sessionId of trackedIds) {
        const { run } = await runBackendProcessProfile({
          profile: "ao",
          args: ["session", "kill", sessionId],
          context,
          processRunner,
        });
        if (!run.success) {
          failures.push(`${sessionId}: ${run.stderrSummary || run.stdoutSummary || "kill failed"}`);
        }
      }

      activeAoSessionsByJob.delete(jobId);
      if (failures.length > 0) {
        throw new Error(`Failed to cancel Agent Orchestrator session(s): ${failures.join("; ")}`);
      }
    },

    async poll(job, pollContext: BackendPollContext): Promise<BackendPollResult> {
      const project = resolveProjectForContext(
        {
          job,
          config: pollContext.config,
          projectRepoPath: pollContext.projectRepoPath,
          cwd: pollContext.cwd,
        },
        deps.repository,
      );

      if (!project) {
        return {
          status: "failed",
          summary: "Agent Orchestrator poll requires project context.",
        };
      }

      const settings = resolveAgentOrchestratorSettings({
        project,
        executorConfig: pollContext.config,
      });

      const externalSessionId =
        typeof job.result?.externalSessionId === "string"
          ? job.result.externalSessionId
          : undefined;
      const issueNumber =
        typeof pollContext.config.issueNumber === "number"
          ? pollContext.config.issueNumber
          : undefined;

      const { run } = await runBackendProcessProfile({
        profile: "ao",
        args: buildAoArgs({ command: "status", projectId: settings.projectId }),
        context: {
          job,
          config: pollContext.config,
          projectRepoPath: pollContext.projectRepoPath,
          cwd: pollContext.cwd,
        },
        processRunner,
      });

      if (!run.success) {
        return {
          status: "failed",
          summary: run.stderrSummary || "Agent Orchestrator status poll failed.",
        };
      }

      const sessions = parseAoJsonSessions(run.stdout);
      const matched = sessions.find((session) => {
        if (externalSessionId && session.id === externalSessionId) {
          return true;
        }

        if (issueNumber !== undefined && String(session.issueId ?? "") === String(issueNumber)) {
          return true;
        }

        return false;
      });

      const mapped = mapAoSessionStatus(matched?.status);
      if (mapped === "running") {
        return {
          status: "running",
          summary: matched?.status
            ? `Agent Orchestrator session is ${matched.status}.`
            : "Agent Orchestrator session is still running.",
          artifacts: {
            ...(matched?.id ? { externalSessionId: matched.id } : {}),
            ...(matched?.pr?.url ? { prUrl: matched.pr.url } : {}),
          },
        };
      }

      activeAoSessionsByJob.delete(job.id);

      return {
        status: mapped,
        summary: summarizeSessionRecords([
          {
            issueNumber: issueNumber ?? 0,
            sessionId: matched?.id,
            status: matched?.status,
            prUrl: matched?.pr?.url ?? undefined,
          },
        ]),
        artifacts: {
          branchLabel: mapPollStatusToBranchLabel(mapped),
          ...(matched?.id ? { externalSessionId: matched.id } : {}),
          ...(matched?.pr?.url ? { prUrl: matched.pr.url } : {}),
          untrusted: true,
        },
      };
    },
  };
};

export const agentOrchestratorBackendAdapter = createAgentOrchestratorBackendAdapter();

export const sendAoSessionMessage = async (input: {
  sessionId: string;
  message: string;
  context: BackendExecutionContext;
  settings: ResolvedAgentOrchestratorSettings;
  processRunner?: ProcessRunner;
}): Promise<ProcessRunResult> => {
  const { run } = await runBackendProcessProfile({
    profile: "ao",
    args: buildAoArgs({
      command: "send",
      projectId: input.settings.projectId,
      sessionId: input.sessionId,
      message: input.message,
    }),
    context: input.context,
    processRunner: input.processRunner ?? defaultProcessRunner,
  });

  return run;
};
