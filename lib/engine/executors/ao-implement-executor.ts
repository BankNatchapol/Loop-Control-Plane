import { spawnSync } from "node:child_process";
import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import type { EngineRunLogEntry } from "@/lib/engine/loop-engine-types";
import type { WorkflowStepExecutorResult } from "@/lib/engine/executors/workflow-step-types";
import type { WorkflowArtifact } from "@/lib/loopboard";

export type AoImplementExecutorInput = {
  workflowRunId: string;
  featureId: string;
  repository: LoopBoardRepository;
  outputArtifacts: WorkflowArtifact[];
  aoProjectId?: string;
  repoPath?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

type AoSession = {
  name?: string;
  role?: string;
  status?: string;
  issue?: number | string | null;
  /** Legacy field name from older ao versions */
  issueId?: string | number | null;
  pr?: { url?: string | null; number?: number | null } | null;
  prNumber?: number | null;
};

const TERMINAL_SUCCESS = new Set(["done", "merged", "approved", "completed"]);
const TERMINAL_FAILURE = new Set(["errored", "error", "ci_failed", "failed", "killed"]);
const TERMINAL_CANCELLED = new Set(["terminated", "cleanup", "cancelled"]);

const isTerminal = (status?: string): boolean =>
  TERMINAL_SUCCESS.has(status ?? "") ||
  TERMINAL_FAILURE.has(status ?? "") ||
  TERMINAL_CANCELLED.has(status ?? "");

const logEntry = (
  level: EngineRunLogEntry["level"],
  message: string,
  metadata: EngineRunLogEntry["metadata"] = {},
): EngineRunLogEntry => ({ timestamp: new Date().toISOString(), level, message, metadata });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const executeAoImplement = async (
  input: AoImplementExecutorInput,
): Promise<WorkflowStepExecutorResult> => {
  const logs: EngineRunLogEntry[] = [
    logEntry("info", "AO Implement executor started.", {
      workflowRunId: input.workflowRunId,
      featureId: input.featureId,
    }),
  ];

  const feature = input.repository.getFeature(input.featureId);
  const project = input.repository.getProject(feature.projectId);
  const repoPath = input.repoPath ?? project.repoPath;
  const aoSettings = project.engineSettings.agentOrchestrator ?? {};
  const aoProjectId = input.aoProjectId ?? (aoSettings as { projectId?: string }).projectId;
  const timeoutMs = input.timeoutMs ?? 1_800_000;
  const pollIntervalMs = input.pollIntervalMs ?? 15_000;

  // Collect feature task issue numbers
  const featureTasks = input.repository
    .listBoardData(project.id)
    .tasks.filter((t) => t.featureId === input.featureId && t.github.issueNumber);

  const issueNumbers = Array.from(
    new Set(featureTasks.map((t) => t.github.issueNumber!).filter(Boolean)),
  );

  if (issueNumbers.length === 0) {
    const msg = "No feature tasks with GitHub issues found for AO Implement.";
    return {
      success: false,
      errorCode: "ao_implement_no_issues",
      error: msg,
      logs: [...logs, logEntry("error", msg)],
    };
  }

  logs.push(
    logEntry("info", `Spawning AO agents for ${issueNumbers.length} issues.`, {
      issueNumbers,
      aoProjectId,
    }),
  );

  const env = { ...process.env };
  // ao batch-spawn uses bare issue IDs (no --project flag); the project
  // is resolved from agent-orchestrator.yaml in the repoPath directory.
  const spawnArgs = ["batch-spawn", ...issueNumbers.map(String)];

  const spawnResult = spawnSync("ao", spawnArgs, {
    cwd: repoPath,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });

  if (spawnResult.status !== 0) {
    const stderr = spawnResult.stderr?.trim() ?? "";
    const msg = `ao batch-spawn failed: ${stderr || "unknown error"}`;
    return {
      success: false,
      errorCode: "ao_implement_spawn_failed",
      error: msg,
      logs: [...logs, logEntry("error", msg, { stderr })],
    };
  }

  logs.push(logEntry("info", "AO sessions spawned — polling for completion.", { issueNumbers }));

  // Poll ao status until all relevant sessions are terminal
  const statusArgs = ["status", "--json", "--include-terminated"];

  const deadline = Date.now() + timeoutMs;
  let pollCount = 0;
  let sessions: AoSession[] = [];

  while (Date.now() < deadline) {
    pollCount += 1;
    await sleep(pollInterval(pollCount, pollIntervalMs));

    const statusResult = spawnSync("ao", statusArgs, {
      cwd: repoPath,
      encoding: "utf8",
      env,
      timeout: 15_000,
    });

    if (statusResult.status !== 0) {
      logs.push(
        logEntry("warn", "ao status poll failed; will retry.", {
          stderr: statusResult.stderr?.trim(),
        }),
      );
      continue;
    }

    let parsed: { data?: AoSession[] } = {};
    try {
      parsed = JSON.parse(statusResult.stdout || "{}");
    } catch {
      logs.push(logEntry("warn", "ao status returned invalid JSON; will retry."));
      continue;
    }

    sessions = (parsed.data ?? []).filter((s) => {
      if (s.role === "orchestrator") return false;
      const id = s.issue ?? s.issueId;
      return id != null && issueNumbers.includes(Number(id));
    });

    const pending = sessions.filter((s) => !isTerminal(s.status));
    const done = sessions.filter((s) => isTerminal(s.status));

    logs.push(
      logEntry("info", `ao status poll #${pollCount}: ${done.length}/${sessions.length} done.`, {
        pending: pending.map((s) => `issue #${s.issueId} (${s.status})`),
      }),
    );

    if (sessions.length >= issueNumbers.length && pending.length === 0) {
      break;
    }
  }

  const succeeded = sessions.filter((s) => TERMINAL_SUCCESS.has(s.status ?? ""));
  const failed = sessions.filter(
    (s) => TERMINAL_FAILURE.has(s.status ?? "") || TERMINAL_CANCELLED.has(s.status ?? ""),
  );
  const prUrls = succeeded
    .map((s) => s.pr?.url)
    .filter((u): u is string => typeof u === "string");
  const prNumbers = succeeded
    .map((s) => s.pr?.number ?? s.prNumber)
    .filter((n): n is number => typeof n === "number");

  if (succeeded.length === 0 && sessions.length > 0) {
    const msg = `All ${sessions.length} AO session(s) failed or were cancelled.`;
    return {
      success: false,
      errorCode: "ao_implement_all_failed",
      error: msg,
      logs: [...logs, logEntry("error", msg, { failed: failed.length })],
    };
  }

  // Update task records with PR info from sessions
  for (const session of succeeded) {
    const issueNumber = session.issue != null ? Number(session.issue)
      : session.issueId != null ? Number(session.issueId)
      : null;
    if (!issueNumber) continue;
    const task = featureTasks.find((t) => t.github.issueNumber === issueNumber);
    if (!task) continue;
    const prNumber = session.pr?.number ?? session.prNumber;
    if (prNumber) {
      input.repository.updateTask(task.id, {
        github: {
          ...task.github,
          pullRequestNumber: prNumber,
          pullRequestUrl: session.pr?.url ?? undefined,
        },
      });
    }
  }

  logs.push(
    logEntry("info", "AO Implement completed.", {
      succeeded: succeeded.length,
      failed: failed.length,
      prNumbers,
    }),
  );

  return {
    success: true,
    result: {
      workflowRunId: input.workflowRunId,
      featureId: input.featureId,
      succeededCount: succeeded.length,
      failedCount: failed.length,
      prUrls,
      prNumbers,
    },
    logs,
  };
};

// Back off a little after the first few polls; sessions can take 10–30 min
const pollInterval = (count: number, base: number): number =>
  count <= 3 ? Math.min(base, 10_000) : base;
