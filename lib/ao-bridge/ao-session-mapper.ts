import type { AoAttentionLevel, AoDashboardSession, AoSessionActivity } from "@/lib/ao-bridge/types";

const TERMINAL_STATUSES = new Set([
  "done",
  "merged",
  "approved",
  "completed",
  "cleanup",
  "terminated",
  "killed",
]);

const RESPOND_STATUSES = new Set([
  "errored",
  "error",
  "needs_input",
  "stuck",
  "ci_failed",
]);

const REVIEW_STATUSES = new Set([
  "review_pending",
  "changes_requested",
  "ci_failed",
  "pr_open",
]);

export const inferAoAttentionLevel = (session: AoDashboardSession): AoAttentionLevel => {
  const status = (session.status ?? "").toLowerCase();
  if (TERMINAL_STATUSES.has(status)) {
    return "done";
  }

  if (status === "mergeable" || status === "approved") {
    return "merge";
  }

  if (
    session.activity === "waiting_input" ||
    session.activity === "blocked" ||
    RESPOND_STATUSES.has(status)
  ) {
    return "respond";
  }

  if (REVIEW_STATUSES.has(status)) {
    return "review";
  }

  if (status === "working" || session.activity === "active") {
    return "working";
  }

  return "pending";
};

export const normalizeAoSession = (session: AoDashboardSession): AoDashboardSession => ({
  ...session,
  attentionLevel: inferAoAttentionLevel(session),
  activity: (session.activity ?? null) as AoSessionActivity | null,
});

export const readIssueNumber = (session: AoDashboardSession): number | undefined => {
  if (!session.issueId) {
    return undefined;
  }

  const parsed = Number.parseInt(String(session.issueId).replace(/^#/u, ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};
