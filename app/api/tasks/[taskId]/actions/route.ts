import {
  handleApiError,
  jsonError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import {
  appendTaskHandoffNote,
  refreshTaskHandoff,
  syncExistingTaskEventsFile,
} from "@/lib/api/task-context-actions";
import type { TaskAction } from "@/lib/loopboard";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    taskId: string;
  }>;
}

interface TaskActionBody {
  action?: TaskAction;
  handoffNote?: string;
}

const taskActions = new Set<TaskAction>([
  "assign-ai",
  "approve-ao-ready",
  "mark-ao-ready",
  "remove-ao-ready",
  "claim-human",
  "pause-ai",
  "return-ai",
  "mark-blocked",
  "mark-done",
]);

export async function POST(request: Request, context: RouteContext) {
  try {
    const { taskId } = await context.params;
    const input = (await readJsonBody(request)) as TaskActionBody;

    if (!input.action || !taskActions.has(input.action)) {
      return jsonError("Task action is not supported.", 400, "validation_error");
    }

    const task = withLoopBoardRepository((repository) =>
      repository.applyTaskAction(taskId, input.action as TaskAction),
    );
    if (input.action === "claim-human") {
      withLoopBoardRepository((repository) =>
        refreshTaskHandoff(repository, taskId),
      );
    }
    if (input.action === "return-ai") {
      withLoopBoardRepository((repository) =>
        appendTaskHandoffNote(
          repository,
          taskId,
          typeof input.handoffNote === "string" ? input.handoffNote : undefined,
        ),
      );
    }
    syncExistingTaskEventsFile(task);

    return jsonOk(task);
  } catch (error) {
    return handleApiError(error);
  }
}
