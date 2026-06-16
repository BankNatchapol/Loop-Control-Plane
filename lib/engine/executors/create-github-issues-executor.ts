import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import type { EngineRunLogEntry } from "@/lib/engine/loop-engine-types";
import {
  findWorkflowArtifactByName,
  markWorkflowArtifactUntrusted,
  resolveWorkflowArtifactPlaceholders,
} from "@/lib/engine/executors/workflow-artifact-paths";
import type { WorkflowStepExecutorResult } from "@/lib/engine/executors/workflow-step-types";
import { githubTokenFromEnv } from "@/lib/github/github-connection";
import {
  calculateGitHubIssueLabels,
  createGitHubIssue,
  renderGitHubIssueBody,
  type GitHubIssueCreateResult,
} from "@/lib/github/github-issues";
import type { WorkflowArtifact } from "@/lib/loopboard";
import {
  evaluateTaskPolicy,
  type AutomationSettings,
} from "@/lib/policies/automation-policy";
import { normalizeGitHubRepository } from "@/lib/projects/project-repository-health";

type FetchLike = typeof fetch;

export type CreateGitHubIssuesExecutorInput = {
  repository: LoopBoardRepository;
  featureId: string;
  workflowRunId?: string;
  outputArtifacts: WorkflowArtifact[];
  automationSettings?: AutomationSettings;
  token?: string;
  fetcher?: FetchLike;
  createIssue?: typeof createGitHubIssue;
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

export const executeCreateGitHubIssues = async (
  input: CreateGitHubIssuesExecutorInput,
): Promise<WorkflowStepExecutorResult> => {
  const githubIssuesArtifact =
    findWorkflowArtifactByName(input.outputArtifacts, ["github-issues"]) ??
    input.outputArtifacts[0];

  if (!githubIssuesArtifact) {
    return {
      success: false,
      errorCode: "create_github_issues_output_missing",
      error: "Create GitHub issues requires a github-issues output artifact.",
      logs: [
        logEntry("error", "GitHub issues output artifact was not configured.", {
          featureId: input.featureId,
        }),
      ],
    };
  }

  const feature = input.repository.getFeature(input.featureId);
  const project = input.repository.getProject(feature.projectId);
  const automationSettings =
    input.automationSettings ?? input.repository.getAutomationSettings();
  const token = input.token ?? githubTokenFromEnv();
  const createIssue = input.createIssue ?? createGitHubIssue;
  const featureTasks = input.repository
    .listBoardData(project.id)
    .tasks.filter((task) => task.featureId === input.featureId);
  const tasksNeedingIssues = featureTasks.filter(
    (task) => !task.github.issueNumber && !task.github.issueUrl,
  );

  const logs: EngineRunLogEntry[] = [
    logEntry("info", "Create GitHub issues executor started.", {
      featureId: input.featureId,
      taskCount: featureTasks.length,
    }),
  ];

  if (featureTasks.length === 0) {
    return {
      success: false,
      errorCode: "create_github_issues_no_tasks",
      error: "No feature-linked tasks were found to create GitHub issues for.",
      logs: [
        ...logs,
        logEntry("error", "Feature has no linked tasks.", {
          featureId: input.featureId,
        }),
      ],
    };
  }

  if (tasksNeedingIssues.length === 0) {
    const githubIssuesArtifact =
      findWorkflowArtifactByName(input.outputArtifacts, ["github-issues"]) ??
      input.outputArtifacts[0];

    if (!githubIssuesArtifact) {
      return {
        success: false,
        errorCode: "create_github_issues_output_missing",
        error: "Create GitHub issues requires a github-issues output artifact.",
        logs: [
          logEntry("error", "GitHub issues output artifact was not configured.", {
            featureId: input.featureId,
          }),
        ],
      };
    }

    const repositorySlug =
      normalizeGitHubRepository(project.githubRepository) || project.githubRepository;
    const resolvedArtifact = markWorkflowArtifactUntrusted(
      resolveWorkflowArtifactPlaceholders(githubIssuesArtifact, {
        repository: repositorySlug,
        feature: input.featureId,
        run: input.workflowRunId ?? "unknown",
      }),
      "GitHub issue URLs and metadata from the GitHub API are external and untrusted.",
    );

    return {
      success: true,
      outputArtifacts: [resolvedArtifact],
      result: {
        featureId: input.featureId,
        repository: repositorySlug,
        createdCount: 0,
        skippedExistingCount: featureTasks.length,
        policyBlockedCount: 0,
        failedCount: 0,
        createdIssues: [],
        issueUrls: featureTasks
          .map((task) => task.github.issueUrl)
          .filter((url): url is string => Boolean(url)),
      },
      logs: [
        ...logs,
        logEntry("info", "All feature tasks already have linked GitHub issues.", {
          skippedExistingCount: featureTasks.length,
        }),
      ],
    };
  }

  const createdIssues: Array<{
    taskId: string;
    issueNumber: number;
    issueUrl: string;
  }> = [];
  const skippedExisting = featureTasks
    .filter((task) => task.github.issueNumber || task.github.issueUrl)
    .map((task) => task.id);
  const policyBlocked: string[] = [];
  const failedTasks: Array<{ taskId: string; message: string }> = [];

  for (const task of tasksNeedingIssues) {
    const policy = evaluateTaskPolicy({
      operation: "create-github-issue",
      task,
      automated: true,
      automationSettings,
      projectPolicy: project.automationPolicy,
    });

    if (policy.kind !== "allow") {
      policyBlocked.push(task.id);
      logs.push(
        logEntry("warn", `Skipped GitHub issue creation for task "${task.title}".`, {
          taskId: task.id,
          policyCode: policy.code,
          policyKind: policy.kind,
        }),
      );
      continue;
    }

    const labels = calculateGitHubIssueLabels({ feature, task });
    let result: GitHubIssueCreateResult;

    try {
      result = await createIssue({
        repository: project.githubRepository,
        token,
        title: task.title,
        body: renderGitHubIssueBody({ project, feature, task }),
        labels,
        fetcher: input.fetcher,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "GitHub issue creation failed.";
      failedTasks.push({ taskId: task.id, message });
      logs.push(
        logEntry("error", message, {
          taskId: task.id,
        }),
      );
      continue;
    }

    if (result.status !== "created" || !result.issueNumber || !result.issueUrl) {
      failedTasks.push({ taskId: task.id, message: result.message });
      logs.push(
        logEntry("error", result.message, {
          taskId: task.id,
          status: result.status,
        }),
      );
      continue;
    }

    input.repository.linkGitHubIssue(task.id, {
      issueNumber: result.issueNumber,
      issueUrl: result.issueUrl,
      issueLabels: result.labels,
      createdAt: result.createdAt,
    });

    createdIssues.push({
      taskId: task.id,
      issueNumber: result.issueNumber,
      issueUrl: result.issueUrl,
    });

    logs.push(
      logEntry("info", `Created GitHub issue #${result.issueNumber} for task.`, {
        taskId: task.id,
        issueNumber: result.issueNumber,
        issueUrl: result.issueUrl,
      }),
    );
  }

  const pendingCount = tasksNeedingIssues.length;

  if (createdIssues.length === 0 && pendingCount > 0) {
    const errorCode =
      policyBlocked.length === pendingCount
        ? "create_github_issues_policy_blocked"
        : failedTasks.length > 0
          ? "create_github_issues_api_failed"
          : "create_github_issues_failed";

    return {
      success: false,
      errorCode,
      error:
        policyBlocked.length === pendingCount
          ? "Project automation policy blocked automatic GitHub issue creation for all pending tasks."
          : failedTasks[0]?.message ??
            "GitHub issue creation did not produce any linked issues.",
      result: {
        featureId: input.featureId,
        createdCount: createdIssues.length,
        skippedExistingCount: skippedExisting.length,
        policyBlockedCount: policyBlocked.length,
        failedCount: failedTasks.length,
        createdIssues,
        policyBlockedTaskIds: policyBlocked,
        failedTasks,
      },
      logs,
    };
  }

  const repositorySlug =
    normalizeGitHubRepository(project.githubRepository) || project.githubRepository;
  const resolvedArtifact = markWorkflowArtifactUntrusted(
    resolveWorkflowArtifactPlaceholders(githubIssuesArtifact, {
      repository: repositorySlug,
      feature: input.featureId,
      run: input.workflowRunId ?? "unknown",
    }),
    "GitHub issue URLs and metadata from the GitHub API are external and untrusted.",
  );

  return {
    success: true,
    outputArtifacts: [resolvedArtifact],
    result: {
      featureId: input.featureId,
      repository: repositorySlug,
      createdCount: createdIssues.length,
      skippedExistingCount: skippedExisting.length,
      policyBlockedCount: policyBlocked.length,
      failedCount: failedTasks.length,
      createdIssues,
      issueUrls: createdIssues.map((entry) => entry.issueUrl),
    },
    logs: [
      ...logs,
      logEntry("info", "Create GitHub issues executor completed.", {
        createdCount: createdIssues.length,
        skippedExistingCount: skippedExisting.length,
      }),
    ],
  };
};
