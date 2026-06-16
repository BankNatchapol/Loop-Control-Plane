import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { ValidationError } from "@/lib/db/loopboard-repository";
import {
  assertFeatureArtifactName,
  readRepositoryFeatureArtifactDocument,
  writeRepositoryFeatureArtifactDocument,
} from "@/lib/features/feature-artifact-documents";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    featureId: string;
    artifactName: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { featureId, artifactName } = await context.params;
    const document = withLoopBoardRepository((repository) =>
      readRepositoryFeatureArtifactDocument(
        repository,
        featureId,
        assertFeatureArtifactName(artifactName),
      ),
    );

    return jsonOk(document);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const { featureId, artifactName } = await context.params;
    const body = await readJsonBody(request);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ValidationError("Artifact payload must be an object.");
    }

    const content = (body as { content?: unknown }).content;
    if (typeof content !== "string") {
      throw new ValidationError("Artifact content must be a string.");
    }

    const document = withLoopBoardRepository((repository) =>
      writeRepositoryFeatureArtifactDocument(
        repository,
        featureId,
        assertFeatureArtifactName(artifactName),
        content,
      ),
    );

    return jsonOk(document);
  } catch (error) {
    return handleApiError(error);
  }
}
