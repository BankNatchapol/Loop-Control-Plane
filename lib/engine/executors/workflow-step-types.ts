import type { EngineRunLogEntry, ExecutorConfig } from "@/lib/engine/loop-engine-types";
import type { WorkflowArtifact } from "@/lib/loopboard";

export type WorkflowStepJobPayload = {
  workflowRunId: string;
  workflowNodeId: string;
  nodeType: string;
  featureId?: string;
  executor: ExecutorConfig;
  inputArtifacts: WorkflowArtifact[];
  outputArtifacts: WorkflowArtifact[];
};

export type WorkflowStepExecutorResult = {
  success: boolean;
  error?: string;
  errorCode?: string;
  branchLabel?: string;
  outputArtifacts?: WorkflowArtifact[];
  result?: Record<string, unknown>;
  logs: EngineRunLogEntry[];
};

export const ENGINE_DELEGATED_WORKFLOW_NODE_TYPES = [
  "spec-kit-actions",
  "import-tasks",
  "create-github-issues",
  "agent-orchestrator-implement",
  "open-pr",
  "run-tests",
  "ai-review",
] as const;

export type EngineDelegatedWorkflowNodeType =
  (typeof ENGINE_DELEGATED_WORKFLOW_NODE_TYPES)[number];

export const isEngineDelegatedWorkflowNode = (
  nodeType: string,
): nodeType is EngineDelegatedWorkflowNodeType =>
  (ENGINE_DELEGATED_WORKFLOW_NODE_TYPES as readonly string[]).includes(nodeType);

export const WORKFLOW_STEP_PAYLOAD_KEYS = [
  "workflowRunId",
  "workflowNodeId",
  "nodeType",
  "executor",
  "inputArtifacts",
  "outputArtifacts",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isWorkflowArtifact = (value: unknown): value is WorkflowArtifact =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.path === "string" &&
  typeof value.required === "boolean";

export const parseWorkflowArtifacts = (
  value: unknown,
): WorkflowArtifact[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  if (!value.every(isWorkflowArtifact)) {
    return undefined;
  }

  return value;
};

export const parseWorkflowStepJobPayload = (
  payload: Record<string, unknown>,
): WorkflowStepJobPayload | undefined => {
  if (
    typeof payload.workflowRunId !== "string" ||
    typeof payload.workflowNodeId !== "string" ||
    typeof payload.nodeType !== "string" ||
    !isRecord(payload.executor) ||
    !Array.isArray(payload.inputArtifacts) ||
    !Array.isArray(payload.outputArtifacts)
  ) {
    return undefined;
  }

  if (
    !payload.inputArtifacts.every(isWorkflowArtifact) ||
    !payload.outputArtifacts.every(isWorkflowArtifact)
  ) {
    return undefined;
  }

  return {
    workflowRunId: payload.workflowRunId,
    workflowNodeId: payload.workflowNodeId,
    nodeType: payload.nodeType,
    featureId:
      typeof payload.featureId === "string" ? payload.featureId : undefined,
    executor: payload.executor as ExecutorConfig,
    inputArtifacts: payload.inputArtifacts,
    outputArtifacts: payload.outputArtifacts,
  };
};
