import type { EngineRunLogEntry } from "@/lib/engine/loop-engine-types";
import {
  findWorkflowArtifactByName,
  resolveWorkflowArtifactPlaceholders,
} from "@/lib/engine/executors/workflow-artifact-paths";
import type { WorkflowStepExecutorResult } from "@/lib/engine/executors/workflow-step-types";
import {
  ProcessRunner,
  defaultProcessRunner,
} from "@/lib/engine/process-runner";
import type { WorkflowArtifact } from "@/lib/loopboard";

export type PrReviewExecutorInput = {
  featureId: string;
  workflowRunId?: string;
  inputArtifacts: WorkflowArtifact[];
  outputArtifacts: WorkflowArtifact[];
  projectRepoPath: string;
  cwd: string;
  repository: string;
  processRunner?: ProcessRunner;
};

const nowIso = (): string => new Date().toISOString();

const logEntry = (
  level: EngineRunLogEntry["level"],
  message: string,
  metadata: EngineRunLogEntry["metadata"] = {},
): EngineRunLogEntry => ({ timestamp: nowIso(), level, message, metadata });

export const executePrReview = async (
  input: PrReviewExecutorInput,
): Promise<WorkflowStepExecutorResult> => {
  const runner = input.processRunner ?? defaultProcessRunner;
  const logs: EngineRunLogEntry[] = [];

  const prArtifact = findWorkflowArtifactByName(input.inputArtifacts, ["pull-request"]);
  if (!prArtifact) {
    return {
      success: false,
      errorCode: "pr_review_input_missing",
      error: "PR Review requires a pull-request input artifact with a GitHub PR URL.",
      logs: [logEntry("error", "pull-request input artifact not found.")],
    };
  }

  const resolved = resolveWorkflowArtifactPlaceholders(prArtifact, {
    repository: input.repository,
    feature: input.featureId,
    run: input.workflowRunId ?? "unknown",
  });
  const prUrl = resolved.path;

  logs.push(logEntry("info", "PR Review executor started.", { prUrl, featureId: input.featureId }));

  let run;
  try {
    run = await runner.run({
      profile: "pr-agent",
      args: ["--pr_url", prUrl, "review"],
      cwd: input.cwd,
      projectRepoPath: input.projectRepoPath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "pr-agent invocation failed.";
    return {
      success: false,
      errorCode: "pr_review_spawn_failed",
      error: message,
      logs: [...logs, logEntry("error", message)],
    };
  }

  logs.push(
    logEntry(run.success ? "info" : "warn", "pr-agent review completed.", {
      exitCode: run.exitCode ?? -1,
      durationMs: run.durationMs,
      stdoutSummary: run.stdoutSummary,
      stderrSummary: run.stderrSummary,
    }),
  );

  const outputArtifact = findWorkflowArtifactByName(input.outputArtifacts, ["review-comments"]) ??
    input.outputArtifacts[0];

  return {
    success: run.success,
    ...(run.success ? {} : {
      errorCode: "pr_review_failed",
      error: run.stderrSummary || "PR Agent review exited with a non-zero code.",
    }),
    outputArtifacts: outputArtifact ? [outputArtifact] : [],
    result: { prUrl, stdoutSummary: run.stdoutSummary, exitCode: run.exitCode },
    logs,
  };
};
