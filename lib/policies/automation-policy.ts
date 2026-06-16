import type {
  ProjectAutomationPolicy,
  RiskLevel,
  Task,
  TaskAction,
  WorkflowNode,
  WorkflowRiskPolicy,
} from "@/lib/loopboard";
import { defaultProjectAutomationPolicy } from "@/lib/loopboard";
import { readExecutorConfig } from "@/lib/engine/loop-engine-types";

export type PolicyDecisionKind = "allow" | "requires-approval" | "deny";

export type PolicyDecision = {
  kind: PolicyDecisionKind;
  code: string;
  message: string;
  reasons: string[];
  effectiveRisk?: RiskLevel;
};

export type TaskPolicyOperation =
  | "assign-ai"
  | "approve-ao-ready"
  | "mark-ao-ready"
  | "create-github-issue"
  | "automation-control";

export type TaskPolicyInput = {
  operation: TaskPolicyOperation;
  task: Pick<
    Task,
    | "title"
    | "description"
    | "risk"
    | "labels"
    | "acceptanceCriteria"
    | "github"
  >;
  automated?: boolean;
  approved?: boolean;
  explicitRiskOverride?: boolean;
  automationSettings?: AutomationSettings;
  projectPolicy?: ProjectAutomationPolicy;
};

export type WorkflowNodePolicyInput = {
  node: Pick<
    WorkflowNode,
    "type" | "name" | "mode" | "requireApproval" | "riskPolicy" | "config"
  >;
  automated?: boolean;
  approved?: boolean;
  automationSettings?: AutomationSettings;
  projectPolicy?: ProjectAutomationPolicy;
};

export type AutomationSettings = {
  globalAutoRunEnabled: boolean;
};

export const defaultAutomationSettings: AutomationSettings = {
  globalAutoRunEnabled: false,
};

export type EffectiveAutomationPolicyInput = {
  automationSettings?: AutomationSettings;
  projectPolicy?: ProjectAutomationPolicy;
  engineSettings?: { autoAdvanceEnabled?: boolean };
};

export type EnginePolicyOperation =
  | "scheduler-control"
  | "auto-advance"
  | "automated-task-pickup"
  | "automated-workflow-step";

export type EnginePolicyInput = {
  operation: EnginePolicyOperation;
  automationSettings?: AutomationSettings;
  projectPolicy?: ProjectAutomationPolicy;
  engineSettings?: { autoAdvanceEnabled?: boolean };
  task?: TaskPolicyInput["task"];
  node?: WorkflowNodePolicyInput["node"];
  approved?: boolean;
};

export const WORKFLOW_HARD_STOP_NODE_TYPES = [
  "merge",
  "manual-claude-code-edit",
] as const;

export type WorkflowHardStopNodeType =
  (typeof WORKFLOW_HARD_STOP_NODE_TYPES)[number];

export const isWorkflowHardStopNode = (
  node: Pick<WorkflowNode, "type" | "mode">,
): boolean =>
  (WORKFLOW_HARD_STOP_NODE_TYPES as readonly string[]).includes(node.type) ||
  node.mode === "human";

export class EnginePolicyError extends Error {
  readonly code: string;
  readonly reasons: string[];

  constructor(
    readonly decision: PolicyDecision,
    readonly statusCode = 403,
  ) {
    super(decision.message);
    this.name = "EnginePolicyError";
    this.code = decision.code;
    this.reasons = decision.reasons;
  }
}

const riskRank: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const riskFromRank = (rank: number): RiskLevel =>
  rank >= riskRank.critical
    ? "critical"
    : rank >= riskRank.high
      ? "high"
      : rank >= riskRank.medium
        ? "medium"
        : "low";

const workflowRiskToTaskRisk = (riskPolicy: WorkflowRiskPolicy): RiskLevel =>
  riskPolicy === "manual-only" ? "critical" : riskPolicy;

export const workflowNodeShellWarning =
  "This workflow node can run local shell commands and requires explicit human approval.";

export const isShellCapableWorkflowNode = (
  node: Pick<WorkflowNode, "type" | "config">,
): boolean => {
  const command = node.config.command;
  const commands = node.config.commands;
  const executor = readExecutorConfig(node.config);

  return (
    node.type === "run-tests" ||
    typeof command === "string" ||
    (Array.isArray(commands) && commands.some((item) => typeof item === "string")) ||
    typeof executor?.command === "string" ||
    Boolean(executor?.args && executor.args.length > 0)
  );
};

