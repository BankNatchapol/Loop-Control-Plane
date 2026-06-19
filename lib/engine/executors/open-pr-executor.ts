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
import { parseGitHubPullRequestNumber } from "@/lib/github/github-prs";
import type { WorkflowArtifact } from "@/lib/loopboard";
import { normalizeGitHubRepository } from "@/lib/projects/project-repository-health";

export type OpenPrProcessRunner = {
  run: (request: Parameters<ProcessRunner["run"]>[0]) => Promise<ProcessRunResult>;
};

export type OpenPrExecutorInput = {
  repository: LoopBoardRepository;
  featureId: string;
  workflowRunId?: string;
  inputArtifacts: WorkflowArtifact[];
  outputArtifacts: WorkflowArtifact[];
  prTitle?: string;
  prBody?: string;
  timeoutMs?: number;
  projectRepoPath?: string;
  cwd?: string;
  processRunner?: OpenPrProcessRunner;
  policy?: ProcessRunPolicyContext;
  /** @deprecated Branch-exact gh lookup is always used. */
  useGhCreateFallback?: boolean;
  /** @deprecated Authentication is provided by gh. */
  token?: string;
  /** @deprecated Branch-exact gh lookup replaced API task discovery. */
  fetcher?: typeof fetch;
  /** @deprecated Branch-exact gh lookup replaced task PR synchronization. */
  syncPullRequest?: unknown;
};

type ListedPullRequest = {
  number?: number;
  url?: string;
  headRefName?: string;
};

const logEntry = (
  level: EngineRunLogEntry["level"],
  message: string,
  metadata: EngineRunLogEntry["metadata"] = {},
): EngineRunLogEntry => ({
  timestamp: new Date().toISOString(),
  level,
  message,
  metadata,
});

const extractPullRequestUrl = (stdout: string): string | undefined =>
  /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/u.exec(stdout)?.[0];

const parseListedPullRequest = (
  stdout: string,
  branch: string,
): ListedPullRequest | undefined => {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed.find(
      (entry): entry is ListedPullRequest =>
        Boolean(
          entry &&
            typeof entry === "object" &&
            (entry as ListedPullRequest).headRefName === branch &&
            typeof (entry as ListedPullRequest).url === "string",
        ),
    );
  } catch {
    return undefined;
  }
};

