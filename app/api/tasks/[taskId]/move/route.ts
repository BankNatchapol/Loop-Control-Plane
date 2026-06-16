import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { syncExistingTaskEventsFile } from "@/lib/api/task-context-actions";
import type { KanbanStatus, TaskEvent } from "@/lib/loopboard";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    taskId: string;
  }>;
}

interface MoveTaskBody {
  toStatus?: KanbanStatus;
  actor?: TaskEvent["actor"];
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { taskId } = await context.params;
    const input = (await readJsonBody(request)) as MoveTaskBody;
    const task = withLoopBoardRepository((repository) =>
      repository.moveTask(taskId, input.toStatus as KanbanStatus, input.actor),
    );
    syncExistingTaskEventsFile(task);

    return jsonOk(task);
  } catch (error) {
    return handleApiError(error);
  }
}
