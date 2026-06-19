import type { PrAgentReviewResult } from "@/lib/engine/executors/pr-agent-review-runner";

export type AoPrReviewGateLog = (
  level: "info" | "warn" | "error",
  message: string,
  metadata?: Record<string, unknown>,
) => void;

export const createAoPrReviewGate = (input: {
  plugin: string;
  model: string;
  maxIterations: number;
  publishOutput: boolean;
  readHeadSha: (prUrl: string) => Promise<string | undefined>;
  runReview: (input: {
    prUrl: string;
    plugin: string;
    model: string;
    publishOutput: boolean;
  }) => Promise<PrAgentReviewResult>;
  sendToWorker: (sessionId: string, message: string) => boolean | Promise<boolean>;
  log?: AoPrReviewGateLog;
  initialState?: Record<
    number,
    { reviewedSha?: string; cleanSha?: string; iterations?: number }
  >;
  onState?: (
    issueNumber: number,
    state: {
      reviewedSha?: string;
      cleanSha?: string;
      iterations: number;
      verdict?: "approved" | "needs changes";
      error?: string;
    },
  ) => void;
}) => {
  const stateByIssue = new Map(
    Object.entries(input.initialState ?? {}).map(([issue, state]) => [
      Number(issue),
      { ...state, iterations: state.iterations ?? 0 },
    ]),
  );

  return async (observed: {
    issueNumber: number;
    sessionId?: string;
    prUrl?: string;
  }): Promise<"approved" | "continue" | "hold" | "fail"> => {
    const { issueNumber, sessionId, prUrl } = observed;
    if (!sessionId || !prUrl) return "continue";

    const headSha = await input.readHeadSha(prUrl);
    if (!headSha) return "hold";

    const state = stateByIssue.get(issueNumber) ?? { iterations: 0 };
    // Already clean — signal "approved" so the pool marks the item completed
    // without falling through to updateItemFromSession (which would map a
    // "killed" session to "failed" even though the review already passed).
    if (state.cleanSha === headSha) return "approved";
    if (state.reviewedSha === headSha) return "hold";
    if (state.iterations >= input.maxIterations) {
      input.onState?.(issueNumber, {
        ...state,
        error: "PR-Agent review loop exceeded retry limit.",
      });
      input.log?.("error", "PR-Agent review loop exceeded retry limit.", {
        issueNumber,
        prUrl,
        iterations: state.iterations,
      });
      return "fail";
    }

    state.reviewedSha = headSha;
    state.iterations += 1;
    stateByIssue.set(issueNumber, state);
    input.log?.("info", "Running PR-Agent inside AO task loop.", {
      issueNumber,
      prUrl,
      headSha,
      iteration: state.iterations,
      plugin: input.plugin,
      model: input.model,
    });

    const review = await input.runReview({
      prUrl,
      plugin: input.plugin,
      model: input.model,
      publishOutput: input.publishOutput,
    });
    if (!review.success || !review.verdict) {
      input.onState?.(issueNumber, {
        ...state,
        error: review.error ?? "unknown review failure",
      });
      input.log?.("error", "PR-Agent task review failed.", {
        issueNumber,
        prUrl,
        error: review.error ?? "unknown review failure",
      });
      return "fail";
    }

    if (review.verdict === "approved") {
      state.cleanSha = headSha;
      stateByIssue.set(issueNumber, state);
      input.onState?.(issueNumber, { ...state, verdict: "approved" });
      input.log?.("info", "PR-Agent marked task PR clean.", {
        issueNumber,
        prUrl,
        headSha,
        iterations: state.iterations,
      });
      // "approved" tells the pool to mark the item completed directly,
      // bypassing updateItemFromSession (which maps "killed" → "failed").
      return "approved";
    }

    const feedback = [
      `PR-Agent found issues on ${prUrl} at commit ${headSha}.`,
      "Address every actionable finding, run relevant tests, push the fixes, and keep the PR open.",
      "Do not mark the task complete until a subsequent PR-Agent pass is clean.",
      "",
      review.summary ?? "PR-Agent returned needs changes without a summary.",
    ].join("\n");
    if (!(await input.sendToWorker(sessionId, feedback))) {
      input.onState?.(issueNumber, {
        ...state,
        verdict: "needs changes",
        error: "Could not send PR-Agent findings to AO worker.",
      });
      input.log?.("error", "Could not send PR-Agent findings to AO worker.", {
        issueNumber,
        sessionId,
      });
      return "fail";
    }

    input.log?.("info", "Sent PR-Agent findings to AO worker.", {
      issueNumber,
      sessionId,
      headSha,
      iteration: state.iterations,
    });
    input.onState?.(issueNumber, { ...state, verdict: "needs changes" });
    return "hold";
  };
};
