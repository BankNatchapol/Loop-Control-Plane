import { resolveAoBridgeConfig } from "@/lib/ao-bridge/ao-config";
import type {
  AoBridgeHealth,
  AoDashboardSession,
  AoOrchestratorLink,
  AoReviewFinding,
  AoReviewRun,
  AoRuntimeTerminalConfig,
  AoSessionsResponse,
} from "@/lib/ao-bridge/types";

export class AoBridgeError extends Error {
  constructor(
    message: string,
    readonly code = "ao_bridge_failed",
    readonly statusCode = 502,
  ) {
    super(message);
  }
}

const parseJson = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  if (!text.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AoBridgeError("Agent Orchestrator API returned invalid JSON.", "ao_invalid_json");
  }
};

const AO_FETCH_TIMEOUT_MS = 10_000;

const aoFetch = async (path: string, init?: RequestInit): Promise<Response> => {
  const config = resolveAoBridgeConfig();
  const url = `${config.apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AO_FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === "AbortError"
          ? `timed out after ${AO_FETCH_TIMEOUT_MS}ms`
          : error.message
        : "Agent Orchestrator API is unreachable.";
    throw new AoBridgeError(
      `Agent Orchestrator API is unavailable (${message}). Start managed AO with npm run dev:managed.`,
      "ao_unreachable",
      503,
    );
  } finally {
    clearTimeout(timeout);
  }
};

const unwrapAoPayload = <T>(payload: T | { data?: T }): T => {
  if (
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    (payload as { data?: T }).data !== undefined
  ) {
    return (payload as { data: T }).data;
  }

  return payload as T;
};

export const fetchAoHealth = async (): Promise<AoBridgeHealth> => {
  const config = resolveAoBridgeConfig();

  try {
    const response = await aoFetch("/api/version");
    if (!response.ok) {
      return {
        available: false,
        apiBaseUrl: config.apiBaseUrl,
        message: `Agent Orchestrator API returned ${response.status}.`,
      };
    }

    const payload = await parseJson<{ version?: string }>(response);
    return {
      available: true,
      apiBaseUrl: config.apiBaseUrl,
      message: "Agent Orchestrator API is reachable.",
      ...(payload.version ? { version: payload.version } : {}),
    };
  } catch (error) {
    const message = error instanceof AoBridgeError ? error.message : "AO health check failed.";
    return {
      available: false,
      apiBaseUrl: config.apiBaseUrl,
      message,
    };
  }
};

export const fetchAoSessions = async (input?: {
  projectId?: string;
  active?: boolean;
}): Promise<AoSessionsResponse> => {
  const params = new URLSearchParams();
  if (input?.projectId) {
    params.set("project", input.projectId);
  }
  if (input?.active === true) {
    params.set("active", "true");
  }

  const query = params.toString();
  const response = await aoFetch(`/api/sessions${query ? `?${query}` : ""}`);
  if (!response.ok) {
    throw new AoBridgeError(
      `Failed to load AO sessions (${response.status}).`,
      "ao_sessions_failed",
      response.status,
    );
  }

  const payload = await parseJson<{
    data?: AoDashboardSession[];
    sessions?: AoDashboardSession[];
    orchestrators?: AoOrchestratorLink[];
    stats?: Record<string, number>;
  }>(response);

  const sessions = Array.isArray(payload.sessions)
    ? payload.sessions
    : Array.isArray(payload.data)
      ? payload.data
      : [];

  return {
    sessions,
    orchestrators: payload.orchestrators ?? [],
    ...(payload.stats ? { stats: payload.stats } : {}),
  };
};

export const fetchAoSession = async (sessionId: string): Promise<AoDashboardSession> => {
  const response = await aoFetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (!response.ok) {
    throw new AoBridgeError(
      `Failed to load AO session ${sessionId} (${response.status}).`,
      "ao_session_failed",
      response.status,
    );
  }

  const payload = await parseJson<AoDashboardSession | { data?: AoDashboardSession }>(response);
  const session = unwrapAoPayload(payload);
  if (!session?.id) {
    throw new AoBridgeError(`AO session ${sessionId} was not found.`, "ao_session_not_found", 404);
  }

  return session;
};

export const fetchAoOrchestrators = async (): Promise<AoOrchestratorLink[]> => {
  const response = await aoFetch("/api/orchestrators");
  if (response.ok) {
    const payload = await parseJson<
      AoOrchestratorLink[] | { data?: AoOrchestratorLink[]; orchestrators?: AoOrchestratorLink[] }
    >(response);

    if (Array.isArray(payload)) {
      return payload;
    }

    if (Array.isArray(payload.orchestrators)) {
      return payload.orchestrators;
    }

    if (Array.isArray(payload.data)) {
      return payload.data;
    }
  }

  // Older AO builds expose orchestrator metadata on the sessions payload only.
  const sessionsResponse = await fetchAoSessions();
  return sessionsResponse.orchestrators ?? [];
};

export const fetchAoReviews = async (projectId?: string): Promise<AoReviewRun[]> => {
  const query = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
  const response = await aoFetch(`/api/reviews${query}`);
  if (!response.ok) {
    throw new AoBridgeError(
      `Failed to load AO reviews (${response.status}).`,
      "ao_reviews_failed",
      response.status,
    );
  }

  const payload = await parseJson<
    AoReviewRun[] | { data?: AoReviewRun[]; runs?: AoReviewRun[]; reviews?: AoReviewRun[] }
  >(response);

  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload.runs)) {
    return payload.runs;
  }

  if (Array.isArray(payload.reviews)) {
    return payload.reviews;
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  return [];
};

export const fetchAoReviewFindings = async (reviewId: string): Promise<AoReviewFinding[]> => {
  const response = await aoFetch(
    `/api/reviews/findings?reviewId=${encodeURIComponent(reviewId)}`,
  );
  if (!response.ok) {
    throw new AoBridgeError(
      `Failed to load AO review findings (${response.status}).`,
      "ao_review_findings_failed",
      response.status,
    );
  }

  const payload = await parseJson<
    AoReviewFinding[] | { data?: AoReviewFinding[]; findings?: AoReviewFinding[] }
  >(response);

  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload.findings)) {
    return payload.findings;
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  return [];
};

export const fetchAoRuntimeTerminalConfig = async (): Promise<AoRuntimeTerminalConfig> => {
  const config = resolveAoBridgeConfig();
  const health = await fetchAoHealth();

  let directTerminalPort = config.muxPort;
  if (health.available) {
    try {
      const response = await aoFetch("/api/runtime/terminal");
      if (response.ok) {
        const payload = await parseJson<{
          directTerminalPort?: number | string;
          terminalPort?: number | string;
        }>(response);
        const parsed = Number.parseInt(
          String(payload.directTerminalPort ?? payload.terminalPort ?? config.muxPort),
          10,
        );
        if (Number.isInteger(parsed) && parsed > 0) {
          directTerminalPort = parsed;
        }
      }
    } catch {
      // Fall back to configured default port.
    }
  }

  return {
    directTerminalPort,
    muxProxyUrl: `ws://127.0.0.1:${config.lcpMuxProxyPort}/mux`,
    apiAvailable: health.available,
  };
};

export const postAoSessionAction = async (
  sessionId: string,
  action: "kill" | "restore" | "send",
  body?: Record<string, unknown>,
): Promise<void> => {
  const suffix = action === "send" ? "send" : action;
  const response = await aoFetch(`/api/sessions/${encodeURIComponent(sessionId)}/${suffix}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) {
    throw new AoBridgeError(
      `AO session ${action} failed (${response.status}).`,
      `ao_session_${action}_failed`,
      response.status,
    );
  }
};
