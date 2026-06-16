import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { openTaskPath, type TaskOpenAction } from "@/lib/tasks/task-open-actions";

export const runtime = "nodejs";

const readAction = (body: unknown): TaskOpenAction => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "open-worktree-vscode";
  }

  const action = (body as { action?: unknown }).action;

  return action === "open-repo-vscode"
    ? "open-repo-vscode"
    : "open-worktree-vscode";
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    const { taskId } = await params;
    const action = readAction(await readJsonBody(request));
    const result = withLoopBoardRepository((repository) => {
      const task = repository.getTask(taskId);
      const project = repository.getProject(task.projectId);

      return openTaskPath(project, task, action);
    });

    return jsonOk(result);
  } catch (error) {
    return handleApiError(error);
  }
}
