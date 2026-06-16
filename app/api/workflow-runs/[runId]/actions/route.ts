import {
  handleApiError,
  jsonOk,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { ValidationError } from "@/lib/db/loopboard-repository";
import {
  applyWorkflowRunAction,
  runNextWorkflowStepWithEngineTick,
  type WorkflowRunAction,
} from "@/lib/workflows/workflow-runner";

export const runtime = "nodejs";

const workflowActionHeader = "x-loopboard-workflow-action";

const workflowRunActions = new Set<WorkflowRunAction>([
  "run-next",
  "run-next-engine",
  "approve",
  "skip-disabled",
  "fail",
  "resume",
]);

const readWorkflowActionBody = async (request: Request): Promise<unknown> => {
  const text = await request.text();

  if (text.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  try {
    const { runId } = await params;
    const body = await readWorkflowActionBody(request);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ValidationError("Workflow run action payload must be an object.");
    }

    const input = body as { action?: unknown; error?: unknown };
    const actionSearchParam = new URL(request.url).searchParams.get("action");
    const requestedAction =
      typeof input.action === "string"
        ? input.action
        : request.headers.get(workflowActionHeader) ?? actionSearchParam;

    const run = await withLoopBoardRepository((repository) => {
      const currentRun = repository.getWorkflowRun(runId);
      const effectiveAction =
        typeof requestedAction === "string"
          ? requestedAction
          : currentRun.status === "running"
            ? "run-next"
            : currentRun.status === "paused"
              ? "approve"
              : undefined;

      if (
        typeof effectiveAction !== "string" ||
        !workflowRunActions.has(effectiveAction as WorkflowRunAction)
      ) {
        throw new ValidationError("Workflow run action is not supported.");
      }

      if (effectiveAction === "run-next-engine") {
        return runNextWorkflowStepWithEngineTick({ repository, runId });
      }

      return applyWorkflowRunAction({
        repository,
        runId,
        input: {
          action: effectiveAction as WorkflowRunAction,
          error: typeof input.error === "string" ? input.error : undefined,
        },
      });
    });

    return jsonOk(run);
  } catch (error) {
    return handleApiError(error);
  }
}
