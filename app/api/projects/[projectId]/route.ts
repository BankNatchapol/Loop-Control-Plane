import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { ValidationError, type UpdateProjectInput } from "@/lib/db/loopboard-repository";
import {
  inspectRepositoryHealth,
  normalizeGitHubRepository,
  parseGitHubRepository,
} from "@/lib/projects/project-repository-health";

export const runtime = "nodejs";

const repositoryNameFromRemote = (githubRemoteUrl: string): string => {
  if (!githubRemoteUrl) {
    return "";
  }

  try {
    const url = new URL(githubRemoteUrl);
    return url.hostname === "github.com"
      ? url.pathname.replace(/^\/+/u, "")
      : githubRemoteUrl;
  } catch {
    return githubRemoteUrl;
  }
};

const buildProjectUpdate = (body: unknown): UpdateProjectInput => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Project payload must be an object.");
  }

  const input = body as Partial<UpdateProjectInput>;
  const requestedGitHubRepository =
    typeof input.githubRepository === "string"
      ? normalizeGitHubRepository(input.githubRepository)
      : undefined;

  if (typeof input.githubRepository === "string" && input.githubRepository && !requestedGitHubRepository) {
    throw new ValidationError("githubRepository must use owner/name format.");
  }

  if (typeof input.repoPath !== "string") {
    return {
      ...input,
      githubRepository: requestedGitHubRepository,
    };
  }

  const health = inspectRepositoryHealth(input.repoPath);

  if (!health.pathExists) {
    throw new ValidationError(`repoPath does not exist: ${health.repoPath}`);
  }

  if (!health.isDirectory) {
    throw new ValidationError(`repoPath must be a directory: ${health.repoPath}`);
  }

  return {
    ...input,
    repoPath: health.repoPath,
    repository:
      input.repository || repositoryNameFromRemote(health.githubRemoteUrl),
    isGitRepository: health.isGitRepository,
    currentBranch: health.currentBranch,
    defaultBranch: health.defaultBranch || input.defaultBranch || "",
    githubRemoteUrl: health.githubRemoteUrl,
    githubRepository:
      requestedGitHubRepository ||
      health.githubRepository ||
      parseGitHubRepository(health.githubRemoteUrl),
  };
};

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await params;
    const input = buildProjectUpdate(await readJsonBody(request));
    const project = await withLoopBoardRepository((repository) =>
      repository.updateProject(projectId, input),
    );

    return jsonOk(project);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await params;
    await withLoopBoardRepository((repository) => repository.deleteProject(projectId));

    return jsonOk({ projectId });
  } catch (error) {
    return handleApiError(error);
  }
}