const highRiskPatterns: Array<{ category: string; pattern: RegExp }> = [
  { category: "authentication", pattern: /\b(auth|authentication|oauth|sso|login|session)\b/iu },
  { category: "permissions", pattern: /\b(permission|permissions|rbac|role|roles|access control)\b/iu },
  { category: "payments", pattern: /\b(payment|payments|checkout|stripe|invoice)\b/iu },
  { category: "billing", pattern: /\b(billing|subscription|refund|chargeback)\b/iu },
  { category: "database migration", pattern: /\b(database migration|db migration|schema migration|migrate|drizzle migration)\b/iu },
  { category: "production deployment", pattern: /\b(production deploy|prod deploy|deployment|release|rollout)\b/iu },
  { category: "secrets", pattern: /\b(secret|secrets|token|api key|apikey|credential|password)\b/iu },
  { category: "data deletion", pattern: /\b(delete data|data deletion|destroy|purge|truncate|drop table)\b/iu },
  { category: "security-sensitive code", pattern: /\b(security|encryption|crypto|csrf|xss|sql injection|vulnerability)\b/iu },
  { category: "large refactor", pattern: /\b(large refactor|major refactor|rewrite|architecture refactor)\b/iu },
];

const decision = ({
  kind,
  code,
  message,
  reasons,
  effectiveRisk,
}: PolicyDecision): PolicyDecision => ({
  kind,
  code,
  message,
  reasons,
  effectiveRisk,
});

const automationSettingsReasons = ({
  automationSettings = defaultAutomationSettings,
  projectPolicy = defaultProjectAutomationPolicy,
  engineSettings,
}: EffectiveAutomationPolicyInput): string[] => [
  automationSettings.globalAutoRunEnabled
    ? "Global auto-run is enabled."
    : "Global auto-run is disabled.",
  engineSettings?.autoAdvanceEnabled
    ? "Project auto-advance is enabled (requires global auto-run)."
    : "Project auto-advance is disabled.",
  projectPolicy.allowLowRiskAutoIssueCreation
    ? "Project allows low-risk automatic GitHub issue creation."
    : "Project blocks low-risk automatic GitHub issue creation.",
  projectPolicy.allowLowRiskAutoAoReadyLabeling
    ? "Project allows low-risk automatic AO-ready labeling."
    : "Project blocks low-risk automatic AO-ready labeling.",
  projectPolicy.allowLowRiskAutoTaskExecution
    ? "Project allows low-risk automatic task execution."
    : "Project blocks low-risk automatic task execution.",
  projectPolicy.mediumRiskRequiresReview
    ? "Project requires review gates for medium-risk automation."
    : "Project does not require review gates for medium-risk automation.",
  projectPolicy.highRiskManualOnly
    ? "Project keeps high-risk automation manual-only."
    : "Project allows high-risk automation when explicitly approved.",
  "Engine scheduler and automated ticks require global auto-run.",
  "High/critical risk tasks and manual-only workflow nodes never auto-execute.",
];

const deniesAutomatedGlobalSetting = (
  automated: boolean,
  automationSettings = defaultAutomationSettings,
): boolean => automated && !automationSettings.globalAutoRunEnabled;

export const inferHighRiskCategories = (
  task: Pick<Task, "title" | "description" | "labels" | "acceptanceCriteria">,
): string[] => {
  const text = [
    task.title,
    task.description,
    ...task.labels,
    ...task.acceptanceCriteria,
  ]
    .join("\n")
    .toLowerCase();

  return highRiskPatterns
    .filter(({ pattern }) => pattern.test(text))
    .map(({ category }) => category);
};

export const inferEffectiveTaskRisk = (
  task: Pick<Task, "title" | "description" | "risk" | "labels" | "acceptanceCriteria">,
  options: { explicitRiskOverride?: boolean } = {},
): { risk: RiskLevel; reasons: string[]; highRiskCategories: string[] } => {
  const highRiskCategories = inferHighRiskCategories(task);
  const inferredRisk =
    highRiskCategories.length > 0 && !options.explicitRiskOverride
      ? "high"
      : task.risk;
  const risk = riskFromRank(Math.max(riskRank[task.risk], riskRank[inferredRisk]));
  const reasons = [`Task is labeled ${task.risk} risk.`];

  if (highRiskCategories.length > 0) {
    reasons.push(
      options.explicitRiskOverride
        ? `High-risk categories were explicitly overridden: ${highRiskCategories.join(", ")}.`
        : `High-risk categories detected: ${highRiskCategories.join(", ")}.`,
    );
  }

  return { risk, reasons, highRiskCategories };
};

