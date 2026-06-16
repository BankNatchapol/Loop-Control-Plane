import { resumeWorkflowRunFromEngineForApi } from "@/lib/api/engine-actions";
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

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { runId } = await context.params;
    const result = await withLoopBoardRepository((repository) =>
      resumeWorkflowRunFromEngineForApi(repository, runId),
    );

    return jsonOk(result);
  } catch (error) {
    return handleApiError(error);
  }
}
