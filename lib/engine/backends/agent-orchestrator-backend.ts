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
  type ResolvedAgentOrchestratorSettings,
} from "@/lib/engine/backends/agent-orchestrator-config";
import { probeCliAvailabilityForBackend } from "@/lib/engine/backends/cli-availability";
import { parseTaskRunJobPayload } from "@/lib/engine/loop-engine-types";
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

export type AoSessionRecord = {
  issueNumber: number;
  sessionId?: string;
  status?: string;
  prUrl?: string;
};

type AoJsonEnvelope = {
  data?: AoSessionJson[];
  meta?: { hiddenTerminatedCount?: number };
};

type AoSessionJson = {
  id?: string;
  status?: string;
  issueId?: string | number | null;
  pr?: { url?: string | null; number?: number | null } | null;
};

const TERMINAL_SUCCESS_STATUSES = new Set([
  "done",
  "merged",
  "approved",
  "completed",
]);

const TERMINAL_FAILURE_STATUSES = new Set([
  "errored",
  "error",
  "ci_failed",
  "failed",
  "killed",
]);

const TERMINAL_CANCELLED_STATUSES = new Set(["terminated", "cleanup", "cancelled"]);

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });

const parseAoJsonSessions = (stdout: string): AoSessionJson[] => {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as AoJsonEnvelope | AoSessionJson[];
    if (Array.isArray(parsed)) {
      return parsed;
    }

    return Array.isArray(parsed.data) ? parsed.data : [];
  } catch {
    return [];
  }
};

export const extractAoSessionId = (stdout: string): string | undefined => {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }

  const labeledMatch = trimmed.match(/session[:\s]+([A-Za-z0-9._-]+)/iu);
  if (labeledMatch?.[1]) {
    return labeledMatch[1];
  }

  const lines = trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.at(-1);
};

export const mapAoSessionStatus = (
  status: string | undefined,
): BackendPollResult["status"] | "running" => {
  const normalized = (status ?? "").trim().toLowerCase();
  if (!normalized) {
    return "running";
  }

  if (TERMINAL_SUCCESS_STATUSES.has(normalized)) {
    return "completed";
  }

  if (TERMINAL_FAILURE_STATUSES.has(normalized)) {
    return "failed";
  }

  if (TERMINAL_CANCELLED_STATUSES.has(normalized)) {
    return "cancelled";
  }

  return "running";
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

const buildAoArgs = (input: {
  command: "spawn" | "status" | "send";
  settings: ResolvedAgentOrchestratorSettings;
  issueNumber?: number;
  sessionId?: string;
  message?: string;
}): string[] => {
  const args: string[] = [input.command];

  if (input.command === "spawn") {
    if (typeof input.issueNumber !== "number") {
      throw new Error("Agent Orchestrator spawn requires an issue number.");
    }

    args.push(String(input.issueNumber));
  }

  if (input.command === "send") {
    if (!input.sessionId || !input.message) {
      throw new Error("Agent Orchestrator send requires a session id and message.");
    }

    args.push(input.sessionId, input.message);
  }

  if (input.settings.projectId) {
    args.push("--project", input.settings.projectId);
  }

  if (input.command === "status") {
    args.push("--json", "--include-terminated");
  }

  return args;
};

const findSessionForRecord = (
  sessions: AoSessionJson[],
  record: AoSessionRecord,
): AoSessionJson | undefined => {
  if (record.sessionId) {
    const byId = sessions.find((session) => session.id === record.sessionId);
    if (byId) {
      return byId;
    }
  }

  const issueToken = String(record.issueNumber);
  return sessions.find((session) => {
    const issueId = session.issueId;
    if (issueId === null || issueId === undefined) {
      return false;
    }

    return String(issueId) === issueToken;
  });
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
      args: buildAoArgs({ command: "status", settings: input.settings }),
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
        settings: input.settings,
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
        const maxConcurrency = context.config.fanOut?.maxConcurrency ?? issueNumbers.length;

        const spawnResult = await spawnAoSessionsWithConcurrency({
          issueNumbers,
          maxConcurrency,
          context,
          settings,
          processRunner,
        });

        logs.push(...spawnResult.logs);

        if (spawnResult.records.length === 0) {
          return {
            success: false,
            error: "Agent Orchestrator did not spawn any sessions.",
            errorCode: "ao_spawn_failed",
            logs,
          };
        }

        const pollTimeoutMs = context.config.timeoutMs ?? DEFAULT_AO_POLL_TIMEOUT_MS;
        const pollResult = await pollAoSessionsUntilTerminal({
          records: spawnResult.records,
          context,
          settings,
          processRunner,
          timeoutMs: pollTimeoutMs,
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
        });

        logs.push(...pollResult.logs);

        const sessionStatuses = pollResult.records.map((record) =>
          mapAoSessionStatus(record.status),
        );
        const allCompleted = sessionStatuses.every((status) => status === "completed");
        const anyFailed = sessionStatuses.some(
          (status) => status === "failed" || status === "cancelled",
        );

        const primarySession = pollResult.records[0];
        const aggregateStatus: BackendPollResult["status"] = pollResult.timedOut
          ? "failed"
          : allCompleted
            ? "completed"
            : anyFailed
              ? "failed"
              : "running";

        const summary = pollResult.timedOut
          ? "Agent Orchestrator poll exceeded timeout; external sessions remain running."
          : summarizeSessionRecords(pollResult.records);

        const branchLabel = mapPollStatusToBranchLabel(aggregateStatus);
        const externalSessionId = primarySession?.sessionId;

        if (pollResult.timedOut) {
          return {
            success: false,
            error: summary,
            errorCode: "ao_poll_timeout",
            externalSessionId,
            stdoutSummary: summary,
            result: {
              branchLabel: "blocked",
              externalSessionId,
              sessions: pollResult.records,
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
            externalSessionId,
            stdoutSummary: summary,
            result: {
              branchLabel,
              externalSessionId,
              sessions: pollResult.records,
              untrusted: true,
              ...(pollResult.records.find((record) => record.prUrl)?.prUrl
                ? {
                    prUrl: pollResult.records.find((record) => record.prUrl)?.prUrl,
                  }
                : {}),
            },
            logs,
          };
        }

        return {
          success: true,
          externalSessionId,
          stdoutSummary: summary,
          result: {
            branchLabel,
            externalSessionId,
            sessions: pollResult.records,
            untrusted: true,
            ...(pollResult.records.find((record) => record.prUrl)?.prUrl
              ? { prUrl: pollResult.records.find((record) => record.prUrl)?.prUrl }
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

    async cancel(): Promise<void> {
      // AO sessions keep running externally by default; do not kill on cancel.
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
        args: buildAoArgs({ command: "status", settings }),
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
      settings: input.settings,
      sessionId: input.sessionId,
      message: input.message,
    }),
    context: input.context,
    processRunner: input.processRunner ?? defaultProcessRunner,
  });

  return run;
};
