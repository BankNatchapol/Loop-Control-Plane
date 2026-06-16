import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defaultAutomationSettings,
  describeEffectiveAutomationPolicy,
  evaluateGlobalAutomationPolicy,
  evaluateTaskPolicy,
  evaluateWorkflowNodePolicy,
  inferEffectiveTaskRisk,
} from "@/lib/policies/automation-policy";
import type { Task, WorkflowNode } from "@/lib/loopboard";
import { defaultProjectAutomationPolicy, seedTasks } from "@/lib/loopboard";

const taskWith = (overrides: Partial<Task>): Task => ({
  ...seedTasks[0],
  github: {},
  ...overrides,
});

const workflowNodeWith = (
  overrides: Partial<WorkflowNode>,
): Pick<
  WorkflowNode,
  "type" | "name" | "mode" | "requireApproval" | "riskPolicy" | "config"
> => ({
  type: "ai-review",
  name: "AI Review",
  mode: "auto",
  requireApproval: false,
  riskPolicy: "low",
  config: {},
  ...overrides,
});

const autoRunEnabled = {
  globalAutoRunEnabled: true,
};

describe("Automation policy", () => {
  it("keeps global auto-run disabled by default", () => {
    const policy = evaluateGlobalAutomationPolicy(defaultAutomationSettings);

    assert.equal(policy.kind, "deny");
    assert.equal(policy.code, "global_auto_run_disabled");
  });

  it("escalates sensitive task categories to high risk unless overridden", () => {
    const task = taskWith({
      risk: "low",
      title: "Update billing permissions flow",
      description: "Adjust checkout role handling.",
      labels: ["frontend"],
      acceptanceCriteria: ["Users with the billing role can retry payment."],
    });

    const inferred = inferEffectiveTaskRisk(task);
    assert.equal(inferred.risk, "high");
    assert.deepEqual(inferred.highRiskCategories.sort(), [
      "billing",
      "payments",
      "permissions",
    ]);

    const overridden = inferEffectiveTaskRisk(task, { explicitRiskOverride: true });
    assert.equal(overridden.risk, "low");
  });

  it("allows low-risk automated controls and gates medium-risk automation", () => {
    const low = evaluateTaskPolicy({
      operation: "automation-control",
      task: taskWith({ risk: "low" }),
      automated: true,
      automationSettings: autoRunEnabled,
    });
    const medium = evaluateTaskPolicy({
      operation: "automation-control",
      task: taskWith({ risk: "medium" }),
      automated: true,
      automationSettings: autoRunEnabled,
    });

    assert.equal(low.kind, "allow");
    assert.equal(medium.kind, "requires-approval");
    assert.equal(medium.code, "medium_risk_review_gate");
  });

  it("keeps high-risk automation manual-only by default", () => {
    const policy = evaluateTaskPolicy({
      operation: "automation-control",
      task: taskWith({ risk: "high" }),
      automated: true,
      automationSettings: autoRunEnabled,
    });

    assert.equal(policy.kind, "deny");
    assert.equal(policy.code, "high_risk_manual_only");
  });

  it("requires approval before ao-ready on non-low-risk tasks", () => {
    const task = taskWith({
      risk: "medium",
      github: {
        issueNumber: 42,
        issueUrl: "https://github.com/bank-p/loop-control-plane/issues/42",
      },
    });

    const gated = evaluateTaskPolicy({
      operation: "mark-ao-ready",
      task,
    });
    const approved = evaluateTaskPolicy({
      operation: "mark-ao-ready",
      task: {
        ...task,
        github: {
          ...task.github,
          aoReadyApprovedAt: "2026-06-14T00:00:00.000Z",
        },
      },
    });

    assert.equal(gated.kind, "requires-approval");
    assert.equal(gated.code, "ao_ready_approval_required");
    assert.equal(approved.kind, "allow");
  });

  it("uses workflow node mode, approval, and risk policy for runner decisions", () => {
    const human = evaluateWorkflowNodePolicy({
      node: workflowNodeWith({ mode: "human", riskPolicy: "manual-only" }),
    });
    const lowAuto = evaluateWorkflowNodePolicy({
      node: workflowNodeWith({ mode: "auto", riskPolicy: "low" }),
      automated: true,
      automationSettings: autoRunEnabled,
    });
    const highAuto = evaluateWorkflowNodePolicy({
      node: workflowNodeWith({ mode: "auto", riskPolicy: "high" }),
      automated: true,
      automationSettings: autoRunEnabled,
    });

    assert.equal(human.kind, "requires-approval");
    assert.equal(lowAuto.kind, "allow");
    assert.equal(highAuto.kind, "deny");
  });

  it("requires approval for shell-capable workflow nodes", () => {
    const shellNode = workflowNodeWith({
      type: "run-tests",
      name: "Run Tests",
      mode: "auto",
      requireApproval: false,
      riskPolicy: "low",
      config: { command: "npm test" },
    });
    const gated = evaluateWorkflowNodePolicy({
      node: shellNode,
      automated: true,
      automationSettings: autoRunEnabled,
    });
    const approved = evaluateWorkflowNodePolicy({
      node: shellNode,
      automated: true,
      approved: true,
      automationSettings: autoRunEnabled,
    });

    assert.equal(gated.kind, "requires-approval");
    assert.equal(gated.code, "workflow_shell_command_approval_required");
    assert.equal(approved.kind, "allow");
  });

  it("blocks automated actions when global auto-run is disabled", () => {
    const taskPolicy = evaluateTaskPolicy({
      operation: "automation-control",
      task: taskWith({ risk: "low" }),
      automated: true,
    });
    const workflowPolicy = evaluateWorkflowNodePolicy({
      node: workflowNodeWith({ mode: "auto", riskPolicy: "low" }),
      automated: true,
    });

    assert.equal(taskPolicy.kind, "deny");
    assert.equal(taskPolicy.code, "global_auto_run_disabled");
    assert.equal(workflowPolicy.kind, "deny");
    assert.equal(workflowPolicy.code, "global_auto_run_disabled");
  });

  it("uses project settings for low-risk issue and AO-ready automation", () => {
    const projectPolicy = {
      ...defaultProjectAutomationPolicy,
      allowLowRiskAutoIssueCreation: false,
      allowLowRiskAutoAoReadyLabeling: false,
    };
    const issuePolicy = evaluateTaskPolicy({
      operation: "create-github-issue",
      task: taskWith({ risk: "low" }),
      automated: true,
      automationSettings: autoRunEnabled,
      projectPolicy,
    });
    const aoReadyPolicy = evaluateTaskPolicy({
      operation: "mark-ao-ready",
      task: taskWith({
        risk: "low",
        github: {
          issueNumber: 42,
          issueUrl: "https://github.com/bank-p/loop-control-plane/issues/42",
        },
      }),
      automated: true,
      automationSettings: autoRunEnabled,
      projectPolicy,
    });

    assert.equal(issuePolicy.kind, "deny");
    assert.equal(issuePolicy.code, "project_blocks_low_risk_auto_issue_creation");
    assert.equal(aoReadyPolicy.kind, "deny");
    assert.equal(aoReadyPolicy.code, "project_blocks_low_risk_auto_ao_ready");
  });

  it("describes effective project policy for UI display", () => {
    const policy = describeEffectiveAutomationPolicy({
      automationSettings: autoRunEnabled,
      projectPolicy: defaultProjectAutomationPolicy,
    });

    assert.equal(policy.kind, "allow");
    assert.equal(policy.code, "project_automation_policy_active");
    assert.ok(policy.reasons.some((reason) => reason.includes("low-risk")));
  });
});
