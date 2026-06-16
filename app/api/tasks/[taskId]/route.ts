import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { syncExistingTaskEventsFile } from "@/lib/api/task-context-actions";
import type { UpdateTaskInput } from "@/lib/db/loopboard-repository";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    taskId: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { taskId } = await context.params;
    const task = await withLoopBoardRepository((repository) =>
      repository.getTask(taskId),
    );

    return jsonOk(task);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { taskId } = await context.params;
    const input = (await readJsonBody(request)) as UpdateTaskInput;
    const task = await withLoopBoardRepository((repository) =>
      repository.updateTask(taskId, input),
    );
    syncExistingTaskEventsFile(task);

    return jsonOk(task);
  } catch (error) {
    return handleApiError(error);
  }
}
