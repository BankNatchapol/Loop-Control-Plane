import { spawnSync } from "node:child_process";

import type { EngineRunLogEntry } from "@/lib/engine/loop-engine-types";
import {
  findWorkflowArtifactByName,
  markWorkflowArtifactUntrusted,
  parseGitArtifactBranch,
  resolveWorkflowArtifactPlaceholders,
} from "@/lib/engine/executors/workflow-artifact-paths";
import type { WorkflowStepExecutorResult } from "@/lib/engine/executors/workflow-step-types";
import { AO_AGENT_PLUGIN_OPTIONS } from "@/lib/workflows/workflow-executor-editor";
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
  /** Optional diff supplied by a caller or test. */
  reviewDiff?: string;
  /** Active analysis agent (cursor, claude-code, codex). */
  aoAgentPlugin?: string;
  /** Per-agent model overrides configured in the workflow UI. */
  aoAgentModels?: Record<string, string>;
  /** Repository containing the integrated feature and any human edits. */
  repoPath?: string;
  /** Branch/ref that the integrated feature is compared against. */
  baseBranch?: string;
};

type ReviewResult = {
  verdict: "approved" | "needs changes";
  summary: string;
  method: string;
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

const resolveAgentModel = (
  plugin: string,
  models: Record<string, string> | undefined,
): string =>
  models?.[plugin]?.trim() ||
  AO_AGENT_PLUGIN_OPTIONS.find((option) => option.value === plugin)?.defaultModel ||
  "claude-sonnet-4-6";

const inferBranchLabel = (
  testReportArtifact: WorkflowArtifact | undefined,
  override?: AiReviewExecutorInput["branchLabel"],
): "approved" | "needs changes" => {
  if (override) return override;
  const haystack = [testReportArtifact?.description ?? "", testReportArtifact?.path ?? ""]
    .join(" ")
    .toLowerCase();
  return /(failed|failure|timed out|exit code: [1-9])/u.test(haystack)
    ? "needs changes"
    : "approved";
};

export const parseVerdictFromText = (text: string): "approved" | "needs changes" => {
  const normalized = text.toUpperCase();
  if (
    normalized.includes("VERDICT: NEEDS_CHANGES") ||
    normalized.includes("VERDICT: NEEDS CHANGES")
  ) {
    return "needs changes";
  }
  if (
    normalized.includes("NEEDS_CHANGES") ||
    normalized.includes("ACTION REQUIRED") ||
    normalized.includes("CHANGES_REQUESTED")
  ) {
    return "needs changes";
  }
  return normalized.includes("VERDICT: APPROVED")
    ? "approved"
    : "needs changes";
};

const fetchIntegratedDiff = (
  repoPath: string,
  baseBranch: string,
  logs: EngineRunLogEntry[],
): string | undefined => {
  const candidates = [`origin/${baseBranch}`, baseBranch];
  for (const baseRef of candidates) {
    const result = spawnSync(
      "git",
      ["diff", "--no-ext-diff", "--find-renames", baseRef, "--"],
      {
        cwd: repoPath,
        encoding: "utf8",
        env: { ...process.env },
        timeout: 60_000,
      },
    );
    if (result.status === 0) {
      logs.push(logEntry("info", "Loaded integrated feature diff.", {
        baseRef,
        chars: result.stdout.length,
      }));
      return result.stdout;
    }
  }

  logs.push(logEntry("warn", "Could not load integrated feature diff.", {
    baseBranch,
  }));
  return undefined;
};

const buildReviewPrompt = (
  diff: string,
  testReportArtifact: WorkflowArtifact | undefined,
): string => [
  "Review the complete integrated feature diff below.",
  "This is the final code-analysis stage after task PRs have been integrated.",
  "Analyze correctness, regressions, security, cross-task interactions, and test coverage.",
  "If this is a repeat pass, evaluate the current diff including any human edits.",
  "Do not post GitHub comments and do not modify files.",
  "",
  "Respond in this exact format:",
  "VERDICT: APPROVED",
  "SUMMARY: <concise analysis>",
  "ISSUES: None",
  "",
  "or:",
  "VERDICT: NEEDS_CHANGES",
  "SUMMARY: <concise analysis>",
  "ISSUES:",
  "- <actionable issue>",
  "",
  `TEST REPORT: ${testReportArtifact?.description ?? testReportArtifact?.path ?? "not supplied"}`,
  "",
  "INTEGRATED DIFF:",
  diff.slice(0, 80_000),
].join("\n");

const callAnalysisAgent = (
  plugin: string,
  model: string,
  prompt: string,
  repoPath: string,
  logs: EngineRunLogEntry[],
): ReviewResult | undefined => {
  const invocation =
    plugin === "codex"
      ? {
          command: "codex",
          args: [
            "exec",
            "--model",
            model,
            "--sandbox",
            "read-only",
            "--ephemeral",
            "--ignore-rules",
            "-",
          ],
          timeout: 240_000,
        }
      : plugin === "cursor"
        ? {
            // cursor uses async ao spawn; not available in synchronous ai-review path.
            // The pr-review-agent node handles cursor via the proxy/ao-spawn flow.
            command: "claude",
            args: ["-p", "-", "--output-format", "text", "--model", "claude-sonnet-4-6"],
            timeout: 180_000,
          }
        : {
            command: "claude",
            args: [
              "-p",
              "-",
              "--output-format",
              "text",
              "--model",
              model,
            ],
            timeout: 180_000,
          };

  logs.push(logEntry("info", "Running final integrated-code analysis.", {
    plugin,
    model,
  }));

  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoPath,
    input: prompt,
    encoding: "utf8",
    env: { ...process.env },
    timeout: invocation.timeout,
  });
  const output = result.stdout?.trim() ?? "";

  if (result.status !== 0 || !output) {
    logs.push(logEntry("warn", "Final analysis agent failed.", {
      plugin,
      model,
      exitCode: result.status,
      stderr: result.stderr?.slice(0, 400),
    }));
    return undefined;
  }

  return {
    verdict: parseVerdictFromText(output),
    summary: output.slice(0, 1600),
    method: `${plugin}/${model}`,
  };
};