export const evaluateTaskPolicy = ({
  operation,
  task,
  automated = false,
  approved = false,
  explicitRiskOverride = false,
  automationSettings = defaultAutomationSettings,
  projectPolicy = defaultProjectAutomationPolicy,
}: TaskPolicyInput): PolicyDecision => {
  const { risk, reasons } = inferEffectiveTaskRisk(task, { explicitRiskOverride });
  const hasLinkedIssue = Boolean(task.github.issueNumber || task.github.issueUrl);
  const hasAoReadyApproval = Boolean(task.github.aoReadyApprovedAt) || approved;
  const settingReasons = automated
    ? automationSettingsReasons({ automationSettings, projectPolicy })
    : [];
  const baseReasons = automated
    ? [...reasons, "Request is automated.", ...settingReasons]
    : [...reasons, "Request is an explicit local action."];

  if (deniesAutomatedGlobalSetting(automated, automationSettings)) {
    return decision({
      kind: "deny",
      code: "global_auto_run_disabled",
      message: "Global auto-run is disabled by default.",
      reasons: baseReasons,
      effectiveRisk: risk,
    });
  }

  if (
    automated &&
    operation === "create-github-issue" &&
    risk === "low" &&
    !projectPolicy.allowLowRiskAutoIssueCreation
  ) {
    return decision({
      kind: "deny",
      code: "project_blocks_low_risk_auto_issue_creation",
      message: "This project blocks low-risk automatic GitHub issue creation.",
      reasons: baseReasons,
      effectiveRisk: risk,
    });
  }

  if (
    automated &&
    operation === "mark-ao-ready" &&
    risk === "low" &&
    !projectPolicy.allowLowRiskAutoAoReadyLabeling
  ) {
    return decision({
      kind: "deny",
      code: "project_blocks_low_risk_auto_ao_ready",
      message: "This project blocks low-risk automatic AO-ready labeling.",
      reasons: baseReasons,
      effectiveRisk: risk,
    });
  }

  if (
    automated &&
    operation === "assign-ai" &&
    risk === "low" &&
    !projectPolicy.allowLowRiskAutoTaskExecution
  ) {
    return decision({
      kind: "deny",
      code: "project_blocks_low_risk_auto_task_execution",
      message: "This project blocks low-risk automatic task execution.",
      reasons: baseReasons,
      effectiveRisk: risk,
    });
  }

  if (operation === "automation-control") {
    if (automated && risk === "medium" && projectPolicy.mediumRiskRequiresReview) {
      return decision({
        kind: "requires-approval",
        code: "medium_risk_review_gate",
        message: "Medium-risk automation requires a human review gate.",
        reasons: baseReasons,
        effectiveRisk: risk,
      });
    }

    if (automated && (risk === "high" || risk === "critical") && projectPolicy.highRiskManualOnly) {
      return decision({
        kind: "deny",
        code: "high_risk_manual_only",
        message: "High and critical risk automation is manual-only by default.",
        reasons: baseReasons,
        effectiveRisk: risk,
      });
    }

    return decision({
      kind: "allow",
      code: "automation_allowed",
      message: "The task policy allows this automation control.",
      reasons: baseReasons,
      effectiveRisk: risk,
    });
  }

  if (operation === "mark-ao-ready") {
    if (!hasLinkedIssue) {
      return decision({
        kind: "deny",
        code: "github_issue_required",
        message: "AO ready approval requires a linked GitHub issue.",
        reasons: [...baseReasons, "No linked GitHub issue was found."],
        effectiveRisk: risk,
      });
    }

    if (risk !== "low" && !hasAoReadyApproval) {
      return decision({
        kind: "requires-approval",
        code: "ao_ready_approval_required",
        message:
          "Medium, high, and critical risk tasks require local AO ready approval before applying ao-ready.",
        reasons: baseReasons,
        effectiveRisk: risk,
      });
    }

    return decision({
      kind: "allow",
      code: "task_policy_allowed",
      message: "The task policy allows this action.",
      reasons: baseReasons,
      effectiveRisk: risk,
    });
  }

  if (operation === "approve-ao-ready" && !hasLinkedIssue) {
    return decision({
      kind: "deny",
      code: "github_issue_required",
      message: "AO ready approval requires a linked GitHub issue.",
      reasons: [...baseReasons, "No linked GitHub issue was found."],
      effectiveRisk: risk,
    });
  }

  if (
    automated &&
    risk === "medium" &&
    projectPolicy.mediumRiskRequiresReview &&
    !hasAoReadyApproval
  ) {
    return decision({
      kind: "requires-approval",
      code: "medium_risk_review_gate",
      message: "Medium-risk automation requires a human review gate.",
      reasons: baseReasons,
      effectiveRisk: risk,
    });
  }

  if (automated && (risk === "high" || risk === "critical") && projectPolicy.highRiskManualOnly) {
    return decision({
      kind: "deny",
      code: "high_risk_manual_only",
      message: "High and critical risk tasks are manual-only by default.",
      reasons: baseReasons,
      effectiveRisk: risk,
    });
  }

  return decision({
    kind: "allow",
    code: "task_policy_allowed",
    message: "The task policy allows this action.",
    reasons: baseReasons,
    effectiveRisk: risk,
  });
};

