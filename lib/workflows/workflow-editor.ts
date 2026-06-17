import { withExecutorConfig } from "@/lib/engine/loop-engine-types";
import type {
  Workflow,
  WorkflowArtifact,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeMode,
  WorkflowRiskPolicy,
} from "@/lib/loopboard";
import {
  isShellCapableWorkflowNode,
  workflowNodeShellWarning,
} from "@/lib/policies/automation-policy";
import {
  defaultExecutorConfigForNodeType,
  isWorkflowApprovalGateNode,
} from "@/lib/engine/workflow-node-executor-map";

export const workflowNodeTypes = [
  "human-input",
  "human-review",
  "spec-kit-actions",
  "spec-kit-clarify",
  "import-tasks",
  "create-github-issues",
  "agent-orchestrator-implement",
  "run-tests",
  "ai-review",
  "open-pr",
  "merge",
  "manual-claude-code-edit",
  "pr-review-agent",
] as const;

export type WorkflowEditorNodeType = (typeof workflowNodeTypes)[number];

export const workflowNodeModes: WorkflowNodeMode[] = [
  "auto",
  "human",
  "semi",
  "disabled",
];

export const workflowRiskPolicies: WorkflowRiskPolicy[] = [
  "low",
  "medium",
  "high",
  "critical",
  "manual-only",
];

export type WorkflowValidationIssue = {
  code:
    | "empty-graph"
    | "duplicate-node-id"
    | "duplicate-edge-id"
    | "invalid-node-mode"
    | "invalid-risk-policy"
    | "invalid-edge-reference"
    | "disconnected-graph"
    | "unsafe-node-settings";
  message: string;
  nodeId?: string;
  edgeId?: string;
};

type WorkflowValidationNode = Pick<
  WorkflowNode,
  | "id"
  | "type"
  | "name"
  | "mode"
  | "requireApproval"
  | "riskPolicy"
  | "config"
>;

type WorkflowValidationEdge = Pick<
  WorkflowEdge,
  "id" | "sourceNodeId" | "targetNodeId"
>;

export type WorkflowEditorSaveInput = Pick<
  Workflow,
  "name" | "description" | "version" | "nodes" | "edges" | "config"
>;

