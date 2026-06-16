import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { openProjectPath, type ProjectOpenAction } from "@/lib/projects/project-open-actions";

export const runtime = "nodejs";

const readAction = (body: unknown): ProjectOpenAction => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "open-folder";
  }

  const action = (body as { action?: unknown }).action;

  return action === "open-vscode" ? "open-vscode" : "open-folder";
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await params;
    const action = readAction(await readJsonBody(request));
    const result = withLoopBoardRepository((repository) => {
      const project = repository.getProject(projectId);

      return openProjectPath(project, action);
    });

    return jsonOk(result);
  } catch (error) {
    return handleApiError(error);
  }
}
