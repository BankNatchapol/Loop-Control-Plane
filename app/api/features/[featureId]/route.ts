import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { type UpdateFeatureInput, ValidationError } from "@/lib/db/loopboard-repository";
import {
  discoverFeatureArtifacts,
  refreshFeatureArtifactStatus,
} from "@/lib/features/feature-artifacts";
import type { FeatureStatus, Project } from "@/lib/loopboard";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    featureId: string;
  }>;
}

const buildFeatureUpdate = (
  body: unknown,
  current: { projectId: string; artifactFolderPath: string; status: FeatureStatus },
  getProject: (projectId: string) => Project,
): UpdateFeatureInput => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Feature payload must be an object.");
  }

  const input = body as Partial<UpdateFeatureInput>;
  const status = input.status ?? current.status;
  const artifactFolderPath =
    input.artifactFolderPath === undefined
      ? current.artifactFolderPath
      : input.artifactFolderPath;

  return {
    ...input,
    ...discoverFeatureArtifacts({
      project: getProject(current.projectId),
      artifactFolderPath,
      status,
    }),
    status,
  };
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { featureId } = await context.params;
    const feature = await withLoopBoardRepository((repository) => {
      const persistedFeature = repository.getFeature(featureId);
      const project = repository.getProject(persistedFeature.projectId);

      return refreshFeatureArtifactStatus(project, persistedFeature);
    });

    return jsonOk(feature);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { featureId } = await context.params;
    const body = await readJsonBody(request);
    const feature = await withLoopBoardRepository((repository) => {
      const current = repository.getFeature(featureId);
      const input = buildFeatureUpdate(body, current, (projectId) =>
        repository.getProject(projectId),
      );

      return repository.updateFeature(featureId, input);
    });

    return jsonOk(feature);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { featureId } = await context.params;
    await withLoopBoardRepository((repository) => repository.deleteFeature(featureId));

    return jsonOk({ featureId });
  } catch (error) {
    return handleApiError(error);
  }
}