const catalogNodeConfig = (
  type: WorkflowEditorNodeType,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => {
  if (isWorkflowApprovalGateNode(type)) {
    return extra;
  }

  const defaults = defaultExecutorConfigForNodeType(type);
  if (!defaults) {
    return extra;
  }

  return withExecutorConfig(extra, defaults);
};

export const workflowNodeCatalog: Array<{
  type: WorkflowEditorNodeType;
  name: string;
  mode: WorkflowNodeMode;
  requireApproval: boolean;
  maxRetries: number;
  riskPolicy: WorkflowRiskPolicy;
  inputArtifacts: WorkflowArtifact[];
  outputArtifacts: WorkflowArtifact[];
  config: Record<string, unknown>;
}> = [
  {
    type: "human-input",
    name: "Human Input",
    mode: "human",
    requireApproval: true,
    maxRetries: 0,
    riskPolicy: "manual-only",
    inputArtifacts: [],
    outputArtifacts: [{ name: "feature-brief", path: "specs/{feature}/PRD.md", required: true }],
    config: {},
  },
  {
    type: "human-review",
    name: "Human Review",
    mode: "human",
    requireApproval: true,
    maxRetries: 0,
    riskPolicy: "manual-only",
    inputArtifacts: [
      { name: "spec", path: "specs/{feature}/spec.md", required: true },
      { name: "plan", path: "specs/{feature}/plan.md", required: true },
      { name: "tasks", path: "specs/{feature}/tasks.md", required: true },
    ],
    outputArtifacts: [
      {
        name: "approved-artifacts",
        path: "loopboard://feature/{feature}/approvals",
        required: true,
      },
    ],
    config: {},
  },
  {
    type: "spec-kit-actions",
    name: "Spec Kit Actions",
    mode: "semi",
    requireApproval: true,
    maxRetries: 1,
    riskPolicy: "medium",
    inputArtifacts: [{ name: "feature-brief", path: "specs/{feature}/PRD.md", required: true }],
    outputArtifacts: [
      { name: "spec", path: "specs/{feature}/spec.md", required: true },
      { name: "plan", path: "specs/{feature}/plan.md", required: true },
      { name: "tasks", path: "specs/{feature}/tasks.md", required: true },
    ],
    config: catalogNodeConfig("spec-kit-actions"),
  },
  {
    type: "spec-kit-clarify",
    name: "Spec Kit Clarify",
    mode: "human",
    requireApproval: true,
    maxRetries: 0,
    riskPolicy: "manual-only",
    inputArtifacts: [
      { name: "spec", path: "specs/{feature}/spec.md", required: true },
    ],
    outputArtifacts: [
      { name: "clarified-spec", path: "specs/{feature}/spec.md", required: true },
    ],
    config: {},
  },
  {
    type: "import-tasks",
    name: "Import Tasks",
    mode: "semi",
    requireApproval: true,
    maxRetries: 1,
    riskPolicy: "low",
    inputArtifacts: [{ name: "tasks", path: "specs/{feature}/tasks.md", required: true }],
    outputArtifacts: [
      { name: "loopboard-tasks", path: "loopboard://feature/{feature}/tasks", required: true },
    ],
    config: catalogNodeConfig("import-tasks"),
  },
  {
    type: "create-github-issues",
    name: "Create GitHub Issues",
    mode: "semi",
    requireApproval: true,
    maxRetries: 1,
    riskPolicy: "medium",
    inputArtifacts: [
      { name: "loopboard-tasks", path: "loopboard://feature/{feature}/tasks", required: true },
    ],
    outputArtifacts: [
      { name: "github-issues", path: "https://github.com/{repository}/issues", required: true },
    ],
    config: catalogNodeConfig("create-github-issues"),
  },
  {
    type: "agent-orchestrator-implement",
    name: "Agent Orchestrator Implement",
    mode: "auto",
    requireApproval: false,
    maxRetries: 2,
    riskPolicy: "medium",
    inputArtifacts: [
      { name: "github-issues", path: "https://github.com/{repository}/issues", required: true },
    ],
    outputArtifacts: [
      { name: "implementation-branch", path: "git://{repository}/{branch}", required: true },
    ],
    config: catalogNodeConfig("agent-orchestrator-implement"),
  },
  {
    type: "run-tests",
    name: "Run Tests",
    mode: "auto",
    requireApproval: true,
    maxRetries: 2,
    riskPolicy: "medium",
    inputArtifacts: [
      { name: "implementation-branch", path: "git://{repository}/{branch}", required: true },
    ],
    outputArtifacts: [
      { name: "test-report", path: "loopboard://runs/{run}/test-report", required: true },
    ],
    config: catalogNodeConfig("run-tests", { command: "npm test" }),
  },
  {
    type: "ai-review",
    name: "AI Review",
    mode: "semi",
    requireApproval: true,
    maxRetries: 0,
    riskPolicy: "medium",
    inputArtifacts: [
      { name: "implementation-branch", path: "git://{repository}/{branch}", required: true },
      { name: "test-report", path: "loopboard://runs/{run}/test-report", required: true },
    ],
    outputArtifacts: [
      { name: "review-notes", path: "loopboard://runs/{run}/review-notes", required: true },
    ],
    config: catalogNodeConfig("ai-review"),
  },
  {
    type: "open-pr",
    name: "Open PR",
    mode: "semi",
    requireApproval: true,
    maxRetries: 1,
    riskPolicy: "medium",
    inputArtifacts: [
      { name: "implementation-branch", path: "git://{repository}/{branch}", required: true },
    ],
    outputArtifacts: [
      { name: "pull-request", path: "https://github.com/{repository}/pulls", required: true },
    ],
    config: catalogNodeConfig("open-pr"),
  },
  {
    type: "merge",
    name: "Merge",
    mode: "human",
    requireApproval: true,
    maxRetries: 0,
    riskPolicy: "manual-only",
    inputArtifacts: [
      { name: "pull-request", path: "https://github.com/{repository}/pulls", required: true },
    ],
    outputArtifacts: [
      { name: "merged-branch", path: "git://{repository}/{defaultBranch}", required: true },
    ],
    config: {},
  },
  {
    type: "manual-claude-code-edit",
    name: "Manual Claude Code Edit",
    mode: "human",
    requireApproval: true,
    maxRetries: 0,
    riskPolicy: "manual-only",
    inputArtifacts: [
      { name: "review-notes", path: "loopboard://runs/{run}/review-notes", required: true },
    ],
    outputArtifacts: [
      { name: "manual-patch", path: "git://{repository}/{branch}", required: true },
    ],
    config: { optional: true },
  },
  {
    type: "pr-review-agent",
    name: "PR Review",
    mode: "auto",
    requireApproval: false,
    maxRetries: 1,
    riskPolicy: "medium",
    inputArtifacts: [
      { name: "pull-request", path: "https://github.com/{repository}/pulls", required: true },
    ],
    outputArtifacts: [
      { name: "review-comments", path: "loopboard://runs/{run}/review-comments", required: true },
    ],
    config: catalogNodeConfig("pr-review-agent"),
  },
];

export const createCatalogWorkflowNode = ({
  type,
  workflowId,
  index,
}: {
  type: WorkflowEditorNodeType;
  workflowId: string;
  index: number;
}): Omit<WorkflowNode, "createdAt" | "updatedAt"> => {
  const template = workflowNodeCatalog.find((node) => node.type === type);

  if (!template) {
    throw new Error(`Workflow node type "${type}" is not supported.`);
  }

  return {
    id: `node-${type}-${Date.now().toString(36)}-${index}`,
    workflowId,
    type: template.type,
    name: template.name,
    mode: template.mode,
    position: { x: 120 + index * 180, y: 120 + (index % 3) * 120 },
    inputArtifacts: template.inputArtifacts,
    outputArtifacts: template.outputArtifacts,
    requireApproval: template.requireApproval,
    maxRetries: template.maxRetries,
    riskPolicy: template.riskPolicy,
    config: template.config,
    currentState: "idle",
  };
};

export const validateWorkflowDefinition = (
  workflow: {
    nodes: WorkflowValidationNode[];
    edges: WorkflowValidationEdge[];
  },
): WorkflowValidationIssue[] => {
  const issues: WorkflowValidationIssue[] = [];
  const nodeIds = new Set<string>();
  const duplicateNodeIds = new Set<string>();

  if (workflow.nodes.length === 0) {
    issues.push({
      code: "empty-graph",
      message: "Workflow must include at least one node.",
    });
  }

  for (const node of workflow.nodes) {
    if (nodeIds.has(node.id)) {
      duplicateNodeIds.add(node.id);
    }
    nodeIds.add(node.id);

    if (!workflowNodeModes.includes(node.mode)) {
      issues.push({
        code: "invalid-node-mode",
        message: `Node "${node.name}" uses unsupported mode "${node.mode}".`,
        nodeId: node.id,
      });
    }

    if (!workflowRiskPolicies.includes(node.riskPolicy)) {
      issues.push({
        code: "invalid-risk-policy",
        message: `Node "${node.name}" uses unsupported risk policy "${node.riskPolicy}".`,
        nodeId: node.id,
      });
    }

    if ((node.mode === "human" || node.mode === "semi") && !node.requireApproval) {
      issues.push({
        code: "unsafe-node-settings",
        message: `Node "${node.name}" pauses for people or semi-auto work but approval is disabled.`,
        nodeId: node.id,
      });
    }

    if (
      node.mode === "auto" &&
      !node.requireApproval &&
      (node.riskPolicy === "critical" || node.riskPolicy === "manual-only")
    ) {
      issues.push({
        code: "unsafe-node-settings",
        message: `Node "${node.name}" cannot run automatically with ${node.riskPolicy} risk and no approval.`,
        nodeId: node.id,
      });
    }

    if (node.mode === "auto" && !node.requireApproval && isShellCapableWorkflowNode(node)) {
      issues.push({
        code: "unsafe-node-settings",
        message: `Node "${node.name}" can run shell commands and must require approval before auto mode can run it.`,
        nodeId: node.id,
      });
    }
  }

  for (const nodeId of duplicateNodeIds) {
    issues.push({
      code: "duplicate-node-id",
      message: `Workflow node id "${nodeId}" is duplicated.`,
      nodeId,
    });
  }

  const edgeIds = new Set<string>();
  const duplicateEdgeIds = new Set<string>();
  const connectedNodeIds = new Set<string>();

  for (const edge of workflow.edges) {
    if (edgeIds.has(edge.id)) {
      duplicateEdgeIds.add(edge.id);
    }
    edgeIds.add(edge.id);

    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
      issues.push({
        code: "invalid-edge-reference",
        message: `Edge "${edge.id}" references a missing workflow node.`,
        edgeId: edge.id,
      });
      continue;
    }

    connectedNodeIds.add(edge.sourceNodeId);
    connectedNodeIds.add(edge.targetNodeId);
  }

  for (const edgeId of duplicateEdgeIds) {
    issues.push({
      code: "duplicate-edge-id",
      message: `Workflow edge id "${edgeId}" is duplicated.`,
      edgeId,
    });
  }

  if (workflow.nodes.length > 1) {
    const disconnectedNodes = workflow.nodes.filter(
      (node) => !connectedNodeIds.has(node.id),
    );

    for (const node of disconnectedNodes) {
      issues.push({
        code: "disconnected-graph",
        message: `Node "${node.name}" is not connected to the workflow graph.`,
        nodeId: node.id,
      });
    }
  }

  return issues;
};

export const hasBlockingWorkflowIssues = (
  issues: WorkflowValidationIssue[],
): boolean => issues.length > 0;

export const workflowEdgeId = (
  sourceNodeId: string,
  targetNodeId: string,
): string => `edge-${sourceNodeId}-to-${targetNodeId}`;

export const workflowNodeWarnings = (
  node: Pick<WorkflowNode, "type" | "config">,
): string[] => (isShellCapableWorkflowNode(node) ? [workflowNodeShellWarning] : []);

export const normalizeWorkflowEdge = ({
  workflowId,
  sourceNodeId,
  targetNodeId,
  label = "next",
  dashed,
}: {
  workflowId: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string;
  dashed?: boolean;
}): Omit<WorkflowEdge, "createdAt" | "updatedAt"> => ({
  id: workflowEdgeId(sourceNodeId, targetNodeId),
  workflowId,
  sourceNodeId,
  targetNodeId,
  label,
  ...(dashed ? { dashed: true } : {}),
  condition: {},
});