export const evaluateTaskActionPolicy = ({
  action,
  task,
  automated = false,
  approved = false,
  automationSettings = defaultAutomationSettings,
  projectPolicy = defaultProjectAutomationPolicy,
}: {
  action: TaskAction;
  task: TaskPolicyInput["task"];
  automated?: boolean;
  approved?: boolean;
  automationSettings?: AutomationSettings;
  projectPolicy?: ProjectAutomationPolicy;
}): PolicyDecision => {
  if (action === "assign-ai") {
    return evaluateTaskPolicy({
      operation: "assign-ai",
      task,
      automated,
      approved,
      automationSettings,
      projectPolicy,
    });
  }

  if (action === "approve-ao-ready") {
    return evaluateTaskPolicy({
      operation: "approve-ao-ready",
      task,
      automated,
      approved: true,
      automationSettings,
      projectPolicy,
    });
  }

  if (action === "mark-ao-ready") {
    return evaluateTaskPolicy({
      operation: "mark-ao-ready",
      task,
      automated,
      approved,
      automationSettings,
      projectPolicy,
    });
  }

  return decision({
    kind: "allow",
    code: "task_action_not_policy_gated",
    message: "This task action is not restricted by automation policy.",
    reasons: ["The action does not hand work to automation."],
    effectiveRisk: task.risk,
  });
};

export const evaluateWorkflowNodePolicy = ({
  node,
  automated = false,
  approved = false,
  automationSettings = defaultAutomationSettings,
  projectPolicy = defaultProjectAutomationPolicy,
}: WorkflowNodePolicyInput): PolicyDecision => {
  const risk = workflowRiskToTaskRisk(node.riskPolicy);
  const shellCapable = isShellCapableWorkflowNode(node);
  const reasons = [
    `Workflow node mode is ${node.mode}.`,
    `Workflow risk policy is ${node.riskPolicy}.`,
    ...(shellCapable ? [workflowNodeShellWarning] : []),
    ...(automated ? automationSettingsReasons({ automationSettings, projectPolicy }) : []),
  ];

  if (deniesAutomatedGlobalSetting(automated, automationSettings)) {
    return decision({
      kind: "deny",
      code: "global_auto_run_disabled",
      message: "Global auto-run is disabled by default.",
      reasons,
      effectiveRisk: risk,
    });
  }

  if (node.mode === "disabled") {
    return decision({
      kind: "deny",
      code: "workflow_node_disabled",
      message: "Disabled workflow nodes cannot run.",
      reasons,
      effectiveRisk: risk,
    });
  }

  if (node.mode === "human" || node.mode === "semi" || node.requireApproval) {
    return decision({
      kind: approved ? "allow" : "requires-approval",
      code: approved ? "workflow_approval_recorded" : "workflow_approval_required",
      message: approved
        ? "Human approval has been recorded for this workflow node."
        : "This workflow node requires human approval before it can run.",
      reasons,
      effectiveRisk: risk,
    });
  }

  if (shellCapable && !approved) {
    return decision({
      kind: "requires-approval",
      code: "workflow_shell_command_approval_required",
      message: "Shell-capable workflow nodes require explicit approval before they can run.",
      reasons,
      effectiveRisk: risk,
    });
  }

  if (node.riskPolicy === "manual-only" || node.riskPolicy === "critical") {
    return decision({
      kind: approved ? "allow" : "requires-approval",
      code: approved ? "workflow_approval_recorded" : "workflow_manual_only",
      message: approved
        ? "Human approval has been recorded for this workflow node."
        : "Critical and manual-only workflow nodes require human approval.",
      reasons,
      effectiveRisk: risk,
    });
  }

  if (
    automated &&
    node.riskPolicy === "medium" &&
    projectPolicy.mediumRiskRequiresReview &&
    !approved
  ) {
    return decision({
      kind: "requires-approval",
      code: "workflow_medium_risk_review_gate",
      message: "Medium-risk workflow automation requires a human review gate.",
      reasons,
      effectiveRisk: risk,
    });
  }

  if (automated && node.riskPolicy === "high" && projectPolicy.highRiskManualOnly) {
    return decision({
      kind: "deny",
      code: "workflow_high_risk_manual_only",
      message: "High-risk workflow automation is manual-only by default.",
      reasons,
      effectiveRisk: risk,
    });
  }

  return decision({
    kind: "allow",
    code: "workflow_node_allowed",
    message: "The workflow policy allows this node to run.",
    reasons,
    effectiveRisk: risk,
  });
};