export const executeOpenPr = async (
  input: OpenPrExecutorInput,
): Promise<WorkflowStepExecutorResult> => {
  const branchArtifact = findWorkflowArtifactByName(input.inputArtifacts, [
    "manual-patch",
    "implementation-branch",
  ]);
  const pullRequestArtifact = findWorkflowArtifactByName(input.outputArtifacts, [
    "pull-request",
  ]);
  const branch = parseGitArtifactBranch(branchArtifact?.path ?? "");

  if (!pullRequestArtifact) {
    return {
      success: false,
      errorCode: "open_pr_output_missing",
      error: "Open PR requires a pull-request output artifact.",
      logs: [logEntry("error", "Pull request output artifact was not configured.")],
    };
  }
  if (!branch) {
    return {
      success: false,
      errorCode: "open_pr_branch_missing",
      error: "Open PR requires an exact integrated feature branch artifact.",
      logs: [
        logEntry("error", "Implementation branch artifact was missing or invalid.", {
          branchArtifactPath: branchArtifact?.path ?? null,
        }),
      ],
    };
  }

  const feature = input.repository.getFeature(input.featureId);
  const project = input.repository.getProject(feature.projectId);
  const projectRepoPath = input.projectRepoPath ?? project.repoPath;
  const repositorySlug =
    normalizeGitHubRepository(project.githubRepository) || project.githubRepository;
  const runner = input.processRunner ?? defaultProcessRunner;
  const cwd = input.cwd ?? projectRepoPath;
  const logs = [
    logEntry("info", "Finding the final pull request by its integrated branch.", {
      featureId: input.featureId,
      branch,
    }),
  ];

  let listResult: ProcessRunResult;
  try {
    listResult = await runner.run({
      profile: "gh",
      args: [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number,url,headRefName",
        "--limit",
        "1",
      ],
      cwd,
      projectRepoPath,
      timeoutMs: input.timeoutMs,
      policy: input.policy,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "gh pr list failed.";
    return {
      success: false,
      errorCode: "open_pr_lookup_failed",
      error: message,
      logs: [...logs, logEntry("error", message)],
    };
  }

  if (!listResult.success) {
    return {
      success: false,
      errorCode: listResult.timedOut ? "open_pr_timeout" : "open_pr_lookup_failed",
      error: listResult.stderrSummary || "Could not look up the final pull request.",
      logs: [...logs, logEntry("error", "Final pull request lookup failed.")],
    };
  }

  const existing = parseListedPullRequest(listResult.stdout, branch);
  let pullRequestUrl = existing?.url;
  let pullRequestNumber: number | null | undefined = existing?.number;

  if (pullRequestUrl) {
    logs.push(
      logEntry("info", "Reusing the existing final pull request for this branch.", {
        pullRequestUrl,
        branch,
      }),
    );
  } else {
    const title = input.prTitle ?? `Loop Control Plane: ${feature.name}`;
    const body =
      input.prBody ?? `Final integrated pull request for ${feature.name} (${feature.id}).`;
    let createResult: ProcessRunResult;
    try {
      createResult = await runner.run({
        profile: "gh",
        args: [
          "pr",
          "create",
          "--head",
          branch,
          "--base",
          project.defaultBranch,
          "--title",
          title,
          "--body",
          body,
        ],
        cwd,
        projectRepoPath,
        timeoutMs: input.timeoutMs,
        policy: input.policy,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "gh pr create failed.";
      return {
        success: false,
        errorCode: "open_pr_gh_failed",
        error: message,
        logs: [...logs, logEntry("error", message, { branch })],
      };
    }

    if (!createResult.success) {
      return {
        success: false,
        errorCode: createResult.timedOut ? "open_pr_timeout" : "open_pr_gh_failed",
        error: createResult.stderrSummary || "Could not create the final pull request.",
        logs: [...logs, logEntry("error", "Final pull request creation failed.")],
      };
    }

    pullRequestUrl =
      extractPullRequestUrl(createResult.stdout) ??
      extractPullRequestUrl(createResult.stdoutSummary);
    pullRequestNumber = parseGitHubPullRequestNumber(pullRequestUrl, repositorySlug);
  }

  pullRequestNumber ??= parseGitHubPullRequestNumber(pullRequestUrl, repositorySlug);
  if (!pullRequestUrl || !pullRequestNumber) {
    return {
      success: false,
      errorCode: "open_pr_url_missing",
      error: "GitHub did not return an exact final pull request URL.",
      logs: [...logs, logEntry("error", "Final pull request URL was missing.")],
    };
  }

  const primaryTask = input.repository
    .listBoardData(project.id)
    .tasks.find((task) => task.featureId === input.featureId);
  if (primaryTask) {
    input.repository.updateTask(primaryTask.id, {
      github: {
        ...primaryTask.github,
        pullRequestNumber,
        pullRequestUrl,
        pullRequestBranch: branch,
        pullRequestState: "open",
      },
    });
  }

  const resolvedArtifact = markWorkflowArtifactUntrusted(
    resolveWorkflowArtifactPlaceholders(pullRequestArtifact, {
      repository: repositorySlug,
      feature: input.featureId,
      run: input.workflowRunId ?? "unknown",
      branch,
    }),
    "GitHub pull request metadata is external and untrusted.",
  );

  return {
    success: true,
    outputArtifacts: [{ ...resolvedArtifact, path: pullRequestUrl }],
    result: {
      featureId: input.featureId,
      pullRequestNumber,
      pullRequestUrl,
      pullRequestBranch: branch,
      reused: Boolean(existing),
    },
    logs: [
      ...logs,
      logEntry("info", "Open PR executor completed.", { pullRequestUrl, branch }),
    ],
  };
};
