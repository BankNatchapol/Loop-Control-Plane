import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { ValidationError } from "@/lib/db/loopboard-repository";
import { startWorkflowRun } from "@/lib/workflows/workflow-runner";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workflowId: string }> },
) {
  try {
    const { workflowId } = await params;
    const body = await readJsonBody(request);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ValidationError("Workflow run payload must be an object.");
    }

    const input = body as { featureId?: unknown; inputArtifacts?: unknown };
    const run = withLoopBoardRepository((repository) =>
      startWorkflowRun({
        repository,
        input: {
          workflowId,
          featureId:
            typeof input.featureId === "string" ? input.featureId : undefined,
          inputArtifacts: Array.isArray(input.inputArtifacts)
            ? input.inputArtifacts
            : undefined,
        },
      }),
    );

    return jsonOk(run, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
