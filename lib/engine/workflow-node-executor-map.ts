import type { WorkflowEditorNodeType } from "@/lib/workflows/workflow-editor";
import type { ExecutorBackend, ExecutorConfig } from "@/lib/engine/loop-engine-types";
import { defaultExecutorConfig } from "@/lib/engine/loop-engine-types";

export const WORKFLOW_APPROVAL_GATE_NODE_TYPES = [
  "human-input",
  "human-review",
  "manual-claude-code-edit",
  "merge",
] as const;

export type WorkflowApprovalGateNodeType =
  (typeof WORKFLOW_APPROVAL_GATE_NODE_TYPES)[number];

export type WorkflowNodeExecutorMapping = {
  nodeType: WorkflowEditorNodeType;
  executorModule: string | null;
  defaultBackend: ExecutorBackend;
  defaultExecutor: Omit<ExecutorConfig, "backend">;
  reuseDirectly: readonly string[];
  needsAdapter: readonly string[];
  approvalGate: boolean;
  notes: string;
};

export const isWorkflowApprovalGateNode = (
  nodeType: string,
): nodeType is WorkflowApprovalGateNodeType =>
  (WORKFLOW_APPROVAL_GATE_NODE_TYPES as readonly string[]).includes(nodeType);

export const workflowNodeExecutorMap: Record<
  WorkflowEditorNodeType,
  WorkflowNodeExecutorMapping
