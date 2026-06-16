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

export const executeAiReview = (
  input: AiReviewExecutorInput,
): WorkflowStepExecutorResult => {
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
  const branchLabel = inferBranchLabel(testReportArtifact, input.branchLabel);
  const backend = input.backend ?? "stub";
  const reviewSummary =
    sanitizeExternalSummary(
      [
        `AI review stub (${backend}) for workflow run ${input.workflowRunId}.`,
        `Implementation branch: ${branchName}`,
        `Test report artifact: ${testReportPath}`,
        branchLabel === "approved"
          ? "Review outcome: approved (stub)."
          : "Review outcome: needs changes (stub).",
        "Real agent invocation is deferred to Phase 04 backend adapters.",
      ].join("\n"),
    ) ?? "AI review stub produced no summary.";

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
