import {
  handleApiError,
  jsonOk,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { checkGitHubConnection } from "@/lib/github/github-connection";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await params;
    const project = withLoopBoardRepository((repository) =>
      repository.getProject(projectId),
    );
    const result = await checkGitHubConnection({
      repository: project.githubRepository,
    });

    return jsonOk(result);
  } catch (error) {
    return handleApiError(error);
  }
}
