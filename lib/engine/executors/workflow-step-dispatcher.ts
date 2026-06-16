import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { resolveExecutorConfigWithFallbacks } from "@/lib/engine/executor-config-resolver";
import {
  validateExecutorConfig,
  type ExecutorConfig,
} from "@/lib/engine/loop-engine-types";
import type { ExecutorContext, ExecutorResult } from "@/lib/engine/executor-registry";
import {
  ProcessRunner,
  defaultProcessRunner,
} from "@/lib/engine/process-runner";

import { executeAiReview } from "@/lib/engine/executors/ai-review-executor";
import { executeCreateGitHubIssues } from "@/lib/engine/executors/create-github-issues-executor";
import { executeImportTasks } from "@/lib/engine/executors/import-tasks-executor";
import { executeOpenPr } from "@/lib/engine/executors/open-pr-executor";
import { executeRunTests } from "@/lib/engine/executors/run-tests-executor";
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
    branchLabel: stepResult.branchLabel,
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

  const processRunner = deps.processRunner ?? defaultProcessRunner;
  const projectId = context.job.projectId ?? deps.repository.getWorkflowRun(payload.workflowRunId).projectId;
  const project = deps.repository.getProject(projectId);
  const workflowRun = deps.repository.getWorkflowRun(payload.workflowRunId);
  const workflow = deps.repository.getWorkflow(workflowRun.workflowId);
  const workflowNode = workflow.nodes.find((node) => node.id === payload.workflowNodeId);
  const explicitExecutorConfig =
    resolveExecutorConfig(payload.executor) ??
    resolveExecutorConfig(context.config) ??
    context.config;
  const executorConfig = resolveExecutorConfigWithFallbacks({
    explicitConfig: explicitExecutorConfig,
    project,
    ...(workflowNode ? { workflowNode } : {}),
  });

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

  if (payload.nodeType === "create-github-issues") {
    const featureId = payload.featureId ?? context.job.payload.featureId;
    if (typeof featureId !== "string" || featureId.length === 0) {
      return {
        success: false,
        error: "Create GitHub issues workflow step requires a linked featureId.",
        logs: [
          {
            timestamp: new Date().toISOString(),
            level: "error",
            message: "Missing featureId for create-github-issues workflow step.",
            metadata: { jobId: context.job.id },
          },
        ],
      };
    }

    const stepResult = await executeCreateGitHubIssues({
      repository: deps.repository,
      featureId,
      workflowRunId: payload.workflowRunId,
      outputArtifacts: payload.outputArtifacts,
    });

    return toExecutorResult(stepResult);
  }

  if (payload.nodeType === "open-pr") {
    const featureId = payload.featureId ?? context.job.payload.featureId;
    if (typeof featureId !== "string" || featureId.length === 0) {
      return {
        success: false,
        error: "Open PR workflow step requires a linked featureId.",
        logs: [
          {
            timestamp: new Date().toISOString(),
            level: "error",
            message: "Missing featureId for open-pr workflow step.",
            metadata: { jobId: context.job.id },
          },
        ],
      };
    }

    const stepResult = await executeOpenPr({
      repository: deps.repository,
      featureId,
      workflowRunId: payload.workflowRunId,
      inputArtifacts: payload.inputArtifacts,
      outputArtifacts: payload.outputArtifacts,
      projectRepoPath: project.repoPath,
      cwd: executorConfig.cwd ?? executorConfig.workingDirectory ?? project.repoPath,
      timeoutMs: executorConfig.timeoutMs,
      useGhCreateFallback: executorConfig.backend === "stub",
    });

    return toExecutorResult(stepResult);
  }

  if (payload.nodeType === "run-tests") {
    const stepResult = await executeRunTests({
      projectRepoPath: project.repoPath,
      workflowRunId: payload.workflowRunId,
      featureId:
        typeof payload.featureId === "string" ? payload.featureId : undefined,
      inputArtifacts: payload.inputArtifacts,
      outputArtifacts: payload.outputArtifacts,
      args: executorConfig.args,
      cwd: executorConfig.cwd ?? executorConfig.workingDirectory ?? project.repoPath,
      timeoutMs: executorConfig.timeoutMs,
      processRunner,
    });

    return toExecutorResult(stepResult);
  }

  if (payload.nodeType === "ai-review") {
    const stepResult = executeAiReview({
      workflowRunId: payload.workflowRunId,
      featureId:
        typeof payload.featureId === "string" ? payload.featureId : undefined,
      inputArtifacts: payload.inputArtifacts,
      outputArtifacts: payload.outputArtifacts,
      backend: executorConfig.backend,
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
