import { stopEngineScheduler } from "@/lib/api/engine-actions";
import {
  handleApiError,
  jsonOk,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";

export const runtime = "nodejs";

export async function POST() {
  try {
    const result = await withLoopBoardRepository((repository) =>
      stopEngineScheduler(repository),
    );

    return jsonOk(result);
  } catch (error) {
    return handleApiError(error);
  }
}
