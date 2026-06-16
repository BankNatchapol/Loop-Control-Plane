import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { ValidationError, type CreateWorkflowInput } from "@/lib/db/loopboard-repository";
import {
  hasBlockingWorkflowIssues,
  validateWorkflowDefinition,
} from "@/lib/workflows/workflow-editor";

export const runtime = "nodejs";

const buildCreateWorkflowInput = (
  projectId: string,
  body: unknown,
): CreateWorkflowInput => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Workflow payload must be an object.");
  }

  const input = body as Partial<CreateWorkflowInput>;
  const candidate = {
    ...input,
    projectId,
    nodes: input.nodes ?? [],
    edges: input.edges ?? [],
  } as CreateWorkflowInput;
  const issues = validateWorkflowDefinition({
    nodes: candidate.nodes ?? [],
    edges: candidate.edges ?? [],
  });

  if (hasBlockingWorkflowIssues(issues)) {
    throw new ValidationError(
      `Workflow validation failed: ${issues.map((issue) => issue.message).join(" ")}`,
    );
  }

  return candidate;
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await params;
    const workflows = withLoopBoardRepository((repository) =>
      repository.listWorkflows(projectId),
    );

    return jsonOk(workflows);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await params;
    const input = buildCreateWorkflowInput(projectId, await readJsonBody(request));
    const workflow = withLoopBoardRepository((repository) =>
      repository.createWorkflow(input),
    );

    return jsonOk(workflow, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
