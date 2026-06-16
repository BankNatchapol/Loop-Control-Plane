import {
  handleApiError,
  jsonOk,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { setupGitHubLabels } from "@/lib/github/github-connection";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await params;
    const project = withLoopBoardRepository((repository) =>
      repository.getProject(projectId),
    );
    const result = await setupGitHubLabels({
      repository: project.githubRepository,
    });

    return jsonOk(result);
  } catch (error) {
    return handleApiError(error);
  }
}
