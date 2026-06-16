import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { ValidationError } from "@/lib/db/loopboard-repository";
import type { FeatureApprovalArtifactName } from "@/lib/loopboard";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    featureId: string;
  }>;
}

const readApprovalArtifactName = (body: unknown): FeatureApprovalArtifactName => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Feature approval payload must be an object.");
  }

  const artifactName = (body as { artifactName?: unknown }).artifactName;
  if (
    artifactName !== "spec" &&
    artifactName !== "plan" &&
    artifactName !== "tasks"
  ) {
    throw new ValidationError("artifactName is not a supported approval artifact.");
  }

  return artifactName;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const { featureId } = await context.params;
    const body = await readJsonBody(request);
    const artifactName = readApprovalArtifactName(body);
    const feature = withLoopBoardRepository((repository) =>
      repository.approveFeatureArtifact(featureId, {
        artifactName,
        actor: "human",
      }),
    );

    return jsonOk(feature);
  } catch (error) {
    return handleApiError(error);
  }
}
