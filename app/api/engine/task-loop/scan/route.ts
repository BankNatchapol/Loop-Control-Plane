import {
  readTaskLoopScanInput,
  scanTaskLoop,
} from "@/lib/api/task-loop-actions";
import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = readTaskLoopScanInput(await readJsonBody(request));
    const result = await withLoopBoardRepository((repository) =>
      scanTaskLoop(repository, input),
    );

    return jsonOk(result);
  } catch (error) {
    return handleApiError(error);
  }
}
