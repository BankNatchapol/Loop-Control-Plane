import { cancelEngineJobForApi } from "@/lib/api/engine-actions";
import {
  handleApiError,
  jsonOk,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    jobId: string;
  }>;
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { jobId } = await context.params;
    const result = await withLoopBoardRepository((repository) =>
      cancelEngineJobForApi(repository, jobId),
    );

    return jsonOk(result);
  } catch (error) {
    return handleApiError(error);
  }
}
