import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { buildAoArgv } from "@/lib/ao-bridge/ao-cli-path";
import { spawnAoAsync, spawnAoSync } from "@/lib/ao-bridge/spawn-ao";
import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { buildAoImplementQueue } from "@/lib/engine/ao-implement-queue";
import {
  integrateAoTaskPullRequests,
  type AoFeatureIntegrationResult,
} from "@/lib/engine/ao-feature-integration";
import { createAoPrReviewGate } from "@/lib/engine/ao-pr-review-loop";
import type { AoWorkerPoolSnapshot } from "@/lib/engine/ao-worker-pool-types";
import {
  resolveAgentOrchestratorSettings,
  resolveMaxConcurrentWorkers,
} from "@/lib/engine/backends/agent-orchestrator-config";
import { ensureAoProjectYaml, updateAoYamlAgentModel } from "@/lib/engine/backends/ao-yaml-config";
import {
  buildAoArgs,
  extractAoSessionId,
  mapAoSessionStatus,
  parseAoJsonSessions,
} from "@/lib/engine/backends/ao-session-status";
import { runAoWorkerPool } from "@/lib/engine/backends/ao-worker-pool";
import { AO_AGENT_PLUGIN_OPTIONS } from "@/lib/workflows/workflow-executor-editor";
import { runPrAgentReview } from "@/lib/engine/executors/pr-agent-review-runner";
import type { EngineRunLogEntry } from "@/lib/engine/loop-engine-types";
import type { WorkflowStepExecutorResult } from "@/lib/engine/executors/workflow-step-types";
import type { WorkflowArtifact } from "@/lib/loopboard";
import {
  findWorkflowArtifactByName,
  resolveWorkflowArtifactPlaceholders,
} from "@/lib/engine/executors/workflow-artifact-paths";

export type AoImplementExecutorInput = {
  workflowRunId: string;
  featureId: string;
  repository: LoopBoardRepository;
  outputArtifacts: WorkflowArtifact[];
  engineJobId?: string;
  aoProjectId?: string;
  aoAgentPlugin?: string;
  aoAgentModels?: Record<string, string>;
  repoPath?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  prAgentMaxIterations?: number;
  publishPrAgentOutput?: boolean;
  runTaskPrReview?: typeof runPrAgentReview;
  integrateTaskPullRequests?: typeof integrateAoTaskPullRequests;
};

type AoSession = {
  name?: string;
  role?: string;
  status?: string;
  issue?: number | string | null;
  issueId?: string | number | null;
  pr?: { url?: string | null; number?: number | null } | null;
  prNumber?: number | null;
};

const TERMINAL_SUCCESS = new Set(["done", "merged", "approved", "completed"]);

const logEntry = (
  level: EngineRunLogEntry["level"],
  message: string,
  metadata: EngineRunLogEntry["metadata"] = {},
): EngineRunLogEntry => ({ timestamp: new Date().toISOString(), level, message, metadata });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isAoDaemonReachable = (env: NodeJS.ProcessEnv): boolean => {
  // Check the global daemon by running from the control-plane root, not the project
  // directory, since the project may not be registered yet.
  const r = spawnAoSync(["status", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
    timeout: 10_000,
  });
  return r.status === 0;
};

const ensureAoDaemonRunning = async (
  repoPath: string,
  projectInfo: { repo: string; defaultBranch: string },
  env: NodeJS.ProcessEnv,
  logs: EngineRunLogEntry[],
): Promise<boolean> => {
  ensureAoProjectYaml({ repoPath, repo: projectInfo.repo, defaultBranch: projectInfo.defaultBranch });

  const projectId = basename(repoPath);
  const runningJsonPath = join(homedir(), ".agent-orchestrator", "running.json");

  const isProjectPolled = (): boolean => {
    try {
      if (!existsSync(runningJsonPath)) return false;
      const data = JSON.parse(readFileSync(runningJsonPath, "utf8")) as { projects?: string[] };
      return Array.isArray(data.projects) && data.projects.includes(projectId);
    } catch {
      return false;
    }
  };

  // Fast path: daemon already tracking this project.
  if (isProjectPolled()) {
    logs.push(logEntry("info", `AO daemon already polling "${projectId}".`));
    return true;
  }

  // Use full PATH arg (not project name) + AO_CALLER_TYPE=human:
  //
  // - Non-human + PATH arg → start.ts:1496 exits immediately ("AO is already running").
  //   Setting AO_CALLER_TYPE=human bypasses that early exit.
  // - Human + PATH arg → routes through fromPath → registers project in global config
  //   (or finds it in the local YAML), then calls attachAndSpawnOrchestrator which
  //   ensures an orchestrator session and calls notifyProjectChange on the daemon.
  // - No daemon → starts a fresh daemon reading the local YAML from repoPath.
  //
  // Using project-id arg (basename) would fail when daemon is running because
  // fromCwdOrId(targetGlobalRegistry=true) only looks in ~/.agent-orchestrator/config.yaml
  // and throws "Project not registered in global config" if it isn't there yet.
  logs.push(logEntry("info", "Starting AO orchestrator for project.", { repoPath, projectId }));
  const argv = buildAoArgv(["start", repoPath]);
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: repoPath,
    env: { ...env, AO_CALLER_TYPE: "human" },
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Poll until the project appears in running.projects.
  // After notifyProjectChange the daemon's lifecycle poller attaches "within ~60s"
  // (start.ts:1403). Allow 2 min to cover orchestrator session creation time too.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await sleep(5_000);
    if (isProjectPolled()) {
      logs.push(logEntry("info", `AO daemon is polling project "${projectId}".`));
      return true;
    }
  }

  logs.push(logEntry("warn", `AO daemon did not start polling "${projectId}" within timeout.`));
  return false;
};

