import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { syncExistingTaskEventsFile } from "@/lib/api/task-context-actions";
import type { CreateTaskInput } from "@/lib/db/loopboard-repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = (await readJsonBody(request)) as CreateTaskInput;
    const task = await withLoopBoardRepository((repository) =>
      repository.createTask(input),
    );
    syncExistingTaskEventsFile(task);

    return jsonOk(task, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
