import type { BackendPollResult } from "@/lib/engine/backends/backend-adapter";
import type { AoSessionRecord } from "@/lib/engine/ao-worker-pool-types";

const TERMINAL_SUCCESS_STATUSES = new Set([
  "done",
  "merged",
  "approved",
  "completed",
  // Worker created a PR and exited — implementation phase is done.
  // Subsequent workflow steps handle review/merge.
  "pr_open",
  "review_pending",
  "mergeable",
]);

const TERMINAL_FAILURE_STATUSES = new Set([
  "errored",
  "error",
  "ci_failed",
  "failed",
  "killed",
]);

const TERMINAL_CANCELLED_STATUSES = new Set(["terminated", "cleanup", "cancelled"]);

export type AoSessionJson = {
  id?: string;
  status?: string;
  /** "active" | "idle" | "exited" | null — "exited" means the agent process died. */
  activity?: string | null;
  issueId?: string | number | null;
  pr?: { url?: string | null; number?: number | null } | null;
};

// Raw shape returned by `ao status --json` (field names differ from AoSessionJson).
type AoRawSession = Record<string, unknown>;

type AoJsonEnvelope = {
  data?: AoRawSession[];
  meta?: { hiddenTerminatedCount?: number };
};

// Normalize one raw AO session into the shape the executor expects.
// AO CLI returns: name (not id), issue (not issueId), pr as a string URL (not {url, number}).
const normalizeSession = (raw: AoRawSession): AoSessionJson => ({
  id: (raw["id"] as string | undefined) ?? (raw["name"] as string | undefined),
  status: raw["status"] as string | undefined,
  activity: raw["activity"] as string | null | undefined,
  issueId:
    (raw["issueId"] as string | number | null | undefined) ??
    (raw["issue"] as string | number | null | undefined),
  pr:
    typeof raw["pr"] === "string"
      ? { url: raw["pr"], number: (raw["prNumber"] as number | null | undefined) ?? null }
      : (raw["pr"] as AoSessionJson["pr"]),
});

export const parseAoJsonSessions = (stdout: string): AoSessionJson[] => {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as AoJsonEnvelope | AoRawSession[];
    const raw = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.data) ? parsed.data : []);
    return raw.map(normalizeSession);
  } catch {
    return [];
  }
};

export const extractAoSessionId = (stdout: string): string | undefined => {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }

  const labeledMatch = trimmed.match(/session[:\s]+([A-Za-z0-9._-]+)/iu);
  if (labeledMatch?.[1]) {
    return labeledMatch[1];
  }

  const lines = trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.at(-1);
};

export const mapAoSessionStatus = (
  status: string | undefined,
): BackendPollResult["status"] | "running" => {
  const normalized = (status ?? "").trim().toLowerCase();
  if (!normalized) {
    return "running";
  }

  if (TERMINAL_SUCCESS_STATUSES.has(normalized)) {
    return "completed";
  }

  if (TERMINAL_FAILURE_STATUSES.has(normalized)) {
    return "failed";
  }

  if (TERMINAL_CANCELLED_STATUSES.has(normalized)) {
    return "cancelled";
  }

  return "running";
};

export const findSessionForRecord = (
  sessions: AoSessionJson[],
  record: AoSessionRecord,
): AoSessionJson | undefined => {
  if (record.sessionId) {
    const byId = sessions.find((session) => session.id === record.sessionId);
    if (byId) {
      return byId;
    }
  }

  const issueToken = String(record.issueNumber);
  return sessions.find((session) => {
    const issueId = session.issueId;
    if (issueId === null || issueId === undefined) {
      return false;
    }

    return String(issueId) === issueToken;
  });
};

export const buildAoArgs = (input: {
  command: "spawn" | "status" | "send";
  projectId?: string;
  issueNumber?: number;
  sessionId?: string;
  message?: string;
  /** Passed as `--agent <name>` on spawn (e.g. "claude-code", "codex", "opencode"). */
  agentPlugin?: string;
}): string[] => {
  const args: string[] = [input.command];

  if (input.command === "spawn") {
    if (typeof input.issueNumber !== "number") {
      throw new Error("Agent Orchestrator spawn requires an issue number.");
    }

    args.push(String(input.issueNumber));

    if (input.agentPlugin) {
      args.push("--agent", input.agentPlugin);
    }
  }

  if (input.command === "send") {
    if (!input.sessionId || !input.message) {
      throw new Error("Agent Orchestrator send requires a session id and message.");
    }

    args.push(input.sessionId, input.message);
  }

  if (input.projectId) {
    args.push("--project", input.projectId);
  }

  if (input.command === "status") {
    // Intentionally omit --include-terminated so that killed sessions from
    // previous runs are invisible to the pool. Items with no active session
    // stay "queued" and the spawner creates fresh workers for them.
    args.push("--json");
  }

  return args;
};
