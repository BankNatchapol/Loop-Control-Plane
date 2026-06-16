import {
  listEngineJobsForApi,
  parseEngineJobListQuery,
} from "@/lib/api/engine-actions";
import {
  handleApiError,
  jsonOk,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const filters = parseEngineJobListQuery(new URL(request.url));
    const result = await withLoopBoardRepository((repository) =>
      listEngineJobsForApi(repository, filters),
    );

    return jsonOk(result);
  } catch (error) {
    return handleApiError(error);
  }
}
