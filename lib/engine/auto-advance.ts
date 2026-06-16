import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import type { EngineJob } from "@/lib/engine/loop-engine-types";
import { parseTaskRunJobPayload } from "@/lib/engine/loop-engine-types";
import type { Project, WorkflowLogEntry, WorkflowNode, WorkflowRun } from "@/lib/loopboard";
import {
  evaluateEnginePolicy,
  isWorkflowHardStopNode,
  WORKFLOW_HARD_STOP_NODE_TYPES,
  type AutomationSettings,
  type WorkflowHardStopNodeType,
} from "@/lib/policies/automation-policy";
import { runNextWorkflowStep } from "@/lib/workflows/workflow-runner";

export type AutoAdvanceTickMode = "automated" | "manual";

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

export type AutoAdvanceResult = {
  action: "advanced" | "stopped" | "skipped";
  workflowRunId?: string;
  enqueuedJob?: boolean;
  pauseReason?: AutoAdvanceStopReason;
};

export { isWorkflowHardStopNode, WORKFLOW_HARD_STOP_NODE_TYPES };
export type { WorkflowHardStopNodeType };

export const isProjectAutoAdvanceEnabled = (
  project: Pick<Project, "engineSettings">,
  automationSettings: AutomationSettings,
): boolean =>
  evaluateEnginePolicy({
    operation: "auto-advance",
    automationSettings,
    engineSettings: project.engineSettings,
  }).kind === "allow";

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

export const resolveWorkflowRunIdForTaskFollowUp = (
  repository: LoopBoardRepository,
  job: EngineJob,
): string | undefined => {
  if (job.workflowRunId) {
    return job.workflowRunId;
  }

  if (!job.taskId) {
    return undefined;
  }

  const payload = parseTaskRunJobPayload(job.payload);
  if (payload?.trigger !== "workflow") {
    return undefined;
  }

  const task = repository.getTask(job.taskId);
  const latestRun = repository.getLatestWorkflowRunForProject(task.projectId);
  if (
    latestRun &&
    latestRun.featureId === task.featureId &&
    latestRun.status === "running"
  ) {
    return latestRun.id;
  }

  return undefined;
};

export const maybeAutoAdvanceWorkflowRun = (
  repository: LoopBoardRepository,
  workflowRunId: string,
  options: { tickMode: AutoAdvanceTickMode; automated?: boolean },
): AutoAdvanceResult => {
  const automated = options.automated ?? options.tickMode === "automated";
  if (!automated) {
    return { action: "skipped" };
  }

  const run = repository.getWorkflowRun(workflowRunId);
  const project = repository.getProject(run.projectId);
  const automationSettings = repository.getAutomationSettings();

  if (!isProjectAutoAdvanceEnabled(project, automationSettings)) {
    const autoAdvancePolicy = evaluateEnginePolicy({
      operation: "auto-advance",
      automationSettings,
      engineSettings: project.engineSettings,
      projectPolicy: project.automationPolicy,
    });

    return {
      action: "skipped",
      pauseReason: {
        kind: "disabled",
        code: autoAdvancePolicy.code,
        message: autoAdvancePolicy.message,
        workflowRunId,
      },
    };
  }

  if (run.status !== "running") {
    return {
      action: "stopped",
      workflowRunId,
      pauseReason: extractWorkflowRunPauseReason(
        run,
        repository.getWorkflow(run.workflowId),
      ),
    };
  }

  const workflow = repository.getWorkflow(run.workflowId);
  const currentNodeId = run.currentNodeId;
  const currentNode = currentNodeId
    ? workflow.nodes.find((node) => node.id === currentNodeId)
    : undefined;

  if (!currentNode) {
    return { action: "skipped", workflowRunId };
  }

  if (isWorkflowHardStopNode(currentNode)) {
    return {
      action: "stopped",
      workflowRunId,
      pauseReason: extractWorkflowRunPauseReason(run, workflow),
    };
  }

  const existingStep = [...run.steps]
    .reverse()
    .find((step) => step.workflowNodeId === currentNode.id);

  if (existingStep?.status === "running") {
    return { action: "skipped", workflowRunId };
  }

  if (existingStep?.status === "waiting-approval") {
    return {
      action: "stopped",
      workflowRunId,
      pauseReason: {
        kind: "requires-approval",
        code: "workflow_approval_required",
        message: "Workflow step is waiting for operator approval.",
        workflowRunId,
        nodeId: currentNode.id,
        nodeType: currentNode.type,
      },
    };
  }

  const updated = runNextWorkflowStep({ repository, runId: workflowRunId });

  if (updated.status === "paused" || updated.status === "failed") {
    return {
      action: "stopped",
      workflowRunId,
      pauseReason: extractWorkflowRunPauseReason(
        updated,
        repository.getWorkflow(updated.workflowId),
      ),
    };
  }

  const advancedNodeId = updated.currentNodeId;
  const advancedNode = advancedNodeId
    ? repository
        .getWorkflow(updated.workflowId)
        .nodes.find((node) => node.id === advancedNodeId)
    : undefined;
  const advancedStep = advancedNodeId
    ? [...updated.steps]
        .reverse()
        .find((step) => step.workflowNodeId === advancedNodeId)
    : undefined;

  if (advancedNode && isWorkflowHardStopNode(advancedNode)) {
    return {
      action: "stopped",
      workflowRunId,
      pauseReason: extractWorkflowRunPauseReason(
        updated,
        repository.getWorkflow(updated.workflowId),
      ),
    };
  }

  return {
    action: "advanced",
    workflowRunId,
    enqueuedJob: advancedStep?.status === "running",
  };
};

export const maybeFollowUpAfterCompletedJob = (
  repository: LoopBoardRepository,
  job: EngineJob,
  options: { tickMode: AutoAdvanceTickMode; success: boolean },
): AutoAdvanceResult => {
  if (!options.success) {
    if (job.kind === "workflow-step" && job.workflowRunId) {
      const run = repository.getWorkflowRun(job.workflowRunId);
      if (run.status === "failed") {
        return {
          action: "stopped",
          workflowRunId: job.workflowRunId,
          pauseReason: extractWorkflowRunPauseReason(
            run,
            repository.getWorkflow(run.workflowId),
          ),
        };
      }
    }

    return { action: "stopped" };
  }

  if (job.kind === "workflow-step" && job.workflowRunId) {
    const run = repository.getWorkflowRun(job.workflowRunId);
    if (run.status !== "running") {
      return {
        action: "stopped",
        workflowRunId: job.workflowRunId,
        pauseReason: extractWorkflowRunPauseReason(
          run,
          repository.getWorkflow(run.workflowId),
        ),
      };
    }

    return maybeAutoAdvanceWorkflowRun(repository, job.workflowRunId, {
      tickMode: options.tickMode,
    });
  }

  if (job.kind === "task-run") {
    const workflowRunId = resolveWorkflowRunIdForTaskFollowUp(repository, job);
    if (!workflowRunId) {
      return { action: "skipped" };
    }

    return maybeAutoAdvanceWorkflowRun(repository, workflowRunId, {
      tickMode: options.tickMode,
    });
  }

  return { action: "skipped" };
};

export const formatAutoAdvancePauseReason = (
  reason: AutoAdvanceStopReason,
): string => reason.message;