export const evaluateGlobalAutomationPolicy = (
  settings: AutomationSettings = defaultAutomationSettings,
): PolicyDecision =>
  settings.globalAutoRunEnabled
    ? decision({
        kind: "allow",
        code: "global_auto_run_enabled",
        message: "Global auto-run is enabled.",
        reasons: ["A local operator enabled global auto-run."],
      })
    : decision({
        kind: "deny",
        code: "global_auto_run_disabled",
        message: "Global auto-run is disabled by default.",
        reasons: ["Loop Control Plane keeps background automation off unless explicitly enabled."],
      });

const mapTaskPickupToEnginePolicy = (
  taskPolicy: PolicyDecision,
): PolicyDecision => {
  if (taskPolicy.kind === "allow") {
    return taskPolicy;
  }

  if (taskPolicy.code === "global_auto_run_disabled") {
    return decision({
      ...taskPolicy,
      code: "engine_global_auto_run_required",
      message: "Engine automated task pickup requires global auto-run.",
    });
  }

  if (
    taskPolicy.code === "high_risk_manual_only" &&
    (taskPolicy.effectiveRisk === "high" || taskPolicy.effectiveRisk === "critical")
  ) {
    return decision({
      ...taskPolicy,
      code:
        taskPolicy.effectiveRisk === "critical"
          ? "engine_critical_risk_task_auto_blocked"
          : "engine_high_risk_task_auto_blocked",
      message:
        taskPolicy.effectiveRisk === "critical"
          ? "Critical risk tasks cannot be picked up automatically by the engine."
          : "High and critical risk tasks cannot be picked up automatically by the engine.",
    });
  }

  if (taskPolicy.code === "project_blocks_low_risk_auto_task_execution") {
    return decision({
      ...taskPolicy,
      code: "engine_project_blocks_auto_task_execution",
      message: "This project blocks low-risk automatic engine task pickup.",
    });
  }

  return taskPolicy;
};

const mapWorkflowStepToEnginePolicy = (
  node: Pick<WorkflowNode, "type" | "name" | "mode" | "riskPolicy">,
  nodePolicy: PolicyDecision,
): PolicyDecision => {
  if (isWorkflowHardStopNode(node)) {
    return decision({
      kind: "deny",
      code:
        node.type === "merge"
          ? "engine_workflow_merge_blocked"
          : "engine_workflow_hard_stop",
      message: `${node.name} requires manual operator action and cannot auto-execute.`,
      reasons: [
        `Workflow node type "${node.type}" is a hard stop for engine auto-advance.`,
      ],
      effectiveRisk: nodePolicy.effectiveRisk,
    });
  }

  if (nodePolicy.kind === "allow") {
    return nodePolicy;
  }

  if (
    node.riskPolicy === "manual-only" ||
    node.riskPolicy === "critical" ||
    node.mode === "human" ||
    node.mode === "semi"
  ) {
    return decision({
      ...nodePolicy,
      kind: "deny",
      code: "engine_workflow_manual_only_blocked",
      message: "Manual-only, critical, and human workflow nodes cannot auto-execute.",
    });
  }

  if (nodePolicy.code === "workflow_high_risk_manual_only") {
    return decision({
      ...nodePolicy,
      code: "engine_workflow_high_risk_blocked",
      message: "High-risk workflow nodes cannot auto-execute through the engine.",
    });
  }

  if (nodePolicy.code === "global_auto_run_disabled") {
    return decision({
      ...nodePolicy,
      code: "engine_global_auto_run_required",
      message: "Engine automated workflow steps require global auto-run.",
    });
  }

  return nodePolicy;
};

