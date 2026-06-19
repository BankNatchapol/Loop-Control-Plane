import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { ValidationError } from "@/lib/db/loopboard-repository";
import { updateAoYamlAgentModel } from "@/lib/engine/backends/ao-yaml-config";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await params;
    const body = await readJsonBody(request);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ValidationError("Request body must be an object.");
    }

    const { model } = body as { model?: unknown };
    if (typeof model !== "string" || model.trim().length === 0) {
      throw new ValidationError("model must be a non-empty string.");
    }

    const project = await withLoopBoardRepository((repository) =>
      repository.getProject(projectId),
    );

    if (!project.repoPath) {
      throw new ValidationError("Project has no repoPath configured.");
    }

    updateAoYamlAgentModel(project.repoPath, model.trim());

    return jsonOk({ projectId, model: model.trim() });
  } catch (error) {
    return handleApiError(error);
  }
}
