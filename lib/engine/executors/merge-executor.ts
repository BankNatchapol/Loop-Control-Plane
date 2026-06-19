import type { EngineRunLogEntry } from "@/lib/engine/loop-engine-types";
import {
  findWorkflowArtifactByName,
  resolveWorkflowArtifactPlaceholders,
} from "@/lib/engine/executors/workflow-artifact-paths";
import type { WorkflowStepExecutorResult } from "@/lib/engine/executors/workflow-step-types";
import {
  ProcessRunner,
  defaultProcessRunner,
  type ProcessRunPolicyContext,
  type ProcessRunResult,
} from "@/lib/engine/process-runner";
import type { WorkflowArtifact } from "@/lib/loopboard";

export type MergeExecutorInput = {
  workflowRunId: string;
  inputArtifacts: WorkflowArtifact[];
  outputArtifacts: WorkflowArtifact[];
  projectRepoPath: string;
  repository: string;
  defaultBranch: string;
  timeoutMs?: number;
  processRunner?: Pick<ProcessRunner, "run">;
  policy?: ProcessRunPolicyContext;
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

export const executeMerge = async (
  input: MergeExecutorInput,
): Promise<WorkflowStepExecutorResult> => {
  const prArtifact = findWorkflowArtifactByName(input.inputArtifacts, ["pull-request"]);
  const mergedArtifact = findWorkflowArtifactByName(input.outputArtifacts, [
    "merged-branch",
  ]);
  const prUrl = prArtifact?.path;

  if (
    !prUrl ||
    !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#].*)?$/u.test(prUrl) ||
    !mergedArtifact
  ) {
    return {
      success: false,
      errorCode: "merge_artifact_invalid",
      error: "Merge requires an exact pull-request input and merged-branch output.",
      logs: [logEntry("error", "Merge artifacts were missing or invalid.")],
    };
  }

  const runner = input.processRunner ?? defaultProcessRunner;
  const runGh = (args: string[]): Promise<ProcessRunResult> =>
    runner.run({
      profile: "gh",
      args,
      cwd: input.projectRepoPath,
      projectRepoPath: input.projectRepoPath,
      timeoutMs: input.timeoutMs,
      policy: input.policy,
    });
  const logs = [logEntry("info", "Human-approved squash merge started.", { prUrl })];

  const verifyMerged = async (): Promise<{
    result: ProcessRunResult;
    parsed: {
      state?: string;
      mergedAt?: string;
      url?: string;
      baseRefName?: string;
    };
  }> => {
    const result = await runGh([
      "pr",
      "view",
      prUrl,
      "--json",
      "state,mergedAt,url,baseRefName",
    ]);
    try {
      return { result, parsed: JSON.parse(result.stdout) };
    } catch {
      return { result, parsed: {} };
    }
  };

  let beforeMerge;
  try {
    beforeMerge = await verifyMerged();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Merge reconciliation failed.";
    return {
      success: false,
      errorCode: "merge_verification_failed",
      error: message,
      logs: [...logs, logEntry("error", message)],
    };
  }

  const alreadyMerged =
    beforeMerge.result.success &&
    beforeMerge.parsed.state === "MERGED" &&
    Boolean(beforeMerge.parsed.mergedAt) &&
    beforeMerge.parsed.url === prUrl &&
    beforeMerge.parsed.baseRefName === input.defaultBranch;

  let mergeResult: ProcessRunResult;
  if (!alreadyMerged) {
    try {
      mergeResult = await runGh(["pr", "merge", prUrl, "--squash", "--delete-branch"]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "gh pr merge failed.";
      return {
        success: false,
        errorCode: "merge_command_failed",
        error: message,
        logs: [...logs, logEntry("error", message)],
      };
    }
    if (!mergeResult.success) {
      return {
        success: false,
        errorCode: mergeResult.timedOut ? "merge_timeout" : "merge_command_failed",
        error:
          mergeResult.stderrSummary ||
          "GitHub rejected the merge because checks, protection, or conflicts remain.",
        logs: [...logs, logEntry("error", "GitHub squash merge did not complete.")],
      };
    }
  } else {
    logs.push(logEntry("info", "Exact pull request was already merged; reusing GitHub state."));
  }

  let verifyResult: ProcessRunResult;
  try {
    verifyResult = (await verifyMerged()).result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Merge verification failed.";
    return {
      success: false,
      errorCode: "merge_verification_failed",
      error: message,
      logs: [...logs, logEntry("error", message)],
    };
  }

  let verified: {
    state?: string;
    mergedAt?: string;
    url?: string;
    baseRefName?: string;
  };
  try {
    verified = JSON.parse(verifyResult.stdout) as typeof verified;
  } catch {
    verified = {};
  }
  if (
    !verifyResult.success ||
    verified.state !== "MERGED" ||
    !verified.mergedAt ||
    verified.url !== prUrl ||
    verified.baseRefName !== input.defaultBranch
  ) {
    return {
      success: false,
      errorCode: "merge_verification_failed",
      error: "GitHub did not confirm that the exact final pull request is merged.",
      result: { prUrl, state: verified.state ?? null },
      logs: [...logs, logEntry("error", "Merged state verification failed.")],
    };
  }

  const outputArtifact = resolveWorkflowArtifactPlaceholders(mergedArtifact, {
    repository: input.repository,
    defaultBranch: verified.baseRefName ?? input.defaultBranch,
    run: input.workflowRunId,
  });
  return {
    success: true,
    outputArtifacts: [outputArtifact],
    result: {
      mergedPrUrl: prUrl,
      mergedAt: verified.mergedAt,
      defaultBranch: verified.baseRefName ?? input.defaultBranch,
    },
    logs: [
      ...logs,
      logEntry("info", "Squash merge verified.", {
        prUrl,
        mergedAt: verified.mergedAt,
      }),
    ],
  };
};
