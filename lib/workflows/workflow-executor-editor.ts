import {
  EXECUTOR_BACKENDS,
  withExecutorConfig,
  type ExecutorBackend,
} from "@/lib/engine/loop-engine-types";
import { resolveWorkflowNodeExecutorConfig } from "@/lib/engine/workflow-node-config";
import {
  getWorkflowNodeExecutorMapping,
  workflowNodeTypesWithEngineExecutors,
} from "@/lib/engine/workflow-node-executor-map";
import type { WorkflowNode, WorkflowRunStep } from "@/lib/loopboard";
import {
  isShellCapableWorkflowNode,
  workflowNodeShellWarning,
} from "@/lib/policies/automation-policy";

export const workflowExecutorBackendOptions = (): readonly ExecutorBackend[] =>
  EXECUTOR_BACKENDS;

export const isAutomatableWorkflowNodeType = (nodeType: string): boolean =>
  workflowNodeTypesWithEngineExecutors().includes(
    nodeType as ReturnType<typeof workflowNodeTypesWithEngineExecutors>[number],
  );

export type ExecutorEditorState = {
  automatable: boolean;
  backend: ExecutorBackend;
  argsText: string;
  timeoutMs: string;
  defaultBackend: ExecutorBackend;
};

export const formatExecutorArgs = (args?: string[]): string =>
  (args ?? []).join(", ");

export const parseExecutorArgs = (value: string): string[] =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export const readExecutorEditorState = (
  node: Pick<WorkflowNode, "type" | "config">,
): ExecutorEditorState => {
  const mapping = getWorkflowNodeExecutorMapping(node.type);
  const executor = resolveWorkflowNodeExecutorConfig(node);

  return {
    automatable: isAutomatableWorkflowNodeType(node.type),
    backend: executor.backend,
    argsText: formatExecutorArgs(executor.args),
    timeoutMs:
      executor.timeoutMs !== undefined ? String(executor.timeoutMs) : "",
    defaultBackend: mapping?.defaultBackend ?? "stub",
  };
};

export const applyExecutorEditorPatch = (
  node: Pick<WorkflowNode, "type" | "config">,
  patch: {
    backend?: ExecutorBackend;
    argsText?: string;
    timeoutMs?: string;
  },
): Record<string, unknown> => {
  const current = resolveWorkflowNodeExecutorConfig(node);
  const next = {
    ...current,
    ...(patch.backend !== undefined ? { backend: patch.backend } : {}),
    ...(patch.argsText !== undefined
      ? { args: parseExecutorArgs(patch.argsText) }
      : {}),
    ...(patch.timeoutMs !== undefined
      ? {
          timeoutMs:
            patch.timeoutMs.trim().length === 0
              ? undefined
              : Math.max(1, Number.parseInt(patch.timeoutMs, 10) || 0),
        }
      : {}),
  };

  return withExecutorConfig(node.config, next);
};

export const workflowNodeExecutorPolicyWarnings = (
  node: Pick<WorkflowNode, "type" | "mode" | "requireApproval" | "config">,
): string[] => {
  const warnings: string[] = [];

  if (
    node.mode === "auto" &&
    !node.requireApproval &&
    isShellCapableWorkflowNode(node)
  ) {
    warnings.push(
      `${workflowNodeShellWarning} Auto mode without approval is blocked until approval is enabled or mode is changed.`,
    );
  }

  return warnings;
};

export const extractEngineJobIdFromWorkflowStep = (
  step?: WorkflowRunStep,
): string | undefined => {
  if (!step) {
    return undefined;
  }

  for (const entry of [...step.executionLogs].reverse()) {
    const engineJobId = entry.metadata?.engineJobId;
    if (typeof engineJobId === "string" && engineJobId.trim().length > 0) {
      return engineJobId.trim();
    }
  }

  return undefined;
};
