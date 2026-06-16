import { getBackendAvailability } from "@/lib/api/backend-availability-actions";
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
    const availability = await withLoopBoardRepository((repository) =>
      getBackendAvailability(repository, { projectId }),
    );

    return jsonOk(availability);
  } catch (error) {
    return handleApiError(error);
  }
}
