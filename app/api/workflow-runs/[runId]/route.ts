import {
  handleApiError,
  jsonOk,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    runId: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { runId } = await context.params;
    const run = await withLoopBoardRepository((repository) =>
      repository.getWorkflowRun(runId),
    );

    return jsonOk(run);
  } catch (error) {
    return handleApiError(error);
  }
}