const persistPoolSnapshot = (
  repository: LoopBoardRepository,
  engineJobId: string | undefined,
  snapshot: AoWorkerPoolSnapshot,
) => {
  if (!engineJobId) {
    return;
  }

  let job;
  try {
    job = repository.getEngineJob(engineJobId);
  } catch {
    return;
  }

  repository.updateEngineJob(engineJobId, {
    result: {
      ...(job.result ?? {}),
      aoWorkerPool: snapshot,
    },
  });
};

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
  const aoSettings = resolveAgentOrchestratorSettings({
    project,
    executorConfig: { backend: "agent-orchestrator" },
  });
  const aoProjectId = input.aoProjectId ?? aoSettings.projectId;
  const timeoutMs = input.timeoutMs ?? 1_800_000;
  const pollIntervalMs = input.pollIntervalMs ?? 15_000;
  const maxConcurrentWorkers = resolveMaxConcurrentWorkers(project);
  const prAgentMaxIterations = input.prAgentMaxIterations ?? 3;
  const runTaskPrReview = input.runTaskPrReview ?? runPrAgentReview;
  const integrateTaskPullRequests =
    input.integrateTaskPullRequests ?? integrateAoTaskPullRequests;

  const featureTasks = input.repository
    .listBoardData(project.id)
    .tasks.filter((t) => t.featureId === input.featureId && t.github.issueNumber);

  const queue = buildAoImplementQueue(featureTasks);
  for (const warning of queue.warnings) {
    logs.push(logEntry("warn", warning));
  }

  if (queue.issueNumbers.length === 0) {
    const msg = "No feature tasks with GitHub issues found for AO Implement.";
    return {
      success: false,
      errorCode: "ao_implement_no_issues",
      error: msg,
      logs: [...logs, logEntry("error", msg)],
    };
  }

  const env = { ...process.env };

  const daemonReady = await ensureAoDaemonRunning(
    repoPath,
    { repo: project.githubRepository, defaultBranch: project.defaultBranch ?? "main" },
    env,
    logs,
  );
  if (!daemonReady) {
    const msg =
      "AO did not start polling the project within 2 minutes. Ensure the repository has at least one commit on its default branch, then run `ao start` manually in the repository directory and retry.";
    return {
      success: false,
      errorCode: "ao_daemon_not_running",
      error: msg,
      logs: [...logs, logEntry("error", msg)],
    };
  }

  // Kill zombie sessions: agent process exited but AO is still stuck in "detecting" state.
  // These show up as stuck in the UI and can interfere with issueId-based session matching.
  {
    const zombieStatus = await spawnAoAsync(
      ["status", "--json", "--include-terminated", ...(aoProjectId ? ["--project", aoProjectId] : [])],
      { cwd: repoPath, env, timeout: 15_000 },
    );
    if (zombieStatus.status === 0 && zombieStatus.stdout.trim()) {
      try {
        const parsed = JSON.parse(zombieStatus.stdout.trim()) as unknown;
        const rawSessions: Record<string, unknown>[] = Array.isArray(parsed)
          ? (parsed as Record<string, unknown>[])
          : Array.isArray((parsed as { data?: unknown }).data)
            ? ((parsed as { data: Record<string, unknown>[] }).data)
            : [];
        const zombies = rawSessions.filter(
          (s) =>
            s["activity"] === "exited" &&
            !["killed", "done", "merged", "approved", "completed", "cleanup", "terminated", "cancelled"].includes(
              String(s["status"] ?? "").trim().toLowerCase(),
            ),
        );
        for (const zombie of zombies) {
          const sessionId = String(zombie["id"] ?? zombie["name"] ?? "").trim();
          if (!sessionId) continue;
          logs.push(logEntry("info", "Killing zombie session (agent exited, AO stuck detecting).", { sessionId, status: zombie["status"] }));
          await spawnAoAsync(["session", "kill", sessionId], { cwd: repoPath, env, timeout: 30_000 });
        }
      } catch {
        // Non-fatal — carry on even if cleanup fails.
      }
    }
  }

  const activePlugin = input.aoAgentPlugin ?? "claude-code";
  const pluginDefault = AO_AGENT_PLUGIN_OPTIONS.find((o) => o.value === activePlugin)?.defaultModel;
  const resolvedModel = input.aoAgentModels?.[activePlugin] ?? pluginDefault;
  if (resolvedModel) {
    try {
      updateAoYamlAgentModel(repoPath, resolvedModel);
      logs.push(logEntry("info", `Set agent-orchestrator.yaml agentConfig.model = ${resolvedModel} (plugin: ${activePlugin}).`));
    } catch (err) {
      logs.push(logEntry("warn", `Could not update agent-orchestrator.yaml model: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  const readPrHeadSha = async (prUrl: string): Promise<string | undefined> => {
    try {
      const { stdout } = await execFileAsync(
        "gh",
        ["pr", "view", prUrl, "--json", "headRefOid", "--jq", ".headRefOid"],
        { cwd: repoPath, env, timeout: 20_000 },
      );
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  };

  const taskPrReviewGate = resolvedModel
    ? createAoPrReviewGate({
        plugin: activePlugin,
        model: resolvedModel,
        maxIterations: prAgentMaxIterations,
        publishOutput: input.publishPrAgentOutput ?? true,
        readHeadSha: readPrHeadSha,
        runReview: runTaskPrReview,
        sendToWorker: async (sessionId, message) => {
          const sendResult = await spawnAoAsync(
            buildAoArgs({
              command: "send",
              ...(aoProjectId ? { projectId: aoProjectId } : {}),
              sessionId,
              message,
            }),
            { cwd: repoPath, env, timeout: 60_000 },
          );
          return sendResult.status === 0;
        },
        initialState: Object.fromEntries(
          featureTasks
            .filter((task) => task.github.issueNumber)
            .map((task) => [
              task.github.issueNumber!,
              {
                reviewedSha: task.aoRuntime?.reviewedHeadSha,
                cleanSha:
                  task.aoRuntime?.reviewVerdict === "approved"
                    ? task.aoRuntime.reviewedHeadSha
                    : undefined,
                iterations: task.aoRuntime?.reviewIteration ?? 0,
              },
            ]),
        ),
        onState: (issueNumber, state) => {
          const task = featureTasks.find(
            (candidate) => candidate.github.issueNumber === issueNumber,
          );
          if (!task) return;
          input.repository.updateTask(task.id, {
            aoRuntime: {
              ...task.aoRuntime,
              reviewedHeadSha: state.reviewedSha,
              reviewVerdict: state.verdict ?? task.aoRuntime?.reviewVerdict,
              reviewIteration: state.iterations,
              reviewError: state.error,
              lastSyncedAt: new Date().toISOString(),
            },
          });
        },
        log: (level, message, metadata = {}) => {
          logs.push(logEntry(level, message, metadata));
        },
      })
    : undefined;

  logs.push(
    logEntry("info", `Running AO worker pool for ${queue.issueNumbers.length} issues.`, {
      issueNumbers: queue.issueNumbers,
      aoProjectId,
      maxConcurrentWorkers,
    }),
  );

  const poolResult = await runAoWorkerPool({
    issueNumbers: queue.issueNumbers,
    maxConcurrentWorkers,
    timeoutMs,
    pollIntervalMs,
    workflowRunId: input.workflowRunId,
    featureId: input.featureId,
    initialItems: queue.orderedItems.map((item) => {
      const task = featureTasks.find((candidate) => candidate.id === item.taskId);
      const reviewApproved =
        task?.aoRuntime?.reviewVerdict === "approved" &&
        Boolean(task.aoRuntime.reviewedHeadSha) &&
        Boolean(task.github.pullRequestUrl);
      return {
        issueNumber: item.issueNumber,
        taskId: item.taskId,
        // Always start non-approved items as "queued" regardless of prior sessionStatus.
        // The first pollSessions call will find any still-active session and transition
        // the item to "running" via updateItemFromSession. Starting as "running" causes
        // a deadlock when the prior session was killed (not returned without --include-terminated).
        state: reviewApproved ? ("completed" as const) : ("queued" as const),
        ...(task?.aoRuntime?.sessionId
          ? { sessionId: task.aoRuntime.sessionId }
          : {}),
        ...(task?.github.pullRequestUrl
          ? { prUrl: task.github.pullRequestUrl }
          : {}),
      };
    }),
    isEligible: queue.isEligible,
    getSkipReason: queue.getSkipReason,
    resolveTaskMeta: queue.resolveTaskMeta,
    onSnapshot: (snapshot) => {
      persistPoolSnapshot(input.repository, input.engineJobId, snapshot);
      for (const item of snapshot.items) {
        const task = featureTasks.find(
          (candidate) => candidate.github.issueNumber === item.issueNumber,
        );
        if (!task) continue;
        input.repository.updateTask(task.id, {
          aoRuntime: {
            ...task.aoRuntime,
            sessionId: item.sessionId ?? task.aoRuntime?.sessionId,
            sessionStatus: item.state,
            prUrl: item.prUrl ?? task.aoRuntime?.prUrl,
            lastSyncedAt: snapshot.updatedAt,
          },
          ...(item.prUrl
            ? {
                github: {
                  ...task.github,
                  pullRequestUrl: item.prUrl,
                },
              }
            : {}),
        });
      }
    },
    onSessionObserved: async ({ issueNumber, sessionId, prUrl, session }) => {
      // Persist prUrl immediately when first seen so a server restart between
      // onState (saves reviewVerdict) and onSnapshot (saves pullRequestUrl)
      // doesn't lose the URL and cause the issue to re-queue next run.
      if (prUrl) {
        const taskRef = featureTasks.find((c) => c.github.issueNumber === issueNumber);
        if (taskRef && !taskRef.github.pullRequestUrl) {
          input.repository.updateTask(taskRef.id, {
            github: { ...taskRef.github, pullRequestUrl: prUrl },
          });
          taskRef.github.pullRequestUrl = prUrl;
        }
      }

      if (!taskPrReviewGate) return "continue";

      // Skip the review gate for sessions that terminated with failure (e.g., "killed").
      // Those workers didn't complete cleanly; let updateItemFromSession fail the item
      // so the next job can respawn a fresh worker. Pre-approved sessions are handled
      // by reviewApproved in initialItems, so no review is needed here.
      const mappedStatus = mapAoSessionStatus(session.status);
      if (mappedStatus === "failed" || mappedStatus === "cancelled") {
        return "continue";
      }

      const gateResult = await taskPrReviewGate({ issueNumber, sessionId, prUrl });

      // Merge the GitHub PR immediately when PR-Agent approves it.
      if (gateResult === "approved" && prUrl) {
        logs.push(logEntry("info", "PR-Agent approved PR. Merging to main branch.", { issueNumber, prUrl }));
        try {
          await execFileAsync(
            "gh",
            ["pr", "merge", prUrl, "--squash", "--delete-branch"],
            { cwd: repoPath, env, timeout: 60_000 },
          );
          logs.push(logEntry("info", "GitHub PR merged successfully.", { issueNumber, prUrl }));
        } catch (mergeErr) {
          const errMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
          logs.push(logEntry("warn", "GitHub PR merge after approval failed (will still mark item completed).", {
            issueNumber,
            prUrl,
            error: errMsg.slice(0, 300),
          }));
        }
      }

      return gateResult;
    },
    sleep,
    spawnOne: async (issueNumber) => {
      const spawnArgs = buildAoArgs({
        command: "spawn",
        ...(aoProjectId ? { projectId: aoProjectId } : {}),
        ...(input.aoAgentPlugin ? { agentPlugin: input.aoAgentPlugin } : {}),
        issueNumber,
      });

      const spawnResult = await spawnAoAsync(spawnArgs, {
        cwd: repoPath,
        env,
        timeout: 60_000,
      });

      if (spawnResult.status !== 0) {
        return {
          error: spawnResult.stderr.trim() || spawnResult.stdout.trim() || "spawn failed",
        };
      }

      return { sessionId: extractAoSessionId(spawnResult.stdout) };
    },
    pollSessions: async () => {
      const statusResult = await spawnAoAsync(
        buildAoArgs({
          command: "status",
          ...(aoProjectId ? { projectId: aoProjectId } : {}),
        }),
        {
          cwd: repoPath,
          env,
          timeout: 15_000,
        },
      );

      if (statusResult.status !== 0) {
        return [];
      }

      return parseAoJsonSessions(statusResult.stdout);
    },
  });

  logs.push(...poolResult.logs);
  persistPoolSnapshot(input.repository, input.engineJobId, poolResult.snapshot);

  const sessions = poolResult.records.map((record) => ({
    issue: record.issueNumber,
    status: record.status,
    prUrl: record.prUrl,
  }));

  const succeeded = sessions.filter((s) => TERMINAL_SUCCESS.has(s.status ?? ""));
  const failed = sessions.filter(
    (s) => mapAoSessionStatus(s.status) === "failed" || s.status === "skipped",
  );
  const prUrls = succeeded
    .map((s) => s.prUrl)
    .filter((u): u is string => typeof u === "string");

  if (poolResult.timedOut) {
    const msg = "AO Implement worker pool exceeded timeout before all issues finished.";
    return {
      success: false,
      errorCode: "ao_implement_timeout",
      error: msg,
      logs: [...logs, logEntry("error", msg)],
    };
  }

  if (succeeded.length !== queue.issueNumbers.length) {
    const msg =
      `AO Implement cannot integrate partial results: ${succeeded.length} of ` +
      `${queue.issueNumbers.length} task sessions completed cleanly.`;
    return {
      success: false,
      errorCode: "ao_implement_incomplete",
      error: msg,
      logs: [...logs, logEntry("error", msg, { failed: failed.length })],
    };
  }

  const sessionByIssue = new Map(
    succeeded.map((session) => [Number(session.issue), session] as const),
  );
  const missingPrIssue = queue.orderedItems.find(
    (item) => !sessionByIssue.get(item.issueNumber)?.prUrl,
  );
  if (missingPrIssue) {
    const message = `AO task issue #${missingPrIssue.issueNumber} completed without a PR URL.`;
    return {
      success: false,
      errorCode: "ao_implement_pr_missing",
      error: message,
      logs: [...logs, logEntry("error", message)],
    };
  }
  const integrationPullRequests = queue.orderedItems.map((item) => {
    const session = sessionByIssue.get(item.issueNumber)!;
    return {
      issueNumber: item.issueNumber,
      taskId: item.taskId,
      prUrl: session.prUrl!,
    };
  });

  for (const session of succeeded) {
    const issueNumber = session.issue != null ? Number(session.issue) : null;
    if (!issueNumber || !session.prUrl) continue;
    const task = featureTasks.find((t) => t.github.issueNumber === issueNumber);
    if (!task) continue;
    input.repository.updateTask(task.id, {
      github: {
        ...task.github,
        pullRequestUrl: session.prUrl,
      },
    });
  }

  let integration: AoFeatureIntegrationResult;
  try {
    integration = integrateTaskPullRequests({
      repoPath,
      featureId: input.featureId,
      defaultBranch: project.defaultBranch,
      pullRequests: integrationPullRequests,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "AO task PR integration failed.";
    return {
      success: false,
      errorCode: "ao_implement_integration_failed",
      error: message,
      logs: [...logs, logEntry("error", message)],
    };
  }

  const implementationArtifact = findWorkflowArtifactByName(input.outputArtifacts, [
    "implementation-branch",
  ]);
  if (!implementationArtifact) {
    return {
      success: false,
      errorCode: "ao_implement_output_missing",
      error: "AO Implement requires an implementation-branch output artifact.",
      logs: [...logs, logEntry("error", "Implementation branch output is missing.")],
    };
  }
  const resolvedArtifact = resolveWorkflowArtifactPlaceholders(
    implementationArtifact,
    {
      repository: project.githubRepository,
      feature: input.featureId,
      run: input.workflowRunId,
      branch: integration.branch,
    },
  );
  const prNumbers = integration.integratedPullRequests.map(
    (pullRequest) => pullRequest.pullRequestNumber,
  );

  logs.push(
    logEntry("info", "AO Implement completed.", {
      succeeded: succeeded.length,
      failed: failed.length,
      prNumbers,
      integrationBranch: integration.branch,
    }),
  );

  return {
    success: true,
    outputArtifacts: [resolvedArtifact],
    result: {
      workflowRunId: input.workflowRunId,
      featureId: input.featureId,
      succeededCount: succeeded.length,
      failedCount: failed.length,
      prUrls,
      prNumbers,
      integrationManifest: integration.integratedPullRequests.map((pullRequest) => ({
        issueNumber: pullRequest.issueNumber,
        taskId: pullRequest.taskId,
        pullRequestNumber: pullRequest.pullRequestNumber,
        headSha: pullRequest.headSha,
      })),
      implementationBranch: integration.branch,
      aoWorkerPool: poolResult.snapshot,
    },
    logs,
  };
};
