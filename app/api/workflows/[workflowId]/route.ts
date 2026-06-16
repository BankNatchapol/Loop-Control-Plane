import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { ValidationError, type UpdateWorkflowInput } from "@/lib/db/loopboard-repository";
import {
  hasBlockingWorkflowIssues,
  validateWorkflowDefinition,
} from "@/lib/workflows/workflow-editor";

export const runtime = "nodejs";

const buildUpdateWorkflowInput = (body: unknown): UpdateWorkflowInput => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Workflow payload must be an object.");
  }

  const input = body as UpdateWorkflowInput;

  if (input.nodes !== undefined || input.edges !== undefined) {
    const issues = validateWorkflowDefinition({
      nodes: input.nodes ?? [],
      edges: input.edges ?? [],
    });

    if (hasBlockingWorkflowIssues(issues)) {
      throw new ValidationError(
        `Workflow validation failed: ${issues.map((issue) => issue.message).join(" ")}`,
      );
    }
  }

  return input;
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workflowId: string }> },
) {
  try {
    const { workflowId } = await params;
    const workflow = await withLoopBoardRepository((repository) =>
      repository.getWorkflow(workflowId),
    );

    return jsonOk(workflow);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ workflowId: string }> },
) {
  try {
    const { workflowId } = await params;
    const input = buildUpdateWorkflowInput(await readJsonBody(request));
    const workflow = await withLoopBoardRepository((repository) =>
      repository.updateWorkflow(workflowId, input),
    );

    return jsonOk(workflow);
  } catch (error) {
    return handleApiError(error);
  }
}
