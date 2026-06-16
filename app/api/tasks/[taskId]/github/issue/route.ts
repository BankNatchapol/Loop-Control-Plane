import {
  handleApiError,
  jsonError,
  jsonOk,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { syncExistingTaskEventsFile } from "@/lib/api/task-context-actions";
import { githubTokenFromEnv } from "@/lib/github/github-connection";
import {
  calculateGitHubIssueLabels,
  createGitHubIssue,
  renderGitHubIssueBody,
} from "@/lib/github/github-issues";
import { evaluateTaskPolicy } from "@/lib/policies/automation-policy";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    taskId: string;
  }>;
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { taskId } = await context.params;
    const contextData = withLoopBoardRepository((repository) => {
      const task = repository.getTask(taskId);
      const project = repository.getProject(task.projectId);
      const automationSettings = repository.getAutomationSettings();

      if (task.github.issueNumber || task.github.issueUrl) {
        return {
          duplicateTask: task,
          task,
          feature: repository.getFeature(task.featureId),
          project,
          automationSettings,
        };
      }

      return {
        duplicateTask: null,
        task,
        feature: repository.getFeature(task.featureId),
        project,
        automationSettings,
      };
    });

    if (contextData.duplicateTask) {
      return jsonError(
        "This task already has a linked GitHub issue.",
        409,
        "github_issue_exists",
      );
    }

    const policy = evaluateTaskPolicy({
      operation: "create-github-issue",
      task: contextData.task,
      automationSettings: contextData.automationSettings,
      projectPolicy: contextData.project.automationPolicy,
    });

    if (policy.kind === "deny") {
      return jsonError(policy.message, 400, policy.code);
    }

    const labels = calculateGitHubIssueLabels(contextData);
    const result = await createGitHubIssue({
      repository: contextData.project.githubRepository,
      token: githubTokenFromEnv(),
      title: contextData.task.title,
      body: renderGitHubIssueBody(contextData),
      labels,
    });

    if (result.status !== "created" || !result.issueNumber || !result.issueUrl) {
      const status =
        result.status === "disconnected" || result.status === "token-missing"
          ? 400
          : result.status === "repo-missing"
            ? 404
            : 502;

      return jsonError(result.message, status, `github_issue_${result.status}`);
    }

    const task = withLoopBoardRepository((repository) =>
      repository.linkGitHubIssue(taskId, {
        issueNumber: result.issueNumber!,
        issueUrl: result.issueUrl!,
        issueLabels: result.labels,
        createdAt: result.createdAt,
      }),
    );
    syncExistingTaskEventsFile(task);

    return jsonOk({ task, issue: result, policy });
  } catch (error) {
    return handleApiError(error);
  }
}
