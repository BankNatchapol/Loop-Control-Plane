import {
  handleApiError,
  jsonError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import {
  exportTaskEvents,
  generateTaskClaudeCodePrompt,
  getTaskContextStatus,
  readTaskHandoff,
  refreshTaskHandoff,
  saveTaskHandoff,
} from "@/lib/api/task-context-actions";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    taskId: string;
  }>;
}

interface TaskContextBody {
  action?:
    | "export-events"
    | "refresh-handoff"
    | "generate-claude-prompt"
    | "read-handoff"
    | "save-handoff";
  content?: string;
  manualIntent?: string;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { taskId } = await context.params;
    const result = withLoopBoardRepository((repository) =>
      getTaskContextStatus(repository, taskId),
    );

    return jsonOk(result);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { taskId } = await context.params;
    const input = (await readJsonBody(request)) as TaskContextBody;

    if (input.action === "export-events") {
      const result = withLoopBoardRepository((repository) =>
        exportTaskEvents(repository, taskId),
      );

      return jsonOk(result);
    }

    if (input.action === "refresh-handoff") {
      const result = withLoopBoardRepository((repository) =>
        refreshTaskHandoff(repository, taskId),
      );

      return jsonOk(result);
    }

    if (input.action === "read-handoff") {
      const result = withLoopBoardRepository((repository) =>
        readTaskHandoff(repository, taskId),
      );

      return jsonOk(result);
    }

    if (input.action === "save-handoff") {
      if (typeof input.content !== "string") {
        return jsonError("handoff.md content is required.", 400, "validation_error");
      }

      const result = withLoopBoardRepository((repository) =>
        saveTaskHandoff(repository, taskId, input.content ?? ""),
      );

      return jsonOk(result);
    }

    if (input.action === "generate-claude-prompt") {
      const result = withLoopBoardRepository((repository) =>
        generateTaskClaudeCodePrompt(
          repository,
          taskId,
          typeof input.manualIntent === "string" ? input.manualIntent : undefined,
        ),
      );

      return jsonOk(result);
    }

    return jsonError("Task context action is not supported.", 400, "validation_error");
  } catch (error) {
    return handleApiError(error);
  }
}
