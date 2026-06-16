---
type: reference
title: Risk Policy
created: 2026-06-14
tags:
  - risk
  - approval
  - loopboard
related:
  - '[[Security-Policy]]'
  - '[[Workflow-Editor-Runner]]'
  - '[[GitHub-Issue-Bridge]]'
  - '[[Human-Takeover]]'
---

# Risk Policy

LoopBoard gates automation on task risk and explicit human approval. The default posture keeps global auto-run disabled and treats high-risk tasks as manual-only. The central policy service (`lib/policies/automation-policy.ts`) is the single source for all allow/deny/requires-approval decisions used by task actions, workflow nodes, GitHub issue creation, and UI controls.

See [[Security-Policy]] for token handling, untrusted context rules, and shell command constraints.

## Risk Levels

Tasks and workflow nodes carry one of four risk levels:

| Level | Meaning |
|-------|---------|
| `low` | Routine work with limited external impact. Can be automated when settings allow. |
| `medium` | Moderate-impact work. Requires a review gate when `mediumRiskRequiresReview` is active. |
| `high` | Significant impact or sensitive categories. Manual-only by default. |
| `critical` | Highest-impact work (e.g., production deploys, data destruction). Always manual-only. |

Risk levels are ordered: `low < medium < high < critical`. Effective risk is the maximum of the assigned risk and any inferred high-risk category escalation.

## Default Posture

| Setting | Default |
|---------|---------|
| `globalAutoRunEnabled` | `false` — no background automation without explicit operator opt-in |
| `allowLowRiskAutoIssueCreation` | `false` — GitHub issues are not created automatically |
| `allowLowRiskAutoAoReadyLabeling` | `false` — `ao-ready` labels are not applied automatically |
| `mediumRiskRequiresReview` | `true` — medium-risk automation requires a human review gate |
| `highRiskManualOnly` | `true` — high and critical risk automation is blocked |

These defaults mean LoopBoard out of the box performs no automated external actions. Every GitHub issue creation, label sync, AO-ready promotion, and workflow node advancement is driven by an explicit human action unless the operator changes the settings.

## High-Risk Category Inference

The policy service scans task title, description, labels, and acceptance criteria for patterns that indicate high-risk work. When any pattern matches and the risk has not been explicitly overridden, the effective risk is escalated to `high`.

Detected high-risk categories:

| Category | Signal patterns |
|----------|----------------|
| `authentication` | auth, authentication, oauth, sso, login, session |
| `permissions` | permission, permissions, rbac, role, roles, access control |
| `payments` | payment, payments, checkout, stripe, invoice |
| `billing` | billing, subscription, refund, chargeback |
| `database migration` | database migration, db migration, schema migration, migrate, drizzle migration |
| `production deployment` | production deploy, prod deploy, deployment, release, rollout |
| `secrets` | secret, secrets, token, api key, apikey, credential, password |
| `data deletion` | delete data, data deletion, destroy, purge, truncate, drop table |
| `security-sensitive code` | security, encryption, crypto, csrf, xss, sql injection, vulnerability |
| `large refactor` | large refactor, major refactor, rewrite, architecture refactor |

Pattern matching is case-insensitive and uses word boundaries. A matched category is included in the `reasons` array of the policy decision so the UI and logs can explain why risk was escalated.

An operator can supply `explicitRiskOverride: true` to suppress inference escalation when the task risk label was set deliberately for a known-safe context.

## Policy Decisions

All policy evaluations return a `PolicyDecision` with:

- `kind`: `"allow"` | `"requires-approval"` | `"deny"`
- `code`: a stable string code usable in tests and UI conditionals (see codes below)
- `message`: a human-readable explanation
- `reasons`: an array of strings describing each contributing factor
- `effectiveRisk`: the resolved risk level used in the decision

### Task Policy Codes

| Code | Kind | Trigger |
|------|------|---------|
| `global_auto_run_disabled` | deny | Automated request when `globalAutoRunEnabled` is false |
| `project_blocks_low_risk_auto_issue_creation` | deny | Automated `create-github-issue` when project flag is off |
| `project_blocks_low_risk_auto_ao_ready` | deny | Automated `mark-ao-ready` when project flag is off |
| `github_issue_required` | deny | AO-ready action without a linked GitHub issue |
| `ao_ready_approval_required` | requires-approval | Medium/high/critical task without prior AO-ready approval |
| `medium_risk_review_gate` | requires-approval | Medium-risk automated action when `mediumRiskRequiresReview` is on |
| `high_risk_manual_only` | deny | High/critical automated action when `highRiskManualOnly` is on |
| `task_policy_allowed` | allow | All checks passed |
| `task_action_not_policy_gated` | allow | Action does not involve automation handoff |

### Workflow Node Policy Codes

