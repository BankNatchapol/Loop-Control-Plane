import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import type { EngineRunLogEntry } from "@/lib/engine/loop-engine-types";
import {
  findWorkflowArtifactByName,
  markWorkflowArtifactUntrusted,
  parseGitArtifactBranch,
  resolveWorkflowArtifactPlaceholders,
} from "@/lib/engine/executors/workflow-artifact-paths";
import type { WorkflowStepExecutorResult } from "@/lib/engine/executors/workflow-step-types";
import {
  ProcessRunner,
  defaultProcessRunner,
  type ProcessRunPolicyContext,
  type ProcessRunResult,
} from "@/lib/engine/process-runner";
import { githubTokenFromEnv } from "@/lib/github/github-connection";
import {
  parseGitHubPullRequestNumber,
  syncGitHubPullRequest,
  type GitHubPullRequestSyncResult,
} from "@/lib/github/github-prs";
import type { WorkflowArtifact } from "@/lib/loopboard";
import { normalizeGitHubRepository } from "@/lib/projects/project-repository-health";

type FetchLike = typeof fetch;

export type OpenPrProcessRunner = {
  run: (request: Parameters<ProcessRunner["run"]>[0]) => Promise<ProcessRunResult>;
};

export type OpenPrExecutorInput = {
  repository: LoopBoardRepository;
  featureId: string;
  workflowRunId?: string;
  inputArtifacts: WorkflowArtifact[];
  outputArtifacts: WorkflowArtifact[];
  useGhCreateFallback?: boolean;
  prTitle?: string;
  prBody?: string;
  timeoutMs?: number;
  projectRepoPath?: string;
  cwd?: string;
  token?: string;
  fetcher?: FetchLike;
  processRunner?: OpenPrProcessRunner;
  policy?: ProcessRunPolicyContext;
  syncPullRequest?: typeof syncGitHubPullRequest;
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

const extractPullRequestUrl = (stdout: string): string | undefined => {
  const match = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/u.exec(stdout);
  return match?.[0];
};

export const executeOpenPr = async (
  input: OpenPrExecutorInput,
): Promise<WorkflowStepExecutorResult> => {
  const branchArtifact = findWorkflowArtifactByName(input.inputArtifacts, [
    "implementation-branch",
    "manual-patch",
  ]);
  const pullRequestArtifact = findWorkflowArtifactByName(input.outputArtifacts, [
    "pull-request",
  ]);

  if (!pullRequestArtifact) {
    return {
      success: false,
      errorCode: "open_pr_output_missing",
      error: "Open PR requires a pull-request output artifact.",
      logs: [
        logEntry("error", "Pull request output artifact was not configured.", {
          featureId: input.featureId,
        }),
      ],
    };
  }

  const feature = input.repository.getFeature(input.featureId);
  const project = input.repository.getProject(feature.projectId);
  const projectRepoPath = input.projectRepoPath ?? project.repoPath;
  const repositorySlug =
    normalizeGitHubRepository(project.githubRepository) || project.githubRepository;
  const token = input.token ?? githubTokenFromEnv();
  const syncPullRequest = input.syncPullRequest ?? syncGitHubPullRequest;
  const featureTasks = input.repository
    .listBoardData(project.id)
    .tasks.filter((task) => task.featureId === input.featureId);
  const branch =
    parseGitArtifactBranch(branchArtifact?.path ?? "") ??
    featureTasks.find((task) => task.branch)?.branch ??
    featureTasks.find((task) => task.github.pullRequestBranch)?.github.pullRequestBranch;

  const logs: EngineRunLogEntry[] = [
    logEntry("info", "Open PR executor started.", {
      featureId: input.featureId,
      branch: branch ?? null,
      taskCount: featureTasks.length,
    }),
  ];

  if (featureTasks.length === 0) {
    return {
      success: false,
      errorCode: "open_pr_no_tasks",
      error: "No feature-linked tasks were found for pull request discovery.",
      logs: [
        ...logs,
        logEntry("error", "Feature has no linked tasks.", {
          featureId: input.featureId,
        }),
      ],
    };
  }

  let syncedResult: GitHubPullRequestSyncResult | undefined;
  let syncedTaskId: string | undefined;

  for (const task of featureTasks) {
    if (task.github.pullRequestUrl && task.github.pullRequestNumber) {
      syncedTaskId = task.id;
      syncedResult = {
        status: "synced",
        repository: repositorySlug,
        message: `Task already linked to pull request #${task.github.pullRequestNumber}.`,
        syncedAt: new Date().toISOString(),
        github: task.github,
        linkedIssueNumbers: task.github.issueNumber ? [task.github.issueNumber] : [],
      };
      break;
    }

    const result = await syncPullRequest({
      repository: project.githubRepository,
      token,
      task,
      fetcher: input.fetcher,
    });

    if (result.status === "synced" && result.github?.pullRequestUrl) {
      input.repository.syncTaskGitHubPullRequest(task.id, {
        github: result.github,
        syncedAt: result.syncedAt,
        message: result.message,
      });
      syncedResult = result;
      syncedTaskId = task.id;
      logs.push(
        logEntry("info", result.message, {
          taskId: task.id,
          pullRequestNumber: result.github.pullRequestNumber ?? null,
        }),
      );
      break;
    }

    logs.push(
      logEntry("info", result.message, {
        taskId: task.id,
        status: result.status,
      }),
    );
  }

  if (!syncedResult?.github?.pullRequestUrl && input.useGhCreateFallback !== false) {
    if (!branch) {
      return {
        success: false,
        errorCode: "open_pr_branch_missing",
        error: "Open PR could not resolve an implementation branch for gh pr create.",
        logs: [
          ...logs,
          logEntry("error", "Implementation branch artifact was missing or invalid.", {
            branchArtifactPath: branchArtifact?.path ?? null,
          }),
        ],
      };
    }

    const runner = input.processRunner ?? defaultProcessRunner;
    const title = input.prTitle ?? `Loop Control Plane: ${feature.name}`;
    const body =
      input.prBody ??
      `Automated pull request for feature ${feature.name} (${feature.id}).`;

    logs.push(
      logEntry("info", "Attempting gh pr create fallback.", {
        branch,
        title,
      }),
    );

    let processResult: ProcessRunResult;
    try {
      processResult = await runner.run({
        profile: "gh",
        args: ["pr", "create", "--head", branch, "--title", title, "--body", body],
        cwd: input.cwd ?? projectRepoPath,
        projectRepoPath,
        timeoutMs: input.timeoutMs,
        policy: input.policy,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "gh pr create execution failed.";
      return {
        success: false,
        errorCode: "open_pr_gh_failed",
        error: message,
        logs: [...logs, logEntry("error", message, { branch })],
      };
    }

    logs.push(
      logEntry(
        processResult.success ? "info" : "error",
        processResult.success
          ? "gh pr create completed."
          : "gh pr create failed.",
        {
          exitCode: processResult.exitCode,
          timedOut: processResult.timedOut,
          stdoutSummary: processResult.stdoutSummary,
          stderrSummary: processResult.stderrSummary,
        },
      ),
    );

    if (!processResult.success) {
      return {
        success: false,
        errorCode: processResult.timedOut ? "open_pr_timeout" : "open_pr_gh_failed",
        error: processResult.timedOut
          ? "gh pr create timed out."
          : `gh pr create exited with code ${processResult.exitCode ?? "unknown"}.`,
        result: {
          exitCode: processResult.exitCode,
          timedOut: processResult.timedOut,
          stderrSummary: processResult.stderrSummary,
        },
        logs,
      };
    }

    const pullRequestUrl =
      extractPullRequestUrl(processResult.stdout) ??
      extractPullRequestUrl(processResult.stdoutSummary);
    const pullRequestNumber = parseGitHubPullRequestNumber(
      pullRequestUrl,
      repositorySlug,
    );

    if (!pullRequestUrl || !pullRequestNumber) {
      return {
        success: false,
        errorCode: "open_pr_url_missing",
        error: "gh pr create did not return a pull request URL.",
        result: {
          stdoutSummary: processResult.stdoutSummary,
        },
        logs,
      };
    }

    const primaryTask = featureTasks[0];
    if (primaryTask) {
      input.repository.syncTaskGitHubPullRequest(primaryTask.id, {
        github: {
          ...primaryTask.github,
          pullRequestNumber,
          pullRequestUrl,
          pullRequestBranch: branch,
          pullRequestState: "open",
        },
        message: `Created GitHub pull request #${pullRequestNumber}.`,
      });
      syncedTaskId = primaryTask.id;
    }

    syncedResult = {
      status: "synced",
      repository: repositorySlug,
      message: `Created GitHub pull request #${pullRequestNumber}.`,
      syncedAt: new Date().toISOString(),
      github: {
        ...(featureTasks[0]?.github ?? {}),
        pullRequestNumber,
        pullRequestUrl,
        pullRequestBranch: branch,
        pullRequestState: "open",
      },
      linkedIssueNumbers: featureTasks[0]?.github.issueNumber
        ? [featureTasks[0].github.issueNumber]
        : [],
    };
  }

  if (!syncedResult?.github?.pullRequestUrl) {
    return {
      success: false,
      errorCode: "open_pr_not_found",
      error: "No linked GitHub pull request was found or created for this feature.",
      logs: [
        ...logs,
        logEntry("error", "Pull request discovery and creation did not succeed.", {
          syncedTaskId: syncedTaskId ?? null,
        }),
      ],
    };
  }

  const resolvedArtifact = markWorkflowArtifactUntrusted(
    resolveWorkflowArtifactPlaceholders(pullRequestArtifact, {
      repository: repositorySlug,
      feature: input.featureId,
      run: input.workflowRunId ?? "unknown",
      branch: syncedResult.github.pullRequestBranch ?? branch ?? "unknown",
    }),
    "GitHub pull request URLs and CI metadata from the GitHub API are external and untrusted.",
  );

  return {
    success: true,
    outputArtifacts: [
      {
        ...resolvedArtifact,
        path: syncedResult.github.pullRequestUrl,
      },
    ],
    result: {
      featureId: input.featureId,
      taskId: syncedTaskId ?? null,
      pullRequestNumber: syncedResult.github.pullRequestNumber ?? null,
      pullRequestUrl: syncedResult.github.pullRequestUrl,
      pullRequestBranch: syncedResult.github.pullRequestBranch ?? branch ?? null,
    },
    logs: [
      ...logs,
      logEntry("info", "Open PR executor completed.", {
        pullRequestUrl: syncedResult.github.pullRequestUrl,
      }),
    ],
  };
};
