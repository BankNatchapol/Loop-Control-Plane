export const KANBAN_COLUMNS = [
  { id: "backlog", label: "Backlog" },
  { id: "spec-review", label: "Spec Review" },
  { id: "plan-review", label: "Plan Review" },
  { id: "ready", label: "Ready" },
  { id: "ai-running", label: "AI Running" },
  { id: "human-working", label: "Human Working" },
  { id: "needs-review", label: "Needs Review" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
] as const;

export type KanbanStatus = (typeof KANBAN_COLUMNS)[number]["id"];

export type TaskOwner = "unassigned" | "ai" | "human" | "pairing";
export type TaskMode = "spec" | "plan" | "execute" | "review" | "handoff";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type TaskSource = "spec-kit" | "github" | "manual" | "playbook";
export type WorkflowNodeMode = "auto" | "human" | "semi" | "disabled";
export type WorkflowRiskPolicy = "low" | "medium" | "high" | "critical" | "manual-only";
export type WorkflowNodeState =
  | "idle"
  | "ready"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "skipped";
export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
export type WorkflowRunStepStatus =
  | "pending"
  | "running"
  | "waiting-approval"
  | "completed"
  | "failed"
  | "skipped";
export type FeatureStatus =
  | "prd-draft"
  | "spec-review"
  | "spec-approved"
  | "plan-review"
  | "plan-approved"
  | "tasks-ready"
  | "in-execution"
  | "done";

export type FeatureArtifactName =
  | "prd"
  | "spec"
  | "plan"
  | "tasks"
  | "decisions";

export type FeatureApprovalArtifactName = "spec" | "plan" | "tasks";

export type FeatureEventType =
  | "SPEC_APPROVED"
  | "PLAN_APPROVED"
  | "TASKS_APPROVED"
  | "WORKFLOW_RUN_STARTED"
  | "WORKFLOW_STEP_COMPLETED";

export interface FeatureArtifactState {
  name: FeatureArtifactName;
  fileName: "PRD.md" | "spec.md" | "plan.md" | "tasks.md" | "decisions.md";
  path: string;
  exists: boolean;
  approved: boolean;
}

export type FeatureArtifactStatus = Record<
  FeatureArtifactName,
  FeatureArtifactState
>;

export type TaskEventType =
  | "TASK_CREATED"
  | "TASK_IMPORTED"
  | "TASK_MOVED"
  | "OWNER_CHANGED"
  | "ASSIGNED_TO_AI"
  | "AI_ASSIGNED"
  | "AI_PAUSED"
  | "HUMAN_TAKEOVER"
  | "HUMAN_CLAIMED"
  | "ASSIGNED_TO_HUMAN"
  | "RETURNED_TO_AI"
  | "BLOCKED"
  | "UNBLOCKED"
  | "MARKED_DONE"
  | "GITHUB_LINKED"
  | "ISSUE_CREATED"
  | "ISSUE_LABELS_SYNCED"
  | "PR_OPENED"
  | "CI_RUNNING"
  | "CI_FAILED"
  | "CI_PASSED"
  | "REVIEW_REQUESTED"
  | "REVIEW_CHANGES_REQUESTED"
  | "REVIEW_APPROVED"
  | "DONE"
  | "AO_READY_APPROVED"
  | "HANDOFF_READY"
  | "WORKFLOW_STEP_COMPLETED"
  | "ENGINE_PICKUP"
  | "ENGINE_PICKUP_SKIPPED"
  | "ENGINE_TASK_COMPLETED"
  | "ENGINE_TASK_FAILED";

export type TaskAction =
  | "assign-ai"
  | "approve-ao-ready"
  | "mark-ao-ready"
  | "remove-ao-ready"
  | "claim-human"
  | "pause-ai"
  | "return-ai"
  | "mark-blocked"
  | "mark-done";

export interface Project {
  id: string;
  name: string;
  description: string;
  repository: string;
  repoPath: string;
  isGitRepository: boolean;
  currentBranch: string;
  defaultBranch: string;
  githubRemoteUrl: string;
  githubRepository: string;
  specKitRoot: string;
  specsPath: string;
  tasksPath: string;
  workflowsPath: string;
  handoffsPath: string;
  automationPolicy: ProjectAutomationPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectAutomationPolicy {
  allowLowRiskAutoIssueCreation: boolean;
  allowLowRiskAutoAoReadyLabeling: boolean;
  mediumRiskRequiresReview: boolean;
  highRiskManualOnly: boolean;
}

export const defaultProjectAutomationPolicy: ProjectAutomationPolicy = {
  allowLowRiskAutoIssueCreation: true,
  allowLowRiskAutoAoReadyLabeling: true,
  mediumRiskRequiresReview: true,
  highRiskManualOnly: true,
};

export interface WorkflowArtifact {
  name: string;
  path: string;
  required: boolean;
  description?: string;
}

export interface WorkflowLogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export type WorkflowNodeExecutorSettings = {
  backend: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  /** @deprecated Prefer nested `executor.args` instead of top-level command strings. */
  command?: string;
  /** @deprecated Prefer `executor.cwd` instead. */
  workingDirectory?: string;
};

export type WorkflowNodeConfig = Record<string, unknown> & {
  executor?: WorkflowNodeExecutorSettings;
  command?: string;
  commands?: string[];
  optional?: boolean;
};

export interface WorkflowNode {
  id: string;
  workflowId: string;
  type: string;
  name: string;
  mode: WorkflowNodeMode;
  position: {
    x: number;
    y: number;
  };
  inputArtifacts: WorkflowArtifact[];
  outputArtifacts: WorkflowArtifact[];
  requireApproval: boolean;
  maxRetries: number;
  riskPolicy: WorkflowRiskPolicy;
  config: WorkflowNodeConfig;
  currentState: WorkflowNodeState;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowEdge {
  id: string;
  workflowId: string;
  sourceNodeId: string;
  targetNodeId: string;
  label: string;
  condition: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Workflow {
  id: string;
  projectId: string;
  name: string;
  description: string;
  version: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  projectId: string;
  featureId?: string;
  status: WorkflowRunStatus;
  currentNodeId?: string;
  inputArtifacts: WorkflowArtifact[];
  outputArtifacts: WorkflowArtifact[];
  executionLogs: WorkflowLogEntry[];
  steps: WorkflowRunStep[];
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunStep {
  id: string;
  runId: string;
  workflowNodeId: string;
  status: WorkflowRunStepStatus;
  attempt: number;
  inputArtifacts: WorkflowArtifact[];
  outputArtifacts: WorkflowArtifact[];
  executionLogs: WorkflowLogEntry[];
  error?: string;
  requireApproval: boolean;
  approvedAt?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Feature {
  id: string;
  projectId: string;
  name: string;
  summary: string;
  source: TaskSource;
  artifactFolderPath: string;
  prdPath: string;
  specPath: string;
  planPath: string;
  tasksPath: string;
  decisionsPath: string;
  status: FeatureStatus;
  artifacts: FeatureArtifactStatus;
  events: FeatureEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface FeatureEvent {
  id: string;
  featureId: string;
  type: FeatureEventType;
  actor: "system" | "ai" | "human";
  message: string;
  createdAt: string;
  fromStatus?: FeatureStatus;
  toStatus?: FeatureStatus;
  metadata?: Record<string, string | number | boolean | null>;
}

export type PullRequestState = "draft" | "open" | "merged" | "closed";
export type CiStatus = "not-started" | "pending" | "passing" | "failing";
export type ReviewStatus =
  | "not-requested"
  | "requested"
  | "changes-requested"
  | "approved";
export type MergeStatus = "unknown" | "mergeable" | "conflicting" | "merged";
export type GitHubDeliveryStatus =
  | "no-pr"
  | "pr-opened"
  | "ci-running"
  | "ci-failed"
  | "ci-passed"
  | "review-requested"
  | "changes-requested"
  | "approved"
  | "merged"
  | "closed";

export interface GitHubState {
  issueNumber?: number;
  issueUrl?: string;
  issueState?: "open" | "closed";
  issueLabels?: string[];
  issueLastSyncedAt?: string;
  aoReadyApprovedAt?: string;
  aoReadyApprovalReason?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  pullRequestBranch?: string;
  pullRequestState?: PullRequestState;
  mergeStatus?: MergeStatus;
  ciStatus?: CiStatus;
  reviewStatus?: ReviewStatus;
  reviewUrl?: string;
  deliveryStatus?: GitHubDeliveryStatus;
  prCiLastSyncedAt?: string;
  ciFailureSummary?: string;
}

export interface HandoffState {
  available: boolean;
  summary?: string;
  nextAction?: string;
  contextPaths: string[];
}

export interface Task {
  id: string;
  projectId: string;
  featureId: string;
  title: string;
  description: string;
  status: KanbanStatus;
  owner: TaskOwner;
  mode: TaskMode;
  risk: RiskLevel;
  source: TaskSource;
  labels: string[];
  acceptanceCriteria: string[];
  branch: string;
  worktree: string;
  github: GitHubState;
  handoff: HandoffState;
  events: TaskEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  type: TaskEventType;
  actor: "system" | "ai" | "human";
  message: string;
  createdAt: string;
  fromStatus?: KanbanStatus;
  toStatus?: KanbanStatus;
  fromOwner?: TaskOwner;
  toOwner?: TaskOwner;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface PersistedBoardState {
  version: 1;
  tasks: Task[];
  selectedTaskId: string;
  savedAt: string;
}

export interface BoardState {
  tasks: Task[];
  selectedTaskId: string;
}

export const STATUS_LABELS: Record<KanbanStatus, string> = Object.fromEntries(
  KANBAN_COLUMNS.map((column) => [column.id, column.label]),
) as Record<KanbanStatus, string>;

export const RISK_STYLES: Record<RiskLevel, string> = {
  low: "border-emerald-200 bg-emerald-50 text-emerald-800",
  medium: "border-amber-200 bg-amber-50 text-amber-800",
  high: "border-orange-200 bg-orange-50 text-orange-800",
  critical: "border-red-200 bg-red-50 text-red-800",
};

export const OWNER_TRANSITIONS: Record<TaskOwner, TaskOwner[]> = {
  unassigned: ["ai", "human"],
  ai: ["human", "pairing", "unassigned"],
  human: ["ai", "pairing", "unassigned"],
  pairing: ["ai", "human", "unassigned"],
};

export const FEATURE_STATUS_LABELS: Record<FeatureStatus, string> = {
  "prd-draft": "PRD Draft",
  "spec-review": "Spec Review",
  "spec-approved": "Spec Approved",
  "plan-review": "Plan Review",
  "plan-approved": "Plan Approved",
  "tasks-ready": "Tasks Ready",
  "in-execution": "In Execution",
  done: "Done",
};

export const FEATURE_ARTIFACT_FILES: Record<
  FeatureArtifactName,
  FeatureArtifactState["fileName"]
> = {
  prd: "PRD.md",
  spec: "spec.md",
  plan: "plan.md",
  tasks: "tasks.md",
  decisions: "decisions.md",
};

export const emptyFeatureArtifacts = (
  paths: Partial<Record<FeatureArtifactName, string>> = {},
): FeatureArtifactStatus =>
  Object.fromEntries(
    (Object.keys(FEATURE_ARTIFACT_FILES) as FeatureArtifactName[]).map((name) => [
      name,
      {
        name,
        fileName: FEATURE_ARTIFACT_FILES[name],
        path: paths[name] ?? "",
        exists: false,
        approved: false,
      },
    ]),
  ) as FeatureArtifactStatus;

const BASE_TIMESTAMP = "2026-06-14T02:00:00.000Z";

export const seedProject: Project = {
  id: "project-loopboard",
  name: "Loop Control Plane MVP",
  description:
    "Local control plane for supervising AI coding loops, handoffs, and review flow.",
  repository: "bank-p/loop-control-plane",
  repoPath: process.cwd(),
  isGitRepository: false,
  currentBranch: "",
  defaultBranch: "main",
  githubRemoteUrl: "",
  githubRepository: "bank-p/loop-control-plane",
  specKitRoot: "specs/loopboard-mvp",
  specsPath: "specs",
  tasksPath: "tasks",
  workflowsPath: "workflows",
  handoffsPath: "handoffs",
  automationPolicy: defaultProjectAutomationPolicy,
  createdAt: BASE_TIMESTAMP,
  updatedAt: "2026-06-14T03:30:00.000Z",
};

const seedWorkflowTimestamp = "2026-06-14T03:35:00.000Z";

const workflowArtifact = (
  name: string,
  path: string,
  required = true,
  description?: string,
): WorkflowArtifact => ({
  name,
  path,
  required,
  ...(description === undefined ? {} : { description }),
});

const seedWorkflowNode = (
  id: string,
  type: string,
  name: string,
  mode: WorkflowNodeMode,
  position: WorkflowNode["position"],
  inputArtifacts: WorkflowArtifact[],
  outputArtifacts: WorkflowArtifact[],
  overrides: Partial<
    Pick<
      WorkflowNode,
      "requireApproval" | "maxRetries" | "riskPolicy" | "config" | "currentState"
    >
  > = {},
): WorkflowNode => ({
  id,
  workflowId: "workflow-feature-development-loop",
  type,
  name,
  mode,
  position,
  inputArtifacts,
  outputArtifacts,
  requireApproval:
    overrides.requireApproval ?? (mode === "human" || mode === "semi"),
  maxRetries: overrides.maxRetries ?? (mode === "auto" ? 2 : 0),
  riskPolicy: overrides.riskPolicy ?? (mode === "auto" ? "medium" : "manual-only"),
  config: overrides.config ?? {},
  currentState: overrides.currentState ?? "idle",
  createdAt: seedWorkflowTimestamp,
  updatedAt: seedWorkflowTimestamp,
});

const seedWorkflowEdge = (
  sourceNodeId: string,
  targetNodeId: string,
  label = "next",
): WorkflowEdge => ({
  id: `edge-${sourceNodeId}-to-${targetNodeId}`,
  workflowId: "workflow-feature-development-loop",
  sourceNodeId,
  targetNodeId,
  label,
  condition: {},
  createdAt: seedWorkflowTimestamp,
  updatedAt: seedWorkflowTimestamp,
});

export const seedWorkflows: Workflow[] = [
  {
    id: "workflow-feature-development-loop",
    projectId: seedProject.id,
    name: "Feature Development Loop",
    description:
      "PRD-aligned feature workflow from human intake through Spec Kit artifacts, task import, AI implementation, review, pull request, and merge.",
    version: 1,
    nodes: [
      seedWorkflowNode(
        "node-human-input",
        "human-input",
        "Human Input",
        "human",
        { x: 0, y: 120 },
        [],
        [workflowArtifact("feature-brief", "specs/{feature}/PRD.md")],
      ),
      seedWorkflowNode(
        "node-spec-kit-actions",
        "spec-kit-actions",
        "Spec Kit Actions",
        "semi",
        { x: 260, y: 120 },
        [workflowArtifact("feature-brief", "specs/{feature}/PRD.md")],
        [
          workflowArtifact("spec", "specs/{feature}/spec.md"),
          workflowArtifact("plan", "specs/{feature}/plan.md"),
          workflowArtifact("tasks", "specs/{feature}/tasks.md"),
        ],
        { maxRetries: 1, riskPolicy: "medium" },
      ),
      seedWorkflowNode(
        "node-human-review",
        "human-review",
        "Human Review",
        "human",
        { x: 520, y: 120 },
        [
          workflowArtifact("spec", "specs/{feature}/spec.md"),
          workflowArtifact("plan", "specs/{feature}/plan.md"),
          workflowArtifact("tasks", "specs/{feature}/tasks.md"),
        ],
        [workflowArtifact("approved-artifacts", "loopboard://feature/{feature}/approvals")],
      ),
      seedWorkflowNode(
        "node-import-tasks",
        "import-tasks",
        "Import Tasks",
        "semi",
        { x: 780, y: 120 },
        [workflowArtifact("tasks", "specs/{feature}/tasks.md")],
        [workflowArtifact("loopboard-tasks", "loopboard://feature/{feature}/tasks")],
        { maxRetries: 1, riskPolicy: "low" },
      ),
      seedWorkflowNode(
        "node-create-github-issues",
        "create-github-issues",
        "Create GitHub Issues",
        "semi",
        { x: 1040, y: 120 },
        [workflowArtifact("loopboard-tasks", "loopboard://feature/{feature}/tasks")],
        [workflowArtifact("github-issues", "https://github.com/{repository}/issues")],
        { maxRetries: 1, riskPolicy: "medium" },
      ),
      seedWorkflowNode(
        "node-agent-orchestrator-implement",
        "agent-orchestrator-implement",
        "Agent Orchestrator Implement",
        "auto",
        { x: 1300, y: 120 },
        [workflowArtifact("github-issues", "https://github.com/{repository}/issues")],
        [workflowArtifact("implementation-branch", "git://{repository}/{branch}")],
        { riskPolicy: "medium" },
      ),
      seedWorkflowNode(
        "node-run-tests",
        "run-tests",
        "Run Tests",
        "auto",
        { x: 1560, y: 120 },
        [workflowArtifact("implementation-branch", "git://{repository}/{branch}")],
        [workflowArtifact("test-report", "loopboard://runs/{run}/test-report")],
        { maxRetries: 2, requireApproval: true, riskPolicy: "medium" },
      ),
      seedWorkflowNode(
        "node-ai-review",
        "ai-review",
        "AI Review",
        "semi",
        { x: 1820, y: 120 },
        [
          workflowArtifact("implementation-branch", "git://{repository}/{branch}"),
          workflowArtifact("test-report", "loopboard://runs/{run}/test-report"),
        ],
        [workflowArtifact("review-notes", "loopboard://runs/{run}/review-notes")],
        { riskPolicy: "medium" },
      ),
      seedWorkflowNode(
        "node-manual-claude-code-edit",
        "manual-claude-code-edit",
        "Manual Claude Code Edit",
        "human",
        { x: 1820, y: 320 },
        [workflowArtifact("review-notes", "loopboard://runs/{run}/review-notes")],
        [workflowArtifact("manual-patch", "git://{repository}/{branch}")],
        { config: { optional: true } },
      ),
      seedWorkflowNode(
        "node-open-pr",
        "open-pr",
        "Open PR",
        "semi",
        { x: 2080, y: 120 },
        [workflowArtifact("implementation-branch", "git://{repository}/{branch}")],
        [workflowArtifact("pull-request", "https://github.com/{repository}/pulls")],
        { maxRetries: 1, riskPolicy: "medium" },
      ),
      seedWorkflowNode(
        "node-merge",
        "merge",
        "Merge",
        "human",
        { x: 2340, y: 120 },
        [workflowArtifact("pull-request", "https://github.com/{repository}/pulls")],
        [workflowArtifact("merged-branch", "git://{repository}/{defaultBranch}")],
        { riskPolicy: "manual-only" },
      ),
    ],
    edges: [
      seedWorkflowEdge("node-human-input", "node-spec-kit-actions"),
      seedWorkflowEdge("node-spec-kit-actions", "node-human-review"),
      seedWorkflowEdge("node-human-review", "node-import-tasks"),
      seedWorkflowEdge("node-import-tasks", "node-create-github-issues"),
      seedWorkflowEdge("node-create-github-issues", "node-agent-orchestrator-implement"),
      seedWorkflowEdge("node-agent-orchestrator-implement", "node-run-tests"),
      seedWorkflowEdge("node-run-tests", "node-ai-review"),
      seedWorkflowEdge("node-ai-review", "node-open-pr", "approved"),
      seedWorkflowEdge("node-ai-review", "node-manual-claude-code-edit", "needs changes"),
      seedWorkflowEdge("node-manual-claude-code-edit", "node-run-tests", "retry"),
      seedWorkflowEdge("node-open-pr", "node-merge"),
    ],
    config: {
      defaultFeatureId: "feature-kanban-control-plane",
      pauseOnHumanNodes: true,
      redactSecretsInLogs: true,
    },
    createdAt: seedWorkflowTimestamp,
    updatedAt: seedWorkflowTimestamp,
  },
];

export const seedFeatures: Feature[] = [
  {
    id: "feature-kanban-control-plane",
    projectId: seedProject.id,
    name: "Kanban Control Plane",
    summary:
      "Visualize AI and human execution work across PRD-defined workflow states.",
    source: "spec-kit",
    artifactFolderPath: "specs/loopboard-mvp/kanban-control-plane",
    prdPath: "specs/loopboard-mvp/kanban-control-plane/PRD.md",
    specPath: "specs/loopboard-mvp/kanban-control-plane/spec.md",
    planPath: "specs/loopboard-mvp/kanban-control-plane/plan.md",
    tasksPath: "specs/loopboard-mvp/kanban-control-plane/tasks.md",
    decisionsPath: "specs/loopboard-mvp/kanban-control-plane/decisions.md",
    status: "in-execution",
    artifacts: emptyFeatureArtifacts({
      prd: "specs/loopboard-mvp/kanban-control-plane/PRD.md",
      spec: "specs/loopboard-mvp/kanban-control-plane/spec.md",
      plan: "specs/loopboard-mvp/kanban-control-plane/plan.md",
      tasks: "specs/loopboard-mvp/kanban-control-plane/tasks.md",
      decisions: "specs/loopboard-mvp/kanban-control-plane/decisions.md",
    }),
    events: [],
    createdAt: "2026-06-14T02:05:00.000Z",
    updatedAt: "2026-06-14T03:30:00.000Z",
  },
  {
    id: "feature-github-bridge",
    projectId: seedProject.id,
    name: "GitHub Issue and PR Bridge",
    summary:
      "Mirror issue, pull request, CI, and review signals into local task cards.",
    source: "github",
    artifactFolderPath: "specs/loopboard-mvp/github-bridge",
    prdPath: "specs/loopboard-mvp/github-bridge/PRD.md",
    specPath: "specs/loopboard-mvp/github-bridge/spec.md",
    planPath: "specs/loopboard-mvp/github-bridge/plan.md",
    tasksPath: "specs/loopboard-mvp/github-bridge/tasks.md",
    decisionsPath: "specs/loopboard-mvp/github-bridge/decisions.md",
    status: "prd-draft",
    artifacts: emptyFeatureArtifacts({
      prd: "specs/loopboard-mvp/github-bridge/PRD.md",
      spec: "specs/loopboard-mvp/github-bridge/spec.md",
      plan: "specs/loopboard-mvp/github-bridge/plan.md",
      tasks: "specs/loopboard-mvp/github-bridge/tasks.md",
      decisions: "specs/loopboard-mvp/github-bridge/decisions.md",
    }),
    events: [],
    createdAt: "2026-06-14T02:10:00.000Z",
    updatedAt: "2026-06-14T03:05:00.000Z",
  },
  {
    id: "feature-human-takeover",
    projectId: seedProject.id,
    name: "Human Takeover and Handoff",
    summary:
      "Allow a person to claim, pause, resume, and inspect AI coding loop context.",
    source: "playbook",
    artifactFolderPath: "specs/loopboard-mvp/human-takeover",
    prdPath: "specs/loopboard-mvp/human-takeover/PRD.md",
    specPath: "specs/loopboard-mvp/human-takeover/spec.md",
    planPath: "specs/loopboard-mvp/human-takeover/plan.md",
    tasksPath: "specs/loopboard-mvp/human-takeover/tasks.md",
    decisionsPath: "specs/loopboard-mvp/human-takeover/decisions.md",
    status: "spec-approved",
    artifacts: emptyFeatureArtifacts({
      prd: "specs/loopboard-mvp/human-takeover/PRD.md",
      spec: "specs/loopboard-mvp/human-takeover/spec.md",
      plan: "specs/loopboard-mvp/human-takeover/plan.md",
      tasks: "specs/loopboard-mvp/human-takeover/tasks.md",
      decisions: "specs/loopboard-mvp/human-takeover/decisions.md",
    }),
    events: [],
    createdAt: "2026-06-14T02:15:00.000Z",
    updatedAt: "2026-06-14T03:20:00.000Z",
  },
];

export const statusLabel = (status: KanbanStatus): string =>
  STATUS_LABELS[status];

export const featureStatusLabel = (status: FeatureStatus): string =>
  FEATURE_STATUS_LABELS[status];

export const featureArtifactCompleteness = (feature: Feature): {
  existing: number;
  total: number;
  approved: number;
} => {
  const artifacts = Object.values(feature.artifacts);

  return {
    existing: artifacts.filter((artifact) => artifact.exists).length,
    total: artifacts.length,
    approved: artifacts.filter((artifact) => artifact.approved).length,
  };
};

export const riskStyle = (risk: RiskLevel): string => RISK_STYLES[risk];

export const canTransitionOwner = (
  fromOwner: TaskOwner,
  toOwner: TaskOwner,
): boolean => OWNER_TRANSITIONS[fromOwner].includes(toOwner);

export const createTaskEvent = ({
  taskId,
  type,
  actor,
  message,
  createdAt = new Date().toISOString(),
  fromStatus,
  toStatus,
  fromOwner,
  toOwner,
  metadata,
}: Omit<TaskEvent, "id"> & { id?: never }): TaskEvent => ({
  id: `${taskId}-${type.toLowerCase().replaceAll("_", "-")}-${createdAt}`,
  taskId,
  type,
  actor,
  message,
  createdAt,
  fromStatus,
  toStatus,
  fromOwner,
  toOwner,
  metadata,
});

export const normalizeGitHubDeliveryStatus = (
  github: GitHubState,
): GitHubDeliveryStatus => {
  if (github.pullRequestState === "merged" || github.mergeStatus === "merged") {
    return "merged";
  }

  if (github.pullRequestState === "closed") {
    return "closed";
  }

  if (!github.pullRequestNumber && !github.pullRequestUrl) {
    return "no-pr";
  }

  if (github.reviewStatus === "changes-requested") {
    return "changes-requested";
  }

  if (github.reviewStatus === "approved") {
    return "approved";
  }

  if (github.reviewStatus === "requested") {
    return "review-requested";
  }

  if (github.ciStatus === "failing") {
    return "ci-failed";
  }

  if (github.ciStatus === "pending") {
    return "ci-running";
  }

  if (github.ciStatus === "passing") {
    return "ci-passed";
  }

  return "pr-opened";
};

export const createFeatureEvent = ({
  featureId,
  type,
  actor,
  message,
  createdAt = new Date().toISOString(),
  fromStatus,
  toStatus,
  metadata,
}: Omit<FeatureEvent, "id"> & { id?: never }): FeatureEvent => ({
  id: `${featureId}-${type.toLowerCase().replaceAll("_", "-")}-${createdAt}`,
  featureId,
  type,
  actor,
  message,
  createdAt,
  fromStatus,
  toStatus,
  metadata,
});

export const formatTimestamp = (
  timestamp: string,
  locale = "en-US",
): string =>
  new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));

const event = (
  taskId: string,
  type: TaskEventType,
  message: string,
  createdAt: string,
  extras: Partial<Omit<TaskEvent, "id" | "taskId" | "type" | "message" | "createdAt">> = {},
): TaskEvent =>
  createTaskEvent({
    taskId,
    type,
    actor: "system",
    message,
    createdAt,
    ...extras,
  });

export const seedTasks: Task[] = [
  {
    id: "task-import-spec-kit-board",
    projectId: seedProject.id,
    featureId: "feature-kanban-control-plane",
    title: "Import Spec Kit tasks into Loop Control Plane",
    description:
      "Parse the approved Spec Kit plan and turn each implementation step into trackable local board cards.",
    status: "spec-review",
    owner: "human",
    mode: "spec",
    risk: "medium",
    source: "spec-kit",
    labels: ["spec-kit", "importer", "needs-schema-review"],
    acceptanceCriteria: [
      "Importer preserves source spec, plan, and task path references.",
      "Generated task cards include feature, owner, risk, and acceptance criteria.",
      "Invalid or partial Spec Kit documents produce recoverable validation errors.",
    ],
    branch: "feature/spec-kit-importer",
    worktree: "../worktrees/spec-kit-importer",
    github: {
      issueNumber: 18,
      issueUrl: "https://github.com/bank-p/loop-control-plane/issues/18",
      issueState: "open",
      ciStatus: "not-started",
      reviewStatus: "not-requested",
    },
    handoff: {
      available: true,
      summary:
        "Schema questions are isolated to importer metadata and source path handling.",
      nextAction: "Approve the imported field mapping before AI execution.",
      contextPaths: [
        "specs/loopboard-mvp/spec-kit-importer/spec.md",
        "specs/loopboard-mvp/spec-kit-importer/plan.md",
      ],
    },
    events: [
      event(
        "task-import-spec-kit-board",
        "TASK_IMPORTED",
        "Imported from Spec Kit plan for review.",
        "2026-06-14T02:20:00.000Z",
      ),
    ],
    createdAt: "2026-06-14T02:20:00.000Z",
    updatedAt: "2026-06-14T02:45:00.000Z",
  },
  {
    id: "task-ai-board-dragging",
    projectId: seedProject.id,
    featureId: "feature-kanban-control-plane",
    title: "Implement draggable board state",
    description:
      "Use local state and dnd-kit to move task cards between PRD workflow columns without backend dependencies.",
    status: "ai-running",
    owner: "ai",
    mode: "execute",
    risk: "high",
    source: "playbook",
    labels: ["ai-assigned", "frontend", "dnd-kit"],
    acceptanceCriteria: [
      "Cards drag between all default columns.",
      "Each status change appends a TASK_MOVED event.",
      "Drag interactions remain keyboard accessible enough for the prototype.",
    ],
    branch: "ai/kanban-drag-state",
    worktree: "../worktrees/kanban-drag-state",
    github: {
      issueNumber: 21,
      issueUrl: "https://github.com/bank-p/loop-control-plane/issues/21",
      issueState: "open",
      pullRequestNumber: 24,
      pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/24",
      pullRequestState: "draft",
      ciStatus: "pending",
      reviewStatus: "not-requested",
    },
    handoff: {
      available: true,
      summary:
        "AI has wired sensors and optimistic state; collision behavior needs human review.",
      nextAction: "Inspect drag edge cases before requesting review.",
      contextPaths: ["app/page.tsx", "components/board/task-board.tsx"],
    },
    events: [
      event(
        "task-ai-board-dragging",
        "AI_ASSIGNED",
        "Assigned to AI coding loop.",
        "2026-06-14T02:55:00.000Z",
        { actor: "human", fromOwner: "unassigned", toOwner: "ai" },
      ),
      event(
        "task-ai-board-dragging",
        "TASK_MOVED",
        "Moved from Ready to AI Running.",
        "2026-06-14T03:00:00.000Z",
        { fromStatus: "ready", toStatus: "ai-running" },
      ),
    ],
    createdAt: "2026-06-14T02:50:00.000Z",
    updatedAt: "2026-06-14T03:00:00.000Z",
  },
  {
    id: "task-human-takeover-actions",
    projectId: seedProject.id,
    featureId: "feature-human-takeover",
    title: "Wire human takeover actions",
    description:
      "Let a user claim AI work, pause automation, return tasks to AI, and keep the event stream coherent.",
    status: "human-working",
    owner: "human",
    mode: "handoff",
    risk: "critical",
    source: "playbook",
    labels: ["human-takeover", "ai-paused", "handoff-ready"],
    acceptanceCriteria: [
      "Claiming a task changes owner from AI to human and pauses AI labels.",
      "Returning a task to AI removes human-only labels and records the transition.",
      "The detail panel shows the handoff summary before action buttons.",
    ],
    branch: "human/takeover-controls",
    worktree: "../worktrees/takeover-controls",
    github: {
      issueNumber: 27,
      issueUrl: "https://github.com/bank-p/loop-control-plane/issues/27",
      issueState: "open",
      pullRequestNumber: 29,
      pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/29",
      pullRequestState: "open",
      ciStatus: "passing",
      reviewStatus: "changes-requested",
    },
    handoff: {
      available: true,
      summary:
        "AI stopped after implementing reducer actions. Button copy and label cleanup remain open.",
      nextAction: "Resolve review feedback on owner transition edge cases.",
      contextPaths: [
        "components/task-detail/task-actions.tsx",
        "lib/loopboard.ts",
      ],
    },
    events: [
      event(
        "task-human-takeover-actions",
        "HUMAN_CLAIMED",
        "Human claimed task after review feedback.",
        "2026-06-14T03:10:00.000Z",
        { actor: "human", fromOwner: "ai", toOwner: "human" },
      ),
    ],
    createdAt: "2026-06-14T02:35:00.000Z",
    updatedAt: "2026-06-14T03:10:00.000Z",
  },
  {
    id: "task-github-ci-review-state",
    projectId: seedProject.id,
    featureId: "feature-github-bridge",
    title: "Model GitHub issue, PR, CI, and review state",
    description:
      "Represent linked GitHub workflow state locally so prototype cards can show external delivery signals.",
    status: "needs-review",
    owner: "pairing",
    mode: "review",
    risk: "medium",
    source: "github",
    labels: ["github", "review-requested", "ci-failing"],
    acceptanceCriteria: [
      "Task metadata can show issue and PR links independently.",
      "CI and review status are optional and renderable without credentials.",
      "Seed data includes failing, passing, pending, and missing CI examples.",
    ],
    branch: "feature/github-state-model",
    worktree: "../worktrees/github-state-model",
    github: {
      issueNumber: 31,
      issueUrl: "https://github.com/bank-p/loop-control-plane/issues/31",
      issueState: "open",
      pullRequestNumber: 33,
      pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/33",
      pullRequestBranch: "feature/github-state-model",
      pullRequestState: "open",
      mergeStatus: "mergeable",
      ciStatus: "failing",
      reviewStatus: "requested",
      deliveryStatus: "review-requested",
      prCiLastSyncedAt: "2026-06-14T03:18:00.000Z",
      ciFailureSummary: "typecheck failed in TypeScript validation.",
    },
    handoff: {
      available: false,
      contextPaths: ["lib/loopboard.ts"],
    },
    events: [
      event(
        "task-github-ci-review-state",
        "GITHUB_LINKED",
        "Linked issue #31 and PR #33 for local prototype state.",
        "2026-06-14T03:15:00.000Z",
        { metadata: { issueNumber: 31, pullRequestNumber: 33 } },
      ),
    ],
    createdAt: "2026-06-14T02:40:00.000Z",
    updatedAt: "2026-06-14T03:15:00.000Z",
  },
  {
    id: "task-local-persistence-reset",
    projectId: seedProject.id,
    featureId: "feature-kanban-control-plane",
    title: "Persist board state and reset seeded demo",
    description:
      "Save task status, selected task, and event history in local browser state with a deterministic reset path.",
    status: "ready",
    owner: "unassigned",
    mode: "plan",
    risk: "low",
    source: "manual",
    labels: ["local-storage", "prototype"],
    acceptanceCriteria: [
      "Saved task data hydrates before rendering the board.",
      "Partial stored shapes fall back to safe seed defaults.",
      "Reset restores the original seeded tasks and selected task state.",
    ],
    branch: "feature/local-persistence",
    worktree: "../worktrees/local-persistence",
    github: {
      issueNumber: 36,
      issueUrl: "https://github.com/bank-p/loop-control-plane/issues/36",
      issueState: "open",
      ciStatus: "not-started",
      reviewStatus: "not-requested",
    },
    handoff: {
      available: false,
      contextPaths: ["app/page.tsx", "lib/loopboard.ts"],
    },
    events: [
      event(
        "task-local-persistence-reset",
        "TASK_CREATED",
        "Created from local prototype planning notes.",
        "2026-06-14T03:18:00.000Z",
      ),
    ],
    createdAt: "2026-06-14T03:18:00.000Z",
    updatedAt: "2026-06-14T03:18:00.000Z",
  },
  {
    id: "task-blocked-automation-policy",
    projectId: seedProject.id,
    featureId: "feature-human-takeover",
    title: "Clarify auto-run disabled policy",
    description:
      "Document when global automation stays disabled and how individual task actions respect that policy.",
    status: "blocked",
    owner: "human",
    mode: "plan",
    risk: "high",
    source: "manual",
    labels: ["blocked", "automation-policy", "needs-decision"],
    acceptanceCriteria: [
      "Board header can show global auto-run disabled state.",
      "AI assignment remains available as an explicit local prototype action.",
      "Blocked tasks explain the decision needed before execution resumes.",
    ],
    branch: "policy/auto-run-disabled",
    worktree: "../worktrees/auto-run-policy",
    github: {
      issueState: "open",
      ciStatus: "not-started",
      reviewStatus: "not-requested",
    },
    handoff: {
      available: true,
      summary:
        "Prototype needs a clear difference between global auto-run and manual AI assignment.",
      nextAction: "Decide whether global auto-run can be toggled per project.",
      contextPaths: ["docs/decisions/adr-auto-run-policy.md"],
    },
    events: [
      event(
        "task-blocked-automation-policy",
        "BLOCKED",
        "Blocked pending automation policy decision.",
        "2026-06-14T03:25:00.000Z",
      ),
    ],
    createdAt: "2026-06-14T03:22:00.000Z",
    updatedAt: "2026-06-14T03:25:00.000Z",
  },
  {
    id: "task-finish-foundation",
    projectId: seedProject.id,
    featureId: "feature-kanban-control-plane",
    title: "Finish app foundation checks",
    description:
      "Confirm the baseline Next.js, Tailwind, lint, and typecheck setup works before UI implementation expands.",
    status: "done",
    owner: "human",
    mode: "review",
    risk: "low",
    source: "playbook",
    labels: ["foundation", "verified"],
    acceptanceCriteria: [
      "Next.js app renders the prototype shell.",
      "Lint passes with no source warnings.",
      "TypeScript typecheck passes.",
    ],
    branch: "main",
    worktree: ".",
    github: {
      ciStatus: "passing",
      reviewStatus: "approved",
    },
    handoff: {
      available: false,
      contextPaths: ["package.json", "app/page.tsx"],
    },
    events: [
      event(
        "task-finish-foundation",
        "MARKED_DONE",
        "Foundation task completed and verified.",
        "2026-06-14T03:30:00.000Z",
      ),
    ],
    createdAt: "2026-06-14T02:00:00.000Z",
    updatedAt: "2026-06-14T03:30:00.000Z",
  },
];

export const tasksByStatus = (tasks: Task[]): Record<KanbanStatus, Task[]> =>
  KANBAN_COLUMNS.reduce(
    (groups, column) => ({
      ...groups,
      [column.id]: tasks.filter((task) => task.status === column.id),
    }),
    {} as Record<KanbanStatus, Task[]>,
  );

export const moveTaskToStatus = ({
  task,
  toStatus,
  actor = "human",
  createdAt = new Date().toISOString(),
}: {
  task: Task;
  toStatus: KanbanStatus;
  actor?: TaskEvent["actor"];
  createdAt?: string;
}): Task => {
  if (task.status === toStatus) {
    return task;
  }

  const movedEvent = createTaskEvent({
    taskId: task.id,
    type: "TASK_MOVED",
    actor,
    message: `Moved from ${statusLabel(task.status)} to ${statusLabel(toStatus)}.`,
    createdAt,
    fromStatus: task.status,
    toStatus,
  });

  return {
    ...task,
    status: toStatus,
    updatedAt: createdAt,
    events: [...task.events, movedEvent],
  };
};

const addLabels = (labels: string[], additions: string[]): string[] =>
  Array.from(new Set([...labels, ...additions]));

const removeLabels = (labels: string[], removals: string[]): string[] =>
  labels.filter((label) => !removals.includes(label));

const replaceLabels = ({
  labels,
  add,
  remove = [],
}: {
  labels: string[];
  add: string[];
  remove?: string[];
}): string[] => addLabels(removeLabels(labels, remove), add);

const labelsEqual = (left: string[] = [], right: string[] = []): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const applyTaskAction = ({
  task,
  action,
  createdAt = new Date().toISOString(),
}: {
  task: Task;
  action: TaskAction;
  createdAt?: string;
}): Task => {
  if (action === "approve-ao-ready" && task.github.aoReadyApprovedAt) {
    return task;
  }

  const returnAiIssueLabels = replaceLabels({
    labels: task.github.issueLabels ?? [],
    add:
      task.risk === "low" || task.github.aoReadyApprovedAt
        ? ["ao-ready"]
        : [],
    remove: ["human-working"],
  });
  const returnAiGitHub =
    (task.github.issueNumber || task.github.issueUrl) &&
    !labelsEqual(task.github.issueLabels ?? [], returnAiIssueLabels)
      ? {
          ...task.github,
          issueLabels: returnAiIssueLabels,
          issueLastSyncedAt: createdAt,
        }
      : undefined;

  const actionUpdates: Record<
    TaskAction,
    {
      type: TaskEventType;
      actor: TaskEvent["actor"];
      message: string;
      status: KanbanStatus;
      owner: TaskOwner;
      mode: TaskMode;
      labels: string[];
      github?: GitHubState;
    }
  > = {
    "assign-ai": {
      type: "ASSIGNED_TO_AI",
      actor: "human",
      message: "Assigned to AI coding loop.",
      status: "ai-running",
      owner: "ai",
      mode: "execute",
      labels: replaceLabels({
        labels: task.labels,
        add: ["ai-assigned"],
        remove: ["ai-paused", "human-takeover", "blocked"],
      }),
    },
    "approve-ao-ready": {
      type: "AO_READY_APPROVED",
      actor: "human",
      message: "Approved AO ready handoff for this GitHub issue.",
      status: task.status,
      owner: task.owner,
      mode: task.mode,
      labels: task.labels,
      github: {
        ...task.github,
        aoReadyApprovedAt: createdAt,
        aoReadyApprovalReason: "Local approval recorded before applying ao-ready.",
      },
    },
    "mark-ao-ready": {
      type: "HANDOFF_READY",
      actor: "human",
      message: "Marked linked GitHub issue ao-ready for Agent Orchestrator handoff.",
      status: task.status,
      owner: task.owner,
      mode: task.mode,
      labels: task.labels,
      github: {
        ...task.github,
        issueLabels: addLabels(task.github.issueLabels ?? [], ["ao-ready"]),
        issueLastSyncedAt: createdAt,
      },
    },
    "remove-ao-ready": {
      type: "ISSUE_LABELS_SYNCED",
      actor: "human",
      message: "Removed ao-ready from linked GitHub issue labels.",
      status: task.status,
      owner: task.owner,
      mode: task.mode,
      labels: task.labels,
      github: {
        ...task.github,
        issueLabels: removeLabels(task.github.issueLabels ?? [], ["ao-ready"]),
        issueLastSyncedAt: createdAt,
      },
    },
    "claim-human": {
      type: "HUMAN_TAKEOVER",
      actor: "human",
      message: "Human took over task for direct manual work.",
      status: "human-working",
      owner: "human",
      mode: "handoff",
      labels: replaceLabels({
        labels: task.labels,
        add: ["human-takeover", "ai-paused"],
        remove: ["ai-assigned", "blocked"],
      }),
      github:
        task.github.issueNumber || task.github.issueUrl
          ? {
              ...task.github,
              issueLabels: replaceLabels({
                labels: task.github.issueLabels ?? [],
                add: ["human-working"],
                remove: ["ao-ready"],
              }),
              issueLastSyncedAt: createdAt,
            }
          : undefined,
    },
    "pause-ai": {
      type: "AI_PAUSED",
      actor: "human",
      message: "Paused AI execution for human review.",
      status: "human-working",
      owner: "human",
      mode: "handoff",
      labels: replaceLabels({
        labels: task.labels,
        add: ["ai-paused", "handoff-ready"],
        remove: ["ai-assigned", "blocked"],
      }),
    },
    "return-ai": {
      type: "RETURNED_TO_AI",
      actor: "human",
      message: "Returned task to AI ownership with handoff notes ready.",
      status: task.status === "ai-running" ? "ai-running" : "ready",
      owner: "ai",
      mode: "execute",
      labels: replaceLabels({
        labels: task.labels,
        add: ["handoff-ready"],
        remove: ["ai-paused", "human-takeover", "blocked"],
      }),
      github: returnAiGitHub,
    },
    "mark-blocked": {
      type: "BLOCKED",
      actor: "human",
      message: "Marked blocked pending human decision.",
      status: "blocked",
      owner: task.owner === "ai" ? "human" : task.owner,
      mode: task.mode,
      labels: replaceLabels({
        labels: task.labels,
        add: ["blocked", "needs-decision"],
        remove: ["ai-assigned"],
      }),
    },
    "mark-done": {
      type: "MARKED_DONE",
      actor: "human",
      message: "Marked done in local prototype state.",
      status: "done",
      owner: "human",
      mode: "review",
      labels: replaceLabels({
        labels: task.labels,
        add: ["verified"],
        remove: ["blocked", "needs-decision", "ai-assigned", "ai-paused"],
      }),
    },
  };

  const update = actionUpdates[action];
  const hasStateChange =
    task.status !== update.status ||
    task.owner !== update.owner ||
    task.mode !== update.mode ||
    JSON.stringify(task.labels) !== JSON.stringify(update.labels) ||
    JSON.stringify(task.github) !== JSON.stringify(update.github ?? task.github);

  if (!hasStateChange) {
    return task;
  }

  const actionEvent = createTaskEvent({
    taskId: task.id,
    type: update.type,
    actor: update.actor,
    message: update.message,
    createdAt,
    fromStatus: task.status,
    toStatus: update.status,
    fromOwner: task.owner,
    toOwner: update.owner,
    metadata:
      action === "claim-human"
        ? {
            branch: task.branch,
            worktree: task.worktree,
            issueNumber: task.github.issueNumber ?? null,
            issueUrl: task.github.issueUrl ?? null,
            pullRequestNumber: task.github.pullRequestNumber ?? null,
            pullRequestUrl: task.github.pullRequestUrl ?? null,
          }
        : undefined,
  });
  const assignmentEvent =
    action === "claim-human"
      ? createTaskEvent({
          taskId: task.id,
          type: "ASSIGNED_TO_HUMAN",
          actor: update.actor,
          message: "Assigned task owner to human for manual editing.",
          createdAt,
          fromStatus: task.status,
          toStatus: update.status,
          fromOwner: task.owner,
          toOwner: update.owner,
          metadata: {
            branch: task.branch,
            worktree: task.worktree,
            issueNumber: task.github.issueNumber ?? null,
            pullRequestNumber: task.github.pullRequestNumber ?? null,
          },
        })
      : action === "return-ai" && task.owner !== "ai"
        ? createTaskEvent({
            taskId: task.id,
            type: "ASSIGNED_TO_AI",
            actor: update.actor,
            message: "Assigned task owner back to AI for the next coding loop.",
            createdAt,
            fromStatus: task.status,
            toStatus: update.status,
            fromOwner: task.owner,
            toOwner: update.owner,
            metadata: {
              branch: task.branch,
              worktree: task.worktree,
              issueNumber: task.github.issueNumber ?? null,
              pullRequestNumber: task.github.pullRequestNumber ?? null,
            },
          })
      : null;

  return {
    ...task,
    status: update.status,
    owner: update.owner,
    mode: update.mode,
    labels: update.labels,
    github: update.github ?? task.github,
    updatedAt: createdAt,
    events: [
      ...task.events,
      actionEvent,
      ...(assignmentEvent ? [assignmentEvent] : []),
    ],
  };
};

export const initialBoardState = (): BoardState => ({
  tasks: seedTasks,
  selectedTaskId: seedTasks[0]?.id ?? "",
});

export const createPersistedBoardState = ({
  tasks,
  selectedTaskId,
  savedAt = new Date().toISOString(),
}: BoardState & { savedAt?: string }): PersistedBoardState => ({
  version: 1,
  tasks,
  selectedTaskId:
    tasks.some((task) => task.id === selectedTaskId) || tasks.length === 0
      ? selectedTaskId
      : tasks[0].id,
  savedAt,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isStatus = (value: unknown): value is KanbanStatus =>
  typeof value === "string" &&
  KANBAN_COLUMNS.some((column) => column.id === value);

const isOwner = (value: unknown): value is TaskOwner =>
  value === "unassigned" ||
  value === "ai" ||
  value === "human" ||
  value === "pairing";

const isMode = (value: unknown): value is TaskMode =>
  value === "spec" ||
  value === "plan" ||
  value === "execute" ||
  value === "review" ||
  value === "handoff";

const isRisk = (value: unknown): value is RiskLevel =>
  value === "low" ||
  value === "medium" ||
  value === "high" ||
  value === "critical";

const isSource = (value: unknown): value is TaskSource =>
  value === "spec-kit" ||
  value === "github" ||
  value === "manual" ||
  value === "playbook";

const isPullRequestState = (value: unknown): value is PullRequestState =>
  value === "draft" ||
  value === "open" ||
  value === "merged" ||
  value === "closed";

const isMergeStatus = (value: unknown): value is MergeStatus =>
  value === "unknown" ||
  value === "mergeable" ||
  value === "conflicting" ||
  value === "merged";

const isCiStatus = (value: unknown): value is CiStatus =>
  value === "not-started" ||
  value === "pending" ||
  value === "passing" ||
  value === "failing";

const isReviewStatus = (value: unknown): value is ReviewStatus =>
  value === "not-requested" ||
  value === "requested" ||
  value === "changes-requested" ||
  value === "approved";

const isGitHubDeliveryStatus = (
  value: unknown,
): value is GitHubDeliveryStatus =>
  value === "no-pr" ||
  value === "pr-opened" ||
  value === "ci-running" ||
  value === "ci-failed" ||
  value === "ci-passed" ||
  value === "review-requested" ||
  value === "changes-requested" ||
  value === "approved" ||
  value === "merged" ||
  value === "closed";

const isEventType = (value: unknown): value is TaskEventType =>
  value === "TASK_CREATED" ||
  value === "TASK_IMPORTED" ||
  value === "TASK_MOVED" ||
  value === "OWNER_CHANGED" ||
  value === "ASSIGNED_TO_AI" ||
  value === "AI_ASSIGNED" ||
  value === "AI_PAUSED" ||
  value === "HUMAN_TAKEOVER" ||
  value === "HUMAN_CLAIMED" ||
  value === "ASSIGNED_TO_HUMAN" ||
  value === "RETURNED_TO_AI" ||
  value === "BLOCKED" ||
  value === "UNBLOCKED" ||
  value === "MARKED_DONE" ||
  value === "GITHUB_LINKED" ||
  value === "ISSUE_CREATED" ||
  value === "ISSUE_LABELS_SYNCED" ||
  value === "PR_OPENED" ||
  value === "CI_RUNNING" ||
  value === "CI_FAILED" ||
  value === "CI_PASSED" ||
  value === "REVIEW_REQUESTED" ||
  value === "REVIEW_CHANGES_REQUESTED" ||
  value === "REVIEW_APPROVED" ||
  value === "DONE" ||
  value === "AO_READY_APPROVED" ||
  value === "HANDOFF_READY" ||
  value === "WORKFLOW_STEP_COMPLETED" ||
  value === "ENGINE_PICKUP" ||
  value === "ENGINE_PICKUP_SKIPPED" ||
  value === "ENGINE_TASK_COMPLETED" ||
  value === "ENGINE_TASK_FAILED";

const sanitizeMetadata = (
  value: unknown,
): Record<string, string | number | boolean | null> | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [
      string,
      string | number | boolean | null,
    ] => {
      const item = entry[1];
      return (
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean" ||
        item === null
      );
    }),
  );
};

const sanitizeTaskEvent = (
  value: unknown,
  fallbackTaskId: string,
): TaskEvent | null => {
  if (!isRecord(value)) {
    return null;
  }

  const taskId = typeof value.taskId === "string" ? value.taskId : fallbackTaskId;
  const type = isEventType(value.type) ? value.type : null;
  const actor =
    value.actor === "system" || value.actor === "ai" || value.actor === "human"
      ? value.actor
      : null;
  const message = typeof value.message === "string" ? value.message : null;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : null;

  if (!type || !actor || !message || !createdAt) {
    return null;
  }

  return {
    id:
      typeof value.id === "string"
        ? value.id
        : createTaskEvent({ taskId, type, actor, message, createdAt }).id,
    taskId,
    type,
    actor,
    message,
    createdAt,
    fromStatus: isStatus(value.fromStatus) ? value.fromStatus : undefined,
    toStatus: isStatus(value.toStatus) ? value.toStatus : undefined,
    fromOwner: isOwner(value.fromOwner) ? value.fromOwner : undefined,
    toOwner: isOwner(value.toOwner) ? value.toOwner : undefined,
    metadata: sanitizeMetadata(value.metadata),
  };
};

const sanitizeTask = (value: unknown): Task | null => {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.id !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.featureId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.description !== "string" ||
    !isStatus(value.status) ||
    !isOwner(value.owner) ||
    !isMode(value.mode) ||
    !isRisk(value.risk) ||
    !isSource(value.source) ||
    !isStringArray(value.labels) ||
    !isStringArray(value.acceptanceCriteria) ||
    typeof value.branch !== "string" ||
    typeof value.worktree !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  const github = isRecord(value.github) ? value.github : {};
  const handoff = isRecord(value.handoff) ? value.handoff : {};
  const id = value.id;
  const events = Array.isArray(value.events)
    ? value.events
        .map((taskEvent) => sanitizeTaskEvent(taskEvent, id))
        .filter((taskEvent): taskEvent is TaskEvent => taskEvent !== null)
    : [];

  return {
    id,
    projectId: value.projectId,
    featureId: value.featureId,
    title: value.title,
    description: value.description,
    status: value.status,
    owner: value.owner,
    mode: value.mode,
    risk: value.risk,
    source: value.source,
    labels: value.labels,
    acceptanceCriteria: value.acceptanceCriteria,
    branch: value.branch,
    worktree: value.worktree,
    github: {
      issueNumber:
        typeof github.issueNumber === "number" ? github.issueNumber : undefined,
      issueUrl: typeof github.issueUrl === "string" ? github.issueUrl : undefined,
      issueState:
        github.issueState === "open" || github.issueState === "closed"
          ? github.issueState
          : undefined,
      issueLabels: isStringArray(github.issueLabels)
        ? github.issueLabels
        : undefined,
      issueLastSyncedAt:
        typeof github.issueLastSyncedAt === "string"
          ? github.issueLastSyncedAt
          : undefined,
      pullRequestNumber:
        typeof github.pullRequestNumber === "number"
          ? github.pullRequestNumber
          : undefined,
      pullRequestUrl:
        typeof github.pullRequestUrl === "string"
          ? github.pullRequestUrl
          : undefined,
      pullRequestBranch:
        typeof github.pullRequestBranch === "string"
          ? github.pullRequestBranch
          : undefined,
      pullRequestState: isPullRequestState(github.pullRequestState)
        ? github.pullRequestState
        : undefined,
      mergeStatus: isMergeStatus(github.mergeStatus)
        ? github.mergeStatus
        : undefined,
      ciStatus: isCiStatus(github.ciStatus) ? github.ciStatus : undefined,
      reviewStatus: isReviewStatus(github.reviewStatus)
        ? github.reviewStatus
        : undefined,
      reviewUrl:
        typeof github.reviewUrl === "string"
          ? github.reviewUrl
          : undefined,
      deliveryStatus: isGitHubDeliveryStatus(github.deliveryStatus)
        ? github.deliveryStatus
        : undefined,
      prCiLastSyncedAt:
        typeof github.prCiLastSyncedAt === "string"
          ? github.prCiLastSyncedAt
          : undefined,
      ciFailureSummary:
        typeof github.ciFailureSummary === "string"
          ? github.ciFailureSummary
          : undefined,
    },
    handoff: {
      available:
        typeof handoff.available === "boolean" ? handoff.available : false,
      summary: typeof handoff.summary === "string" ? handoff.summary : undefined,
      nextAction:
        typeof handoff.nextAction === "string" ? handoff.nextAction : undefined,
      contextPaths: isStringArray(handoff.contextPaths)
        ? handoff.contextPaths
        : [],
    },
    events,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
};

export const parsePersistedBoardState = (rawValue: string | null): BoardState => {
  const fallback = initialBoardState();

  if (!rawValue) {
    return fallback;
  }

  try {
    const parsed: unknown = JSON.parse(rawValue);

    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
      return fallback;
    }

    const tasks = parsed.tasks
      .map((task) => sanitizeTask(task))
      .filter((task): task is Task => task !== null);

    if (tasks.length === 0) {
      return fallback;
    }

    const selectedTaskId =
      typeof parsed.selectedTaskId === "string" &&
      tasks.some((task) => task.id === parsed.selectedTaskId)
        ? parsed.selectedTaskId
        : tasks[0].id;

    return { tasks, selectedTaskId };
  } catch {
    return fallback;
  }
};
