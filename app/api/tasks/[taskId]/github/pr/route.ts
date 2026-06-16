import {
  handleApiError,
  jsonError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { syncExistingTaskEventsFile } from "@/lib/api/task-context-actions";
import { githubTokenFromEnv } from "@/lib/github/github-connection";
import { syncGitHubPullRequest } from "@/lib/github/github-prs";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    taskId: string;
  }>;
}

interface SyncPullRequestBody {
  pullRequestUrl?: unknown;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { taskId } = await context.params;
    const input = (await readJsonBody(request)) as SyncPullRequestBody;
    const contextData = withLoopBoardRepository((repository) => {
      const task = repository.getTask(taskId);

      return {
        task,
        project: repository.getProject(task.projectId),
      };
    });
    const explicitPullRequestUrl =
      typeof input.pullRequestUrl === "string"
        ? input.pullRequestUrl.trim()
        : undefined;
    const result = await syncGitHubPullRequest({
      repository: contextData.project.githubRepository,
      token: githubTokenFromEnv(),
      task: contextData.task,
      explicitPullRequestUrl,
    });

    if (
      result.status !== "synced" &&
      result.status !== "not-found"
    ) {
      const status =
        result.status === "disconnected" || result.status === "token-missing"
          ? 400
          : result.status === "repo-missing"
            ? 404
            : 502;

      return jsonError(result.message, status, `github_pr_${result.status}`);
    }

    const task = result.github
      ? withLoopBoardRepository((repository) =>
          repository.syncTaskGitHubPullRequest(taskId, {
            github: result.github!,
            syncedAt: result.syncedAt,
            message: result.message,
          }),
        )
      : contextData.task;
    syncExistingTaskEventsFile(task);

    return jsonOk({ task, sync: result });
  } catch (error) {
    return handleApiError(error);
  }
}