| Code | Kind | Trigger |
|------|------|---------|
| `global_auto_run_disabled` | deny | Automated node when global auto-run is off |
| `workflow_node_disabled` | deny | Node mode is `disabled` |
| `workflow_approval_required` | requires-approval | Human/semi mode or `requireApproval` set, not yet approved |
| `workflow_approval_recorded` | allow | Human/semi mode, approval already recorded |
| `workflow_shell_command_approval_required` | requires-approval | Shell-capable node without explicit approval |
| `workflow_manual_only` | requires-approval | `manual-only` or `critical` risk policy, not yet approved |
| `workflow_medium_risk_review_gate` | requires-approval | Medium-risk automated node when `mediumRiskRequiresReview` is on |
| `workflow_high_risk_manual_only` | deny | High-risk automated node when `highRiskManualOnly` is on |
| `workflow_node_allowed` | allow | All checks passed |

## Task Approval Gates

### Assign to AI

`assign-ai` is policy-evaluated as a task action. Under default settings it is allowed for any task when `globalAutoRunEnabled` is false and the action is not automated. When global auto-run is enabled:

- Low-risk tasks: allowed.
- Medium-risk tasks with `mediumRiskRequiresReview`: requires approval.
- High/critical tasks with `highRiskManualOnly`: denied.

### AO Ready Labeling

Marking a task `ao-ready` requires a linked GitHub issue. Without one, the policy returns `github_issue_required`.

- Low-risk tasks can be marked automatically when `allowLowRiskAutoAoReadyLabeling` is true.
- Medium, high, and critical tasks require an explicit local AO-ready approval recorded in task GitHub state before the `ao-ready` label is applied.

AO-ready approval is recorded as a `github.aoReadyApprovedAt` timestamp and an `AO_READY_APPROVED` task event. The same approval is consumed by both the label sync route and the task detail UI. See [[GitHub-Issue-Bridge]] for how the label is applied.

### GitHub Issue Creation

Low-risk automatic issue creation is blocked by default (`project_blocks_low_risk_auto_issue_creation`). Explicit user-triggered issue creation is not restricted by risk level — the policy only gates automated calls.

## Workflow Node Approval Gates

The workflow runner evaluates every node through `evaluateWorkflowNodePolicy` before advancing. Approval gates apply in this order:

1. **Global auto-run disabled**: deny if the runner is in automated mode and `globalAutoRunEnabled` is false.
2. **Node disabled**: deny if the node mode is `disabled`.
3. **Human/semi/requireApproval**: pause if the node requires human sign-off (approval clears the gate).
4. **Shell-capable**: pause if the node can run shell commands and approval is not recorded.
5. **Manual-only/critical risk policy**: pause if risk policy is `manual-only` or `critical`.
6. **Medium-risk review gate**: pause if risk is `medium` and `mediumRiskRequiresReview` is on.
7. **High-risk manual-only**: deny if risk is `high` and `highRiskManualOnly` is on.

Shell-capable nodes are identified by `isShellCapableWorkflowNode`: `run-tests` type nodes, or any node with a `command` string or `commands` array in their config. The `merge` node is seeded as a human-mode node with `requireApproval: true`, making automatic merges structurally impossible under the current runner.

See [[Workflow-Editor-Runner]] for how paused runs wait for approval actions and how the runner advances after approval is recorded.

## Project-Level Automation Settings

Each project stores an `automation_policy` JSON object with:

| Field | Type | Default |
|-------|------|---------|
| `allowLowRiskAutoIssueCreation` | boolean | `false` |
| `allowLowRiskAutoAoReadyLabeling` | boolean | `false` |
| `mediumRiskRequiresReview` | boolean | `true` |
| `highRiskManualOnly` | boolean | `true` |

These settings are stored as boolean flags only. They are separate from task content, GitHub tokens, and workflow config. They do not expose secrets and are safe to include in policy summary UI.

The global `app_settings` table stores `globalAutoRunEnabled` separately from project policy, as it applies to all projects.

Policy summaries displayed in the project dashboard and workflow editor list the effective setting reasons so operators can understand the active posture without reading source code.

## Non-Goals

The following are outside the current risk policy scope:

- **Automatic merge** — No risk level permits automatic PR merge. The `merge` workflow node is always human-controlled; see [[Human-Takeover]].
- **Remote or cloud-based approval workflows** — Approvals are recorded locally in the LoopBoard SQLite database. There is no external approval service, webhook, or notification system.
- **Fine-grained per-user approval** — LoopBoard has no user identity. AO-ready approvals are operator-level local actions, not attributed to individual users.
- **Dynamic risk scoring or ML classification** — Risk levels and high-risk category detection use fixed pattern matching. There is no adaptive or learning risk scorer.
- **Cross-project policy inheritance** — Each project policy is independent. Global auto-run is the only cross-project setting.
