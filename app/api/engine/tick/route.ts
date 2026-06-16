import {
  readEngineTickMode,
  tickEngine,
} from "@/lib/api/engine-actions";
import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { LoopSchedulerError } from "@/lib/engine/loop-scheduler";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const mode = readEngineTickMode(await readJsonBody(request));
    const result = await withLoopBoardRepository(async (repository) =>
      tickEngine(repository, mode),
    );

    if (
      mode === "automated" &&
      result.plan.action === "skip" &&
      result.plan.code === "engine_global_auto_run_required"
    ) {
      throw new LoopSchedulerError(
        result.plan.reason,
        result.plan.code,
        [result.plan.reason],
      );
    }

    return jsonOk(result);
  } catch (error) {
    return handleApiError(error);
  }
}
