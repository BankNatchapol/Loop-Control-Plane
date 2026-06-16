import {
  enqueueDemoPingJob,
  readEngineProjectId,
} from "@/lib/api/engine-actions";
import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const projectId = readEngineProjectId(await readJsonBody(request));
    const result = withLoopBoardRepository((repository) =>
      enqueueDemoPingJob(repository, projectId),
    );

    return jsonOk(result);
  } catch (error) {
    return handleApiError(error);
  }
}
