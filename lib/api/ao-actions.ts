import type {
  AoBridgeHealth,
  AoDashboardSession,
  AoOrchestratorLink,
  AoReviewFinding,
  AoReviewRun,
  AoRuntimeTerminalConfig,
  AoSessionsResponse,
} from "@/lib/ao-bridge/types";

type ApiSuccess<T> = { ok: true; data: T };
type ApiFailure = { ok: false; error: { code: string; message: string } };

const parseResponse = async <T>(response: Response): Promise<T> => {
  const payload = (await response.json()) as ApiSuccess<T> | ApiFailure;
  if (!response.ok || !payload.ok) {
    const message =
      !payload.ok && payload.error?.message
        ? payload.error.message
        : `Request failed (${response.status}).`;
    throw new Error(message);
  }

  return payload.data;
};

export const fetchAoBridgeHealth = async (): Promise<AoBridgeHealth> =>
  parseResponse(await fetch("/api/ao/health", { cache: "no-store" }));

export const fetchAoBridgeSessions = async (input?: {
  projectId?: string;
  active?: boolean;
}): Promise<AoSessionsResponse> => {
  const params = new URLSearchParams();
  if (input?.projectId) {
    params.set("projectId", input.projectId);
  }
  if (input?.active) {
    params.set("active", "true");
  }

  const query = params.toString();
  return parseResponse(
    await fetch(`/api/ao/sessions${query ? `?${query}` : ""}`, { cache: "no-store" }),
  );
};

export const fetchAoBridgeSession = async (sessionId: string): Promise<AoDashboardSession> =>
  parseResponse(await fetch(`/api/ao/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store" }));

export const fetchAoBridgeOrchestrators = async (): Promise<AoOrchestratorLink[]> => {
  try {
    const payload = await parseResponse<{ orchestrators: AoOrchestratorLink[] }>(
      await fetch("/api/ao/orchestrators", { cache: "no-store" }),
    );
    return payload.orchestrators;
  } catch {
    const sessions = await fetchAoBridgeSessions();
    return sessions.orchestrators ?? [];
  }
};

export const fetchAoBridgeReviews = async (projectId?: string): Promise<AoReviewRun[]> => {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const payload = await parseResponse<{ reviews: AoReviewRun[] }>(
    await fetch(`/api/ao/reviews${query}`, { cache: "no-store" }),
  );
  return payload.reviews;
};

export const fetchAoBridgeReviewFindings = async (
  reviewId: string,
): Promise<AoReviewFinding[]> => {
  const payload = await parseResponse<{ findings: AoReviewFinding[] }>(
    await fetch(`/api/ao/reviews/${encodeURIComponent(reviewId)}/findings`, {
      cache: "no-store",
    }),
  );
  return payload.findings;
};

export const fetchAoBridgeTerminalConfig = async (): Promise<AoRuntimeTerminalConfig> =>
  parseResponse(await fetch("/api/ao/runtime/terminal", { cache: "no-store" }));

export const killAoBridgeSession = async (sessionId: string): Promise<void> => {
  await parseResponse(
    await fetch(`/api/ao/sessions/${encodeURIComponent(sessionId)}/kill`, {
      method: "POST",
    }),
  );
};

export const syncAoBridgeRuntime = async (projectId?: string): Promise<{
  projects: number;
  updatedTasks: number;
  sessions: number;
}> =>
  parseResponse(
    await fetch("/api/ao/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    }),
  );
