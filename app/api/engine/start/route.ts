import { startEngineScheduler } from "@/lib/api/engine-actions";
import {
  handleApiError,
  jsonOk,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";

export const runtime = "nodejs";

export function POST() {
  try {
    const result = withLoopBoardRepository((repository) =>
      startEngineScheduler(repository),
    );

    return jsonOk(result);
  } catch (error) {
    return handleApiError(error);
  }
}
