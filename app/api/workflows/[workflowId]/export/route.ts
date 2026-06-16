import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { exportRepositoryWorkflowFile } from "@/lib/workflows/workflow-files";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workflowId: string }> },
) {
  try {
    const { workflowId } = await params;
    const body = await readJsonBody(request);
    const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const result = await withLoopBoardRepository((repository) =>
      exportRepositoryWorkflowFile({
        repository,
        workflowId,
        fileName:
          typeof (input as { fileName?: unknown }).fileName === "string"
            ? (input as { fileName: string }).fileName
            : undefined,
        overwrite: Boolean((input as { overwrite?: unknown }).overwrite),
      }),
    );

    return jsonOk(result);
  } catch (error) {
    return handleApiError(error);
  }
}
