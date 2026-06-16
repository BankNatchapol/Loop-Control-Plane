import {
  handleApiError,
  jsonError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { syncExistingTaskEventsFile } from "@/lib/api/task-context-actions";
import { githubTokenFromEnv } from "@/lib/github/github-connection";
import {
  calculateGitHubIssueLabels,
  syncGitHubIssueLabels,
} from "@/lib/github/github-issues";
import { evaluateTaskPolicy } from "@/lib/policies/automation-policy";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    taskId: string;
  }>;
}

interface SyncLabelsBody {
  labels?: unknown;
}

const parseLabels = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;

export async function POST(request: Request, context: RouteContext) {
  try {
    const { taskId } = await context.params;
    const input = (await readJsonBody(request)) as SyncLabelsBody;
    const contextData = withLoopBoardRepository((repository) => {
      const task = repository.getTask(taskId);
      const project = repository.getProject(task.projectId);

      return {
        task,
        feature: repository.getFeature(task.featureId),
        project,
        automationSettings: repository.getAutomationSettings(),
      };
    });
    const requestedLabels = parseLabels(input.labels);

    if (
      !contextData.task.github.issueNumber ||
      !contextData.task.github.issueUrl
    ) {
      return jsonError(
        "Create or link a GitHub issue before syncing labels.",
        400,
        "github_issue_missing",
      );
    }

    const labels =
      requestedLabels ??
      calculateGitHubIssueLabels({
        feature: contextData.feature,
        task: contextData.task,
      });

    const policy = evaluateTaskPolicy({
      operation: "mark-ao-ready",
      task: contextData.task,
      approved: Boolean(contextData.task.github.aoReadyApprovedAt),
      automationSettings: contextData.automationSettings,
      projectPolicy: contextData.project.automationPolicy,
    });

    if (labels.includes("ao-ready") && policy.kind !== "allow") {
      return jsonError(
        policy.message,
        400,
        policy.code,
      );
    }

    const result = await syncGitHubIssueLabels({
      repository: contextData.project.githubRepository,
      token: githubTokenFromEnv(),
      issueNumber: contextData.task.github.issueNumber,
      labels,
    });

    if (result.status !== "synced") {
      const status =
        result.status === "disconnected" ||
        result.status === "token-missing" ||
        result.status === "issue-missing"
          ? 400
          : result.status === "repo-missing"
            ? 404
            : 502;

      return jsonError(result.message, status, `github_labels_${result.status}`);
    }

    const task = withLoopBoardRepository((repository) =>
      repository.syncTaskGitHubIssueLabels(taskId, {
        issueLabels: result.labels,
        syncedAt: result.syncedAt,
        message: result.message,
      }),
    );
    syncExistingTaskEventsFile(task);

    return jsonOk({ task, sync: result, policy });
  } catch (error) {
    return handleApiError(error);
  }
}
