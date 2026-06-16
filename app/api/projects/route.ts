import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { ValidationError, type CreateProjectInput } from "@/lib/db/loopboard-repository";
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

const buildProjectInput = (body: unknown): CreateProjectInput => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Project payload must be an object.");
  }

  const input = body as Partial<CreateProjectInput>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const repoPath = typeof input.repoPath === "string" ? input.repoPath : "";
  const health = inspectRepositoryHealth(repoPath);

  if (!name) {
    throw new ValidationError("name must be a non-empty string.");
  }

  if (!health.pathExists) {
    throw new ValidationError(`repoPath does not exist: ${health.repoPath}`);
  }

  if (!health.isDirectory) {
    throw new ValidationError(`repoPath must be a directory: ${health.repoPath}`);
  }

  const repository =
    input.repository || repositoryNameFromRemote(health.githubRemoteUrl);
  const githubRepository =
    normalizeGitHubRepository(input.githubRepository ?? "") ||
    health.githubRepository ||
    parseGitHubRepository(health.githubRemoteUrl);

  if (input.githubRepository && !githubRepository) {
    throw new ValidationError("githubRepository must use owner/name format.");
  }

  return {
    ...input,
    name,
    repoPath: health.repoPath,
    repository,
    isGitRepository: health.isGitRepository,
    currentBranch: health.currentBranch,
    defaultBranch: health.defaultBranch || input.defaultBranch || "",
    githubRemoteUrl: health.githubRemoteUrl,
    githubRepository,
  };
};

export function GET() {
  try {
    const projects = withLoopBoardRepository((repository) =>
      repository.listProjects(),
    );

    return jsonOk(projects);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = buildProjectInput(await readJsonBody(request));
    const project = withLoopBoardRepository((repository) =>
      repository.createProject(input),
    );

    return jsonOk(project, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
