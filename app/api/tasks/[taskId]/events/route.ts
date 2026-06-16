import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { syncExistingTaskEventsFile } from "@/lib/api/task-context-actions";
import type { AppendTaskEventInput } from "@/lib/db/loopboard-repository";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    taskId: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { taskId } = await context.params;
    const input = (await readJsonBody(request)) as AppendTaskEventInput;
    const task = withLoopBoardRepository((repository) =>
      repository.appendTaskEvent(taskId, input),
    );
    syncExistingTaskEventsFile(task);

    return jsonOk(task);
  } catch (error) {
    return handleApiError(error);
  }
}
