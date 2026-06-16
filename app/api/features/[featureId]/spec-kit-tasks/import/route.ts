import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import {
  SpecKitTaskImporter,
  type SpecKitImportInput,
} from "@/lib/importers/spec-kit-task-importer";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    featureId: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { featureId } = await context.params;
    const body = (await readJsonBody(request)) as SpecKitImportInput;
    const result = await withLoopBoardRepository((repository) =>
      new SpecKitTaskImporter(repository).importFeature(featureId, body),
    );

    return jsonOk(result, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
