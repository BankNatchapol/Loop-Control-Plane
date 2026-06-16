import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { ValidationError } from "@/lib/db/loopboard-repository";
import { importRepositoryWorkflowFile } from "@/lib/workflows/workflow-files";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await params;
    const body = await readJsonBody(request);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ValidationError("Workflow import payload must be an object.");
    }

    const input = body as { path?: unknown; overwriteWorkflowId?: unknown };
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      throw new ValidationError("Workflow import path is required.");
    }
    const path = input.path;

    const result = withLoopBoardRepository((repository) =>
      importRepositoryWorkflowFile({
        repository,
        projectId,
        path,
        overwriteWorkflowId:
          typeof input.overwriteWorkflowId === "string"
            ? input.overwriteWorkflowId
            : undefined,
      }),
    );

    return jsonOk(result, { status: result.status === "imported" ? 201 : 200 });
  } catch (error) {
    return handleApiError(error);
  }
}
