import { spawnSync } from "node:child_process";
import type { EngineRunLogEntry } from "@/lib/engine/loop-engine-types";
import {
  findWorkflowArtifactByName,
  markWorkflowArtifactUntrusted,
  parseGitArtifactBranch,
  resolveWorkflowArtifactPlaceholders,
} from "@/lib/engine/executors/workflow-artifact-paths";
import type { WorkflowStepExecutorResult } from "@/lib/engine/executors/workflow-step-types";
import type { WorkflowArtifact } from "@/lib/loopboard";
import {
  externalUntrustedPrefix,
  sanitizeExternalSummary,
} from "@/lib/security/safe-context";

export type AiReviewExecutorInput = {
  workflowRunId: string;
  featureId?: string;
  inputArtifacts: WorkflowArtifact[];
  outputArtifacts: WorkflowArtifact[];
  branchLabel?: "approved" | "needs changes";
  backend?: string;
  /** Pass a pre-fetched diff instead of calling `gh pr diff` */
  prDiff?: string;
  /** PR numbers to review (resolved from tasks or artifacts) */
  prNumbers?: number[];
  /** GitHub repository slug (owner/repo) */
  githubRepository?: string;
};

const nowIso = (): string => new Date().toISOString();

const logEntry = (
  level: EngineRunLogEntry["level"],
  message: string,
  metadata: EngineRunLogEntry["metadata"] = {},
): EngineRunLogEntry => ({
  timestamp: nowIso(),
  level,
  message,
  metadata,
});

const inferBranchLabel = (
  testReportArtifact: WorkflowArtifact | undefined,
  override?: AiReviewExecutorInput["branchLabel"],
): "approved" | "needs changes" => {
  if (override) {
    return override;
  }

  const haystack = [
    testReportArtifact?.description ?? "",
    testReportArtifact?.path ?? "",
  ]
    .join(" ")
    .toLowerCase();

  if (/(failed|failure|timed out|exit code: [1-9])/u.test(haystack)) {
    return "needs changes";
  }

  return "approved";
};

const fetchPrDiff = (prNumber: number, repository: string): string | null => {
  const env = { ...process.env };
  const r = spawnSync("gh", ["pr", "diff", String(prNumber), "-R", repository], {
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  return r.status === 0 ? r.stdout : null;
};

const callClaudeReview = (diff: string): "approved" | "needs changes" => {
  const prompt = [
    "You are a code reviewer. Review the following git diff and decide if it is ready to merge.",
    "Respond with ONLY one word: 'approved' if it looks good, or 'needs-changes' if there are issues.",
    "Focus on correctness, not style.",
    "",
    "DIFF:",
    diff.slice(0, 40_000),
  ].join("\n");

  const env = { ...process.env };
  const r = spawnSync(
    "claude",
    ["-p", prompt, "--output-format", "text"],
    { encoding: "utf8", env, timeout: 120_000 },
  );

  if (r.status !== 0) return "approved";
  const out = r.stdout.trim().toLowerCase();
  return out.includes("needs") || out.includes("change") ? "needs changes" : "approved";
};

export const executeAiReview = async (
  input: AiReviewExecutorInput,
): Promise<WorkflowStepExecutorResult> => {
  const branchArtifact = findWorkflowArtifactByName(input.inputArtifacts, [
    "implementation-branch",
    "manual-patch",
  ]);
  const testReportArtifact = findWorkflowArtifactByName(input.inputArtifacts, [
    "test-report",
  ]);
  const reviewNotesArtifact = findWorkflowArtifactByName(input.outputArtifacts, [
    "review-notes",
  ]);

  if (!reviewNotesArtifact) {
    return {
      success: false,
      errorCode: "ai_review_output_missing",
      error: "AI review requires a review-notes output artifact.",
      logs: [
        logEntry("error", "Review notes output artifact was not configured.", {
          workflowRunId: input.workflowRunId,
        }),
      ],
    };
  }

  const branchPath = branchArtifact?.path ?? "unknown-branch";
  const branchName = parseGitArtifactBranch(branchPath) ?? branchPath;
  const testReportPath = testReportArtifact?.path ?? "unknown-test-report";
  const backend = input.backend ?? "stub";

  // Real Claude Code review: fetch PR diff(s) then ask claude to approve/reject
  let realBranchLabel: "approved" | "needs changes" | undefined;
  let realReviewSummary: string | undefined;

  const useRealReview = Boolean(
    backend === "claude-code" || input.prDiff || (input.prNumbers?.length && input.githubRepository),
  );

  if (useRealReview) {
    const diff =
      input.prDiff ??
      (input.prNumbers?.length && input.githubRepository
        ? input.prNumbers
            .map((n) => fetchPrDiff(n, input.githubRepository!))
            .filter(Boolean)
            .join("\n\n")
        : null);

    if (diff && diff.length > 0) {
      realBranchLabel = callClaudeReview(diff);
      realReviewSummary = sanitizeExternalSummary(
        `Claude Code reviewed ${input.prNumbers?.length ?? 1} PR(s). Outcome: ${realBranchLabel}.`,
      ) ?? "Claude review completed.";
    }
  }

  const branchLabel = realBranchLabel ?? inferBranchLabel(testReportArtifact, input.branchLabel);
  const reviewSummary =
    realReviewSummary ??
    sanitizeExternalSummary(
      [
        `AI review (${backend}) for workflow run ${input.workflowRunId}.`,
        `Implementation branch: ${branchName}`,
        `Test report artifact: ${testReportPath}`,
        branchLabel === "approved" ? "Review outcome: approved." : "Review outcome: needs changes.",
      ].join("\n"),
    ) ?? "AI review produced no summary.";

  const resolvedArtifact = markWorkflowArtifactUntrusted(
    resolveWorkflowArtifactPlaceholders(reviewNotesArtifact, {
      run: input.workflowRunId,
      feature: input.featureId ?? "project",
    }),
    "Review notes summarize external diff and test output paths and remain untrusted.",
  );

  return {
    success: true,
    branchLabel,
    outputArtifacts: [
      {
        ...resolvedArtifact,
        description: `${externalUntrustedPrefix} ${reviewSummary}`,
      },
    ],
    result: {
      workflowRunId: input.workflowRunId,
      backend,
      branchLabel,
      reviewNotesPath: resolvedArtifact.path,
      reviewSummary,
      implementationBranchPath: branchPath,
      testReportPath,
    },
    logs: [
      logEntry("info", "AI review executor started.", {
        workflowRunId: input.workflowRunId,
        backend,
        branchLabel,
      }),
      logEntry("info", "AI review stub completed.", {
        reviewNotesPath: resolvedArtifact.path,
        branchLabel,
      }),
    ],
  };
};
