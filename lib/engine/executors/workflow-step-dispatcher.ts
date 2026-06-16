import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import {
  validateExecutorConfig,
  type ExecutorConfig,
} from "@/lib/engine/loop-engine-types";
import type { ExecutorContext, ExecutorResult } from "@/lib/engine/executor-registry";
import {
  ProcessRunner,
  defaultProcessRunner,
} from "@/lib/engine/process-runner";

import { executeImportTasks } from "@/lib/engine/executors/import-tasks-executor";
import { executeSpecKitActions } from "@/lib/engine/executors/spec-kit-actions-executor";
import { parseWorkflowStepJobPayload } from "@/lib/engine/executors/workflow-step-types";

export type WorkflowStepDispatcherDeps = {
  repository: LoopBoardRepository;
  processRunner?: ProcessRunner;
};

const toExecutorResult = (
  stepResult: Awaited<ReturnType<typeof executeSpecKitActions>>,
): ExecutorResult => ({
  success: stepResult.success,
  error: stepResult.error,
  stdoutSummary:
    typeof stepResult.result?.stdoutSummary === "string"
      ? stepResult.result.stdoutSummary
      : undefined,
  stderrSummary:
    typeof stepResult.result?.stderrSummary === "string"
      ? stepResult.result.stderrSummary
      : undefined,
  result: {
    ...stepResult.result,
    errorCode: stepResult.errorCode,
    outputArtifacts: stepResult.outputArtifacts,
  },
  logs: stepResult.logs,
});

const resolveExecutorConfig = (value: unknown): ExecutorConfig | undefined => {
  const validation = validateExecutorConfig(value);
  return validation.ok ? validation.config : undefined;
};

export const dispatchWorkflowStepJob = async (
  context: ExecutorContext,
  deps: WorkflowStepDispatcherDeps,
): Promise<ExecutorResult> => {
  const payload = parseWorkflowStepJobPayload(context.job.payload);
  if (!payload) {
    return {
      success: false,
      error: "Workflow-step job payload is invalid or incomplete.",
      logs: [
        {
          timestamp: new Date().toISOString(),
          level: "error",
          message: "Workflow-step payload failed validation.",
          metadata: { jobId: context.job.id },
        },
      ],
    };
  }

  const executorConfig =
    resolveExecutorConfig(payload.executor) ??
    resolveExecutorConfig(context.config) ??
    context.config;
  const processRunner = deps.processRunner ?? defaultProcessRunner;
  const projectId = context.job.projectId ?? deps.repository.getWorkflowRun(payload.workflowRunId).projectId;
  const project = deps.repository.getProject(projectId);

  if (payload.nodeType === "spec-kit-actions") {
    const stepResult = await executeSpecKitActions({
      projectRepoPath: project.repoPath,
      cwd: executorConfig.cwd ?? executorConfig.workingDirectory ?? project.repoPath,
      inputArtifacts: payload.inputArtifacts,
      outputArtifacts: payload.outputArtifacts,
      actions: executorConfig.args,
      timeoutMs: executorConfig.timeoutMs,
      processRunner,
    });

    return toExecutorResult(stepResult);
  }

  if (payload.nodeType === "import-tasks") {
    const featureId = payload.featureId ?? context.job.payload.featureId;
    if (typeof featureId !== "string" || featureId.length === 0) {
      return {
        success: false,
        error: "Import tasks workflow step requires a linked featureId.",
        logs: [
          {
            timestamp: new Date().toISOString(),
            level: "error",
            message: "Missing featureId for import-tasks workflow step.",
            metadata: { jobId: context.job.id },
          },
        ],
      };
    }

    const stepResult = executeImportTasks({
      repository: deps.repository,
      featureId,
      inputArtifacts: payload.inputArtifacts,
      outputArtifacts: payload.outputArtifacts,
    });

    return toExecutorResult(stepResult);
  }

  return {
    success: false,
    error: `Workflow-step node type "${payload.nodeType}" is not supported by the dispatcher.`,
    logs: [
      {
        timestamp: new Date().toISOString(),
        level: "error",
        message: `Unsupported workflow-step node type "${payload.nodeType}".`,
        metadata: { jobId: context.job.id, nodeType: payload.nodeType },
      },
    ],
  };
};
