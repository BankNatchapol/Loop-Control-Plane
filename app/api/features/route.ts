import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { ValidationError, type CreateFeatureInput } from "@/lib/db/loopboard-repository";
import {
  discoverFeatureArtifacts,
  refreshBoardFeatureArtifacts,
} from "@/lib/features/feature-artifacts";
import type { Project } from "@/lib/loopboard";

export const runtime = "nodejs";

const buildFeatureInput = (
  body: unknown,
  getProject: (projectId: string) => Project,
): CreateFeatureInput => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Feature payload must be an object.");
  }

  const input = body as Partial<CreateFeatureInput>;
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";

  if (!projectId) {
    throw new ValidationError("projectId must be a non-empty string.");
  }

  if (!name) {
    throw new ValidationError("name must be a non-empty string.");
  }

  const status = input.status ?? "prd-draft";
  const discovered = discoverFeatureArtifacts({
    project: getProject(projectId),
    artifactFolderPath: input.artifactFolderPath,
    status,
  });

  return {
    ...input,
    ...discovered,
    projectId,
    name,
    status,
  };
};

export function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const features = withLoopBoardRepository((repository) => {
      const projects = projectId ? [repository.getProject(projectId)] : repository.listProjects();

      return refreshBoardFeatureArtifacts({
        projects,
        features: repository.listFeatures(projectId),
      }).features;
    });

    return jsonOk(features);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request);
    const feature = withLoopBoardRepository((repository) => {
      const input = buildFeatureInput(body, (projectId) =>
        repository.getProject(projectId),
      );

      return repository.createFeature(input);
    });

    return jsonOk(feature, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
