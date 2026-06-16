import {
  getEngineStatus,
} from "@/lib/api/engine-actions";
import {
  handleApiError,
  jsonOk,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const status = await withLoopBoardRepository((repository) =>
      getEngineStatus(repository, { projectId }),
    );

    return jsonOk(status);
  } catch (error) {
    return handleApiError(error);
  }
}