> = {
  "human-input": {
    nodeType: "human-input",
    executorModule: null,
    defaultBackend: "stub",
    defaultExecutor: {},
    reuseDirectly: [],
    needsAdapter: [],
    approvalGate: true,
    notes:
      "Approval gate. Captures feature brief / PRD; executor prepares artifact paths only.",
  },
  "human-review": {
    nodeType: "human-review",
    executorModule: null,
    defaultBackend: "stub",
    defaultExecutor: {},
    reuseDirectly: [],
    needsAdapter: [],
    approvalGate: true,
    notes:
      "Approval gate. Operator reviews spec, plan, and tasks before import continues.",
  },
  "spec-kit-actions": {
    nodeType: "spec-kit-actions",
    executorModule: "lib/engine/executors/spec-kit-actions-executor.ts",
    defaultBackend: "stub",
    defaultExecutor: {
      args: ["spec", "plan", "tasks"],
      timeoutMs: 300_000,
    },
    reuseDirectly: ["resolveArtifactPath (workflow-runner.ts)"],
    needsAdapter: [
      "process-runner spec-kit profile",
      "feature placeholder resolution against run.featureId",
      "output file existence verification",
    ],
    approvalGate: false,
    notes: "Invokes Spec Kit CLI to generate spec.md, plan.md, and tasks.md.",
  },
  "import-tasks": {
    nodeType: "import-tasks",
    executorModule: "lib/engine/executors/import-tasks-executor.ts",
    defaultBackend: "stub",
    defaultExecutor: { timeoutMs: 120_000 },
    reuseDirectly: [
      "SpecKitTaskImporter.importFeature",
      "SpecKitTaskImporter.previewFeature",
      "parseSpecKitTasksMarkdown",
    ],
    needsAdapter: [
      "Resolve tasks.md path from input artifacts and feature linkage",
      "Map imported tasks to loopboard:// output artifact references",
    ],
    approvalGate: false,
    notes: "Imports approved Spec Kit tasks into Loop Control Plane task cards.",
  },
  "create-github-issues": {
    nodeType: "create-github-issues",
    executorModule: "lib/engine/executors/create-github-issues-executor.ts",
    defaultBackend: "stub",
    defaultExecutor: { timeoutMs: 120_000 },
    reuseDirectly: [
      "createGitHubIssue",
      "calculateGitHubIssueLabels",
      "renderGitHubIssueBody",
      "evaluateTaskPolicy (create-github-issue operation)",
    ],
    needsAdapter: [
      "Iterate feature-linked tasks and honor project automation policy",
      "Mark GitHub outputs as untrusted artifacts",
    ],
    approvalGate: false,
    notes: "Creates or links GitHub issues for imported feature tasks.",
  },
  "agent-orchestrator-implement": {
    nodeType: "agent-orchestrator-implement",
    executorModule: "lib/engine/executors/agent-orchestrator-implement-executor.ts",
    defaultBackend: "agent-orchestrator",
    defaultExecutor: { timeoutMs: 1_800_000 },
    reuseDirectly: ["TaskContextService.generateTaskContext"],
    needsAdapter: [
      "Agent Orchestrator backend adapter (Phase 04)",
      "Branch naming and implementation artifact linkage",
    ],
    approvalGate: false,
    notes: "Delegates implementation work to the configured agent backend.",
  },
  "run-tests": {
    nodeType: "run-tests",
    executorModule: "lib/engine/executors/run-tests-executor.ts",
    defaultBackend: "stub",
    defaultExecutor: {
      args: ["test"],
      timeoutMs: 600_000,
    },
    reuseDirectly: [],
    needsAdapter: [
      "process-runner npm profile in project repo cwd",
      "Summarized test-report artifact at loopboard://runs/{run}/test-report",
    ],
    approvalGate: false,
    notes: "Runs project test script (default npm test) via audited process-runner.",
  },
  "ai-review": {
    nodeType: "ai-review",
    executorModule: "lib/engine/executors/ai-review-executor.ts",
    defaultBackend: "stub",
    defaultExecutor: { timeoutMs: 600_000 },
    reuseDirectly: ["sanitizeExternalSummary"],
    needsAdapter: [
      "Review backend adapter (cursor, claude-code, or codex)",
      "branchLabel result for conditional edges (approved vs needs changes)",
      "review-notes artifact at loopboard://runs/{run}/review-notes",
    ],
    approvalGate: false,
    notes:
      "Invokes configured review backend; Phase 03 ships a stub summarizing diff and test report paths.",
  },
  "open-pr": {
    nodeType: "open-pr",
    executorModule: "lib/engine/executors/open-pr-executor.ts",
    defaultBackend: "stub",
    defaultExecutor: { timeoutMs: 120_000 },
    reuseDirectly: [
      "syncGitHubPullRequest",
      "parseGitHubPullRequestNumber",
    ],
    needsAdapter: [
      "gh pr create via process-runner when PR helpers are unavailable",
      "Pull request artifact linkage for downstream merge gate",
    ],
    approvalGate: false,
    notes: "Discovers or creates a pull request for the implementation branch.",
  },
  merge: {
    nodeType: "merge",
    executorModule: null,
    defaultBackend: "stub",
    defaultExecutor: {},
    reuseDirectly: [],
    needsAdapter: [],
    approvalGate: true,
    notes: "Approval gate. Merge remains operator-controlled; no automated merge.",
  },
  "pr-review-agent": {
    nodeType: "pr-review-agent",
    executorModule: "lib/engine/executors/pr-review-executor.ts",
    defaultBackend: "claude-code",
    defaultExecutor: { timeoutMs: 300_000 },
    reuseDirectly: [],
    needsAdapter: [
      "pr-agent CLI on PATH (`npm install -g @pr-agent/pr-agent` or equivalent)",
      "pull-request input artifact with GitHub PR URL from upstream AO or open-pr node",
      "GitHub token for posting review comments",
    ],
    approvalGate: false,
    notes: "Runs PR Agent to review an open PR and post review comments to GitHub. Backend selects which LLM pr-agent uses.",
  },
  "manual-claude-code-edit": {
    nodeType: "manual-claude-code-edit",
    executorModule: null,
    defaultBackend: "claude-code",
    defaultExecutor: {},
    reuseDirectly: ["TaskContextService.generateClaudeCodePrompt"],
    needsAdapter: ["Optional context preparation only; human drives Claude Code session"],
    approvalGate: true,
    notes:
      "Approval gate on the needs-changes branch. Prepares review context; human applies edits.",
  },
};

export const getWorkflowNodeExecutorMapping = (
  nodeType: string,
): WorkflowNodeExecutorMapping | undefined =>
  workflowNodeExecutorMap[nodeType as WorkflowEditorNodeType];

export const defaultExecutorConfigForNodeType = (
  nodeType: string,
): ExecutorConfig | undefined => {
  const mapping = getWorkflowNodeExecutorMapping(nodeType);
  if (!mapping) {
    return undefined;
  }

  return {
    ...defaultExecutorConfig(mapping.defaultBackend),
    ...mapping.defaultExecutor,
  };
};

export const workflowNodeTypesWithEngineExecutors = (): WorkflowEditorNodeType[] =>
  (Object.values(workflowNodeExecutorMap) as WorkflowNodeExecutorMapping[])
    .filter((mapping) => mapping.executorModule !== null)
    .map((mapping) => mapping.nodeType);