export const evaluateEnginePolicy = ({
  operation,
  automationSettings = defaultAutomationSettings,
  projectPolicy = defaultProjectAutomationPolicy,
  engineSettings,
  task,
  node,
  approved = false,
}: EnginePolicyInput): PolicyDecision => {
  if (operation === "scheduler-control") {
    const globalDecision = evaluateGlobalAutomationPolicy(automationSettings);
    if (globalDecision.kind === "deny") {
      return decision({
        kind: "deny",
        code: "engine_global_auto_run_required",
        message: "Engine scheduler and automated ticks require global auto-run.",
        reasons: automationSettingsReasons({
          automationSettings,
          projectPolicy,
          engineSettings,
        }),
      });
    }

    return decision({
      kind: "allow",
      code: "engine_scheduler_allowed",
      message: "Engine scheduler automation is allowed.",
      reasons: automationSettingsReasons({
        automationSettings,
        projectPolicy,
        engineSettings,
      }),
    });
  }

  if (operation === "auto-advance") {
    if (!automationSettings.globalAutoRunEnabled) {
      return decision({
        kind: "deny",
        code: "engine_auto_advance_global_required",
        message: "Workflow auto-advance requires global auto-run.",
        reasons: automationSettingsReasons({
          automationSettings,
          projectPolicy,
          engineSettings,
        }),
      });
    }

    if (engineSettings?.autoAdvanceEnabled !== true) {
      return decision({
        kind: "deny",
        code: "engine_auto_advance_project_disabled",
        message: "Project auto-advance is disabled.",
        reasons: automationSettingsReasons({
          automationSettings,
          projectPolicy,
          engineSettings,
        }),
      });
    }

    return decision({
      kind: "allow",
      code: "engine_auto_advance_allowed",
      message: "Workflow auto-advance is active.",
      reasons: automationSettingsReasons({
        automationSettings,
        projectPolicy,
        engineSettings,
      }),
    });
  }

  if (operation === "automated-task-pickup" && task) {
    return mapTaskPickupToEnginePolicy(
      evaluateTaskPolicy({
        operation: "assign-ai",
        task,
        automated: true,
        automationSettings,
        projectPolicy,
      }),
    );
  }

  if (operation === "automated-workflow-step" && node) {
    return mapWorkflowStepToEnginePolicy(
      node,
      evaluateWorkflowNodePolicy({
        node,
        automated: true,
        approved,
        automationSettings,
        projectPolicy,
      }),
    );
  }

  return decision({
    kind: "allow",
    code: "engine_policy_allowed",
    message: "Engine policy allows this operation.",
    reasons: [],
  });
};

export const assertEnginePolicyAllowed = (input: EnginePolicyInput): PolicyDecision => {
  const policy = evaluateEnginePolicy(input);
  if (policy.kind === "deny") {
    throw new EnginePolicyError(policy);
  }

  return policy;
};

export const describeEffectiveAutomationPolicy = ({
  automationSettings = defaultAutomationSettings,
  projectPolicy = defaultProjectAutomationPolicy,
  engineSettings,
}: EffectiveAutomationPolicyInput): PolicyDecision => {
  const globalDecision = evaluateGlobalAutomationPolicy(automationSettings);
  const reasons = automationSettingsReasons({
    automationSettings,
    projectPolicy,
    engineSettings,
  });

  if (globalDecision.kind === "deny") {
    return decision({
      kind: "deny",
      code: "engine_global_auto_run_required",
      message: "Global auto-run is disabled; engine automation is blocked.",
      reasons,
    });
  }

  return decision({
    kind: "allow",
    code: "engine_automation_policy_active",
    message: "Global auto-run is enabled and engine automation settings are active.",
    reasons,
  });
};
