import {
  handleApiError,
  jsonOk,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { refreshBoardFeatureArtifacts } from "@/lib/features/feature-artifacts";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const board = await withLoopBoardRepository((repository) =>
      refreshBoardFeatureArtifacts(repository.listBoardData(projectId)),
    );

    return jsonOk(board);
  } catch (error) {
    return handleApiError(error);
  }
}
