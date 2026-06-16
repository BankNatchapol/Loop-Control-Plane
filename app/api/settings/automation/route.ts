import {
  handleApiError,
  jsonOk,
  readJsonBody,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { ValidationError } from "@/lib/db/loopboard-repository";
import type { AutomationSettings } from "@/lib/policies/automation-policy";

export const runtime = "nodejs";

const buildAutomationSettingsInput = (
  body: unknown,
): Partial<AutomationSettings> => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Automation settings payload must be an object.");
  }

  const input = body as Partial<Record<keyof AutomationSettings, unknown>>;
  const settings: Partial<AutomationSettings> = {};

  if (input.globalAutoRunEnabled !== undefined) {
    if (typeof input.globalAutoRunEnabled !== "boolean") {
      throw new ValidationError("globalAutoRunEnabled must be a boolean.");
    }

    settings.globalAutoRunEnabled = input.globalAutoRunEnabled;
  }

  return settings;
};

export async function GET() {
  try {
    const settings = await withLoopBoardRepository((repository) =>
      repository.getAutomationSettings(),
    );

    return jsonOk(settings);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const input = buildAutomationSettingsInput(await readJsonBody(request));
    const settings = await withLoopBoardRepository((repository) =>
      repository.updateAutomationSettings(input),
    );

    return jsonOk(settings);
  } catch (error) {
    return handleApiError(error);
  }
}
