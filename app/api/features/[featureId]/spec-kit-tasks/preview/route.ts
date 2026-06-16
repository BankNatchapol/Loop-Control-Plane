import {
  handleApiError,
  jsonOk,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { SpecKitTaskImporter } from "@/lib/importers/spec-kit-task-importer";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    featureId: string;
  }>;
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { featureId } = await context.params;
    const preview = withLoopBoardRepository((repository) =>
      new SpecKitTaskImporter(repository).previewFeature(featureId),
    );

    return jsonOk(preview);
  } catch (error) {
    return handleApiError(error);
  }
}
