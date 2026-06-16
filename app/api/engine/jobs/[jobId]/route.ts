import { getEngineJobDetail } from "@/lib/api/engine-actions";
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

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { jobId } = await context.params;
    const job = await withLoopBoardRepository((repository) =>
      getEngineJobDetail(repository, jobId),
    );

    return jsonOk(job);
  } catch (error) {
    return handleApiError(error);
  }
}