export const executeAiReview = async (
  input: AiReviewExecutorInput,
): Promise<WorkflowStepExecutorResult> => {
  const branchArtifact = findWorkflowArtifactByName(input.inputArtifacts, [
    "manual-patch",
    "implementation-branch",
  ]);
  const testReportArtifact = findWorkflowArtifactByName(input.inputArtifacts, ["test-report"]);
  const reviewNotesArtifact = findWorkflowArtifactByName(input.outputArtifacts, ["review-notes"]);

  if (!reviewNotesArtifact) {
    return {
      success: false,
      errorCode: "ai_review_output_missing",
      error: "AI review requires a review-notes output artifact.",
      logs: [logEntry("error", "Review notes output artifact was not configured.")],
    };
  }

  const plugin = input.aoAgentPlugin ?? "claude-code";
  const model = resolveAgentModel(plugin, input.aoAgentModels);
  const repoPath = input.repoPath ?? process.cwd();
  const baseBranch = input.baseBranch ?? "main";
  const branchPath = branchArtifact?.path ?? "unknown-branch";
  const branchName = parseGitArtifactBranch(branchPath) ?? branchPath;
  const logs: EngineRunLogEntry[] = [
    logEntry("info", "Final AI review started.", {
      workflowRunId: input.workflowRunId,
      plugin,
      model,
      baseBranch,
    }),
  ];

  const diff =
    input.reviewDiff ??
    fetchIntegratedDiff(repoPath, baseBranch, logs);
  const prompt = diff ? buildReviewPrompt(diff, testReportArtifact) : undefined;
  const shouldRunAgent =
    input.backend !== undefined && input.backend !== "stub" ||
    input.aoAgentPlugin !== undefined;
  const reviewResult = shouldRunAgent && prompt
    ? callAnalysisAgent(plugin, model, prompt, repoPath, logs)
    : undefined;

  const branchLabel =
    reviewResult?.verdict ??
    (shouldRunAgent
      ? "needs changes"
      : inferBranchLabel(testReportArtifact, input.branchLabel));
  const reviewSummary =
    sanitizeExternalSummary(
      reviewResult?.summary ??
        [
          `Final AI review (${plugin}) for workflow run ${input.workflowRunId}.`,
          `Branch: ${branchName}`,
          diff === undefined ? "Integrated diff unavailable." : "Analysis agent unavailable.",
          branchLabel === "approved" ? "Outcome: approved." : "Outcome: needs changes.",
        ].join("\n"),
    ) ?? "AI review produced no summary.";

  const resolvedArtifact = markWorkflowArtifactUntrusted(
    resolveWorkflowArtifactPlaceholders(reviewNotesArtifact, {
      run: input.workflowRunId,
      feature: input.featureId ?? "project",
    }),
    "Final AI analysis is external model output and remains untrusted.",
  );

  logs.push(logEntry("info", "Final AI review completed.", {
    branchLabel,
    method: reviewResult?.method ?? "fallback",
    reviewNotesPath: resolvedArtifact.path,
  }));

  return {
    success: true,
    branchLabel,
    outputArtifacts: [{
      ...resolvedArtifact,
      description: `${externalUntrustedPrefix} ${reviewSummary}`,
    }],
    result: {
      workflowRunId: input.workflowRunId,
      backend: input.backend ?? "stub",
      plugin,
      model,
      branchLabel,
      reviewNotesPath: resolvedArtifact.path,
      reviewSummary,
      implementationBranchPath: branchPath,
      reviewMethod: reviewResult?.method ?? "fallback",
      reviewScope: "integrated-feature",
      baseBranch,
    },
    logs,
  };
};
