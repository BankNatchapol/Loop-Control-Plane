import { spawnSync } from "node:child_process";

import type { EngineRunLogEntry } from "@/lib/engine/loop-engine-types";
import {
  findWorkflowArtifactByName,
  markWorkflowArtifactUntrusted,
  resolveWorkflowArtifactPlaceholders,
} from "@/lib/engine/executors/workflow-artifact-paths";
import {
  runPrAgentReview,
  type PrAgentReviewResult,
} from "@/lib/engine/executors/pr-agent-review-runner";
import type { WorkflowStepExecutorResult } from "@/lib/engine/executors/workflow-step-types";
import type { WorkflowArtifact } from "@/lib/loopboard";

export type PrReviewExecutorInput = {
  featureId: string;
  workflowRunId?: string;
  inputArtifacts: WorkflowArtifact[];
  outputArtifacts: WorkflowArtifact[];
  projectRepoPath: string;
  repository: string;
  plugin: string;
  model: string;
  runReview?: typeof runPrAgentReview;
  readHeadSha?: (prUrl: string) => string | undefined;
};

const logEntry = (
  level: EngineRunLogEntry["level"],
  message: string,
  metadata: EngineRunLogEntry["metadata"] = {},
): EngineRunLogEntry => ({
  timestamp: new Date().toISOString(),
  level,
  message,
  metadata,
});

const isExactPullRequestUrl = (value: string): boolean =>
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#].*)?$/u.test(value);

const defaultReadHeadSha = (cwd: string, prUrl: string): string | undefined => {
  const result = spawnSync(
    "gh",
    ["pr", "view", prUrl, "--json", "headRefOid", "--jq", ".headRefOid"],
    { cwd, encoding: "utf8", timeout: 20_000 },
  );
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
};

export const executePrReview = async (
  input: PrReviewExecutorInput,
): Promise<WorkflowStepExecutorResult> => {
  const prArtifact = findWorkflowArtifactByName(input.inputArtifacts, ["pull-request"]);
  const outputArtifact =
    findWorkflowArtifactByName(input.outputArtifacts, ["review-comments"]) ??
    input.outputArtifacts[0];

  if (!prArtifact || !outputArtifact) {
    return {
      success: false,
      errorCode: "pr_review_artifact_missing",
      error: "PR-Agent requires pull-request input and review-comments output artifacts.",
      logs: [logEntry("error", "PR-Agent artifacts were not configured.")],
    };
  }

  const prUrl = resolveWorkflowArtifactPlaceholders(prArtifact, {
    repository: input.repository,
    feature: input.featureId,
    run: input.workflowRunId ?? "unknown",
  }).path;
  if (!isExactPullRequestUrl(prUrl)) {
    return {
      success: false,
      errorCode: "pr_review_url_invalid",
      error: "PR-Agent requires an exact GitHub /pull/{number} URL.",
      logs: [logEntry("error", "PR-Agent received an invalid pull request URL.", { prUrl })],
    };
  }

  const logs = [
    logEntry("info", "Final PR-Agent review started.", {
      prUrl,
      plugin: input.plugin,
      model: input.model,
    }),
  ];
  const reviewedHeadSha =
    input.readHeadSha?.(prUrl) ?? defaultReadHeadSha(input.projectRepoPath, prUrl);
  if (!reviewedHeadSha) {
    return {
      success: false,
      errorCode: "pr_review_head_missing",
      error: "Could not resolve the final PR head SHA before review.",
      logs: [...logs, logEntry("error", "Final PR head SHA lookup failed.")],
    };
  }

  let review: PrAgentReviewResult;
  try {
    review = await (input.runReview ?? runPrAgentReview)({
      prUrl,
      plugin: input.plugin,
      model: input.model,
      publishOutput: true,
    });
  } catch (error) {
    review = {
      success: false,
      error: error instanceof Error ? error.message : "PR-Agent review failed.",
    };
  }

  if (!review.success || !review.verdict || !review.summary) {
    return {
      success: false,
      errorCode: "pr_review_failed_closed",
      error: review.error ?? "PR-Agent did not produce a valid structured review.",
      result: { prUrl, reviewedHeadSha },
      logs: [
        ...logs,
        logEntry("error", "Final PR-Agent review could not produce a safe verdict.", {
          error: review.error ?? null,
        }),
      ],
    };
  }

  const currentHeadSha =
    input.readHeadSha?.(prUrl) ?? defaultReadHeadSha(input.projectRepoPath, prUrl);
  if (!currentHeadSha || currentHeadSha !== reviewedHeadSha) {
    return {
      success: false,
      errorCode: "pr_review_head_changed",
      error: "The pull request head changed during review; a fresh review is required.",
      result: {
        prUrl,
        reviewedHeadSha,
        currentHeadSha: currentHeadSha ?? null,
      },
      logs: [
        ...logs,
        logEntry("warn", "Final PR head changed during PR-Agent review.", {
          reviewedHeadSha,
          currentHeadSha: currentHeadSha ?? null,
        }),
      ],
    };
  }

  const branchLabel = review.verdict;
  const resolvedOutput = markWorkflowArtifactUntrusted(
    resolveWorkflowArtifactPlaceholders(outputArtifact, {
      repository: input.repository,
      feature: input.featureId,
      run: input.workflowRunId ?? "unknown",
    }),
    "PR-Agent review findings are model-generated external content.",
  );

  return {
    success: true,
    branchLabel,
    outputArtifacts: [resolvedOutput],
    result: {
      branchLabel,
      reviewSummary: review.summary,
      reviewedPrUrl: prUrl,
      reviewedHeadSha,
      plugin: input.plugin,
      model: input.model,
    },
    logs: [
      ...logs,
      logEntry("info", `Final PR-Agent verdict: ${branchLabel}.`, {
        prUrl,
        reviewedHeadSha,
      }),
    ],
  };
};
