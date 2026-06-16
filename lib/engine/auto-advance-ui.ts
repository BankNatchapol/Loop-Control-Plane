import type { WorkflowLogEntry, WorkflowNode, WorkflowRun } from "@/lib/loopboard";
import { isWorkflowHardStopNode } from "@/lib/policies/automation-policy";

export type AutoAdvanceStopKind =
  | "requires-approval"
  | "deny"
  | "failed"
  | "human-node"
  | "hard-stop"
  | "disabled"
  | "completed";

export type AutoAdvanceStopReason = {
  code: string;
  message: string;
  kind: AutoAdvanceStopKind;
  workflowRunId?: string;
  nodeId?: string;
  nodeType?: string;
};

const pauseKindFromPolicyCode = (code: string): AutoAdvanceStopKind => {
  if (code.includes("deny") || code.includes("manual_only") || code.includes("disabled")) {
    return "deny";
  }

  if (code.includes("approval") || code.includes("review_gate")) {
    return "requires-approval";
  }

  return "requires-approval";
};

const pauseReasonFromLog = (
  log: WorkflowLogEntry,
  run: WorkflowRun,
  node?: Pick<WorkflowNode, "id" | "type">,
): AutoAdvanceStopReason => {
  const code =
    typeof log.metadata?.policyCode === "string"
      ? log.metadata.policyCode
      : "workflow_auto_advance_paused";

  return {
    code,
    message: log.message,
    kind: pauseKindFromPolicyCode(code),
    workflowRunId: run.id,
    nodeId: typeof log.metadata?.nodeId === "string" ? log.metadata.nodeId : node?.id,
    nodeType: node?.type,
  };
};

export const extractWorkflowRunPauseReason = (
  run: WorkflowRun,
  workflow?: { nodes: WorkflowNode[] },
): AutoAdvanceStopReason | undefined => {
  const currentNode = run.currentNodeId
    ? workflow?.nodes.find((node) => node.id === run.currentNodeId)
    : undefined;

  if (run.status === "failed") {
    const failureLog = [...run.executionLogs]
      .reverse()
      .find((entry) => entry.level === "error");

    return {
      kind: "failed",
      code: "workflow_step_failed",
      message: failureLog?.message ?? "Workflow step failed.",
      workflowRunId: run.id,
      nodeId: currentNode?.id,
      nodeType: currentNode?.type,
    };
  }

  if (run.status === "completed") {
    return {
      kind: "completed",
      code: "workflow_completed",
      message: "Workflow run completed.",
      workflowRunId: run.id,
    };
  }

  if (run.status === "paused") {
    const pauseLog = [...run.executionLogs]
      .reverse()
      .find(
        (entry) =>
          entry.level === "warn" &&
          (entry.metadata?.policyCode || entry.message.includes("paused")),
      );

    if (pauseLog) {
      return pauseReasonFromLog(pauseLog, run, currentNode);
    }

    return {
      kind: "requires-approval",
      code: "workflow_approval_required",
      message: "Workflow paused for operator approval.",
      workflowRunId: run.id,
      nodeId: currentNode?.id,
      nodeType: currentNode?.type,
    };
  }

  if (currentNode && isWorkflowHardStopNode(currentNode)) {
    return {
      kind: "hard-stop",
      code:
        currentNode.type === "merge"
          ? "workflow_merge_manual_only"
          : currentNode.type === "manual-claude-code-edit"
            ? "workflow_manual_edit_required"
            : "workflow_human_node",
      message: `${currentNode.name} requires manual operator action before the workflow can continue.`,
      workflowRunId: run.id,
      nodeId: currentNode.id,
      nodeType: currentNode.type,
    };
  }

  return undefined;
};
