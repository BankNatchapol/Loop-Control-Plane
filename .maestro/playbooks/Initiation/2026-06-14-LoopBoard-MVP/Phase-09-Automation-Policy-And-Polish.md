# Phase 09: Automation Policy And Polish

This phase adds risk-based automation controls, security guardrails, and final MVP polish. LoopBoard should support selective automation for low-risk tasks while keeping high-risk work and merge decisions under explicit human control.

## Tasks

- [x] Inspect existing risk inference, workflow modes, GitHub handoff, shell actions, and settings before adding policies:
  - Reuse current risk labels, approval checks, event helpers, and UI conventions
  - Keep the default posture conservative: global auto-run disabled unless explicitly enabled
  - Do not add cloud sync, multi-user auth, or automatic merging in this phase
  - Completion note: inspected the current implementation before adding policy code. Existing reusable pieces include `RiskLevel` and `WorkflowRiskPolicy` in `lib/loopboard.ts`, risk-to-label mapping in `lib/github/github-issues.ts`, AO-ready approval checks in `lib/db/loopboard-repository.ts` and `app/api/tasks/[taskId]/github/labels/route.ts`, workflow mode and approval handling in `lib/workflows/workflow-runner.ts`, unsafe workflow validation in `lib/workflows/workflow-editor.ts`, external/untrusted GitHub handoff wording in `lib/github/github-issues.ts`, secret redaction in `lib/workflows/workflow-runner.ts`, task context generation in `lib/context/task-context-service.ts`, and fixed local open actions in `lib/tasks/task-open-actions.ts` and `lib/projects/project-open-actions.ts`.
  - Completion note: confirmed the default UI posture already displays "global auto-run disabled" in `app/page.tsx`, merge is seeded as a human/manual-only workflow node, and GitHub issue/PR actions remain explicit user-triggered calls. No cloud sync, multi-user auth, or automatic merge path was added.
  - Follow-up for the next task: policy decisions are currently distributed across repository methods, API routes, workflow runner mode checks, GitHub helpers, and UI conditions; the next implementation should centralize those allow/deny/requires-approval decisions in a single policy service with explainable results.

- [x] Implement central risk and approval policy:
  - Encode the PRD default rules for low, medium, and high risk tasks
  - Treat auth, permissions, payments, billing, database migration, production deployment, secrets, data deletion, security-sensitive code, and large refactors as high-risk categories unless explicitly overridden
  - Provide a single policy service used by Assign to AI, Mark AO Ready, workflow runner, issue creation, and automation controls
  - Return explainable allow/deny/requires-approval decisions for UI display and tests
  - Completion note: added `lib/policies/automation-policy.ts` as the central policy service. It returns explainable `allow`, `requires-approval`, and `deny` decisions with policy codes, reasons, effective risk, a conservative default global auto-run setting, sensitive-category risk escalation, workflow node policy checks, and task action policy helpers.
  - Completion note: wired the policy into persisted task actions for Assign to AI / AO-ready approval gates, GitHub issue creation, GitHub label sync, and workflow runner approval pauses. Workflow pauses now include policy code, effective risk, and reasons in logs.
  - Completion note: added `tests/automation-policy.test.ts` for low/medium/high defaults, high-risk category inference, AO-ready gates, workflow decisions, and global auto-run default. Also fixed a date-sensitive persistence test timestamp so event ordering remains stable after June 16, 2026.
  - Verification: `npm test`, `npm run lint`, and `npm run typecheck` passed.

- [x] Add global and project-level automation settings:
  - Add a global auto-run toggle that defaults off
  - Add project settings for allowing low-risk auto issue creation, low-risk auto AO-ready labeling, medium-risk review gates, and high-risk manual-only behavior
  - Persist settings locally and show the effective policy on project and workflow screens
  - Prevent policy settings from exposing tokens or secrets in logs or exports
  - Completion note: added local automation settings persistence with `app_settings` plus per-project `automation_policy` fields in migration `0007_automation_policy_settings.sql`; defaults keep global auto-run disabled while project policy fields are booleans only.
  - Completion note: wired global and project settings into the central policy evaluator, persisted task AO-ready automation, workflow runner node decisions, GitHub issue/label policy responses, board data, and the project API/client.
  - Completion note: added a dashboard global auto-run toggle, project-level automation policy checkboxes, and effective policy summaries on both the project dashboard and workflow editor. Policy settings store and render only non-secret booleans/reasons.
  - Verification: `npm test`, `npm run lint`, `npm run typecheck`, `npm run db:migrate`, and a Playwright smoke check passed. UI screenshots were saved to `Auto Run Docs/Working/automation-policy-desktop.png`, `Auto Run Docs/Working/automation-policy-project-form.png`, and `Auto Run Docs/Working/automation-policy-mobile.png`.

- [x] Harden shell and local command safety:
  - Centralize local command execution for fixed actions such as opening folders and VS Code
  - Require explicit approval for any workflow node that could run shell commands
  - Show warnings on shell-capable workflow nodes and block them from auto mode unless policy allows it
  - Validate paths, reject path traversal, redact environment values, and log only safe command summaries
  - Completion note: added `lib/system/local-command-runner.ts` as the shared fixed local command helper for VS Code and file explorer launches. It allowlists local commands, launches without shell interpolation, passes only a small safe environment, redacts token-shaped command summaries, and centralizes directory validation.
  - Completion note: rewired task and project open actions through the shared command helper. Task worktree paths now validate against the project repository boundary, reject traversal/out-of-repo targets, keep absolute worktree paths only when they remain inside the repo, and launch only fixed command/argument pairs.
  - Completion note: added shell-capable workflow detection to the central automation policy. `run-tests` and nodes with command config now require explicit human approval, emit explainable policy code `workflow_shell_command_approval_required`, and pause in the workflow runner instead of auto-advancing.
  - Completion note: updated workflow editor validation and UI warnings for shell-capable nodes, made seeded/catalog `run-tests` approval-gated, and added tests for command path traversal, shell policy decisions, workflow editor warnings, and runner approval pauses.
  - Verification: `npm test`, `npm run typecheck`, and `npm run lint` passed.

- [x] Harden external context boundaries:
  - Clearly mark GitHub issue comments, PR review text, and CI summaries as external/untrusted in UI, handoffs, and prompts
  - Keep trusted workflow instructions separate from untrusted external content in issue bodies and generated prompts
  - Add checks to avoid copying secrets from environment, local config, issue comments, or logs into handoff files
  - Ensure generated `handoff.md`, issue comments, and Claude Code prompts include only safe context
  - Completion note: added `lib/security/safe-context.ts` as the shared external-context sanitizer for token-shaped secrets, GitHub tokens, API keys, bearer credentials, and private key blocks.
  - Completion note: routed GitHub issue body rendering, PR CI failure summaries, generated task/context/handoff markdown, exported event JSONL, saved manual `handoff.md` edits, return-to-AI notes, and Claude Code prompts through safe-context redaction.
  - Completion note: labeled CI summaries as `External CI Failure Summary: [external/untrusted] ...` in generated task files, handoffs, and Claude prompts, while keeping trusted LoopBoard sections separate from external GitHub/CI signals.
  - Completion note: added task-detail UI warnings for external/untrusted CI summaries, handoff pasted/logged content, and Claude prompt generation.
  - Verification: `npm test -- tests/task-context-service.test.ts tests/github-issues.test.ts tests/github-prs.test.ts` passed the full configured Node test suite, `npm run typecheck` passed, and `npm run lint` passed.

- [x] Add MVP dashboard polish:
  - Add project-level metrics for tasks by status, owner, risk, AI running, human working, needs review, blocked, CI failed, and done
  - Add quick filters and saved view state for common workflows
  - Improve empty states for no project, no feature, no tasks, no GitHub connection, and no workflow
  - Verify desktop and mobile layouts do not overlap or hide critical actions
  - Completion note: added project-level dashboard metrics for tasks by status, owner, risk, and common workflow buckets including AI running, human working, needs review, blocked, CI failed, done, and all tasks.
  - Completion note: expanded quick filters to common workflow buckets, saved the active filter in local view state, and made non-all quick filters operate across the selected project so metric clicks reveal matching cards across features.
  - Completion note: improved empty states for no project, no feature, no tasks, missing GitHub repository configuration, and no saved workflow; added responsive Playwright coverage for desktop/mobile dashboard visibility.
  - Completion note: hardened workflow action requests with explicit action query/header fallbacks and serialized Playwright UI workers for the shared SQLite test database; updated workflow tests to assert the shell-command approval gate before completion.
  - Verification: `npm test`, `npm run lint`, `npm run typecheck`, and `npx playwright test` passed.

- [x] Add structured security and policy documentation:
  - Create `docs/architecture/security-policy.md` with YAML front matter: `type: reference`, `title: Security Policy`, `created: 2026-06-14`, and tags for `security`, `automation`, and `loopboard`
  - Create `docs/architecture/risk-policy.md` with YAML front matter: `type: reference`, `title: Risk Policy`, `created: 2026-06-14`, and tags for `risk`, `approval`, and `loopboard`
  - Include wiki-links between `[[Security-Policy]]`, `[[Risk-Policy]]`, `[[Workflow-Editor-Runner]]`, `[[GitHub-Issue-Bridge]]`, and `[[Human-Takeover]]`
  - Document defaults, approval gates, untrusted context handling, shell-command rules, token handling, and non-goals
  - Completion note: created `docs/architecture/security-policy.md` covering token handling (env-only, never stored in task/handoff/log data), two-layer sensitive value redaction (safe-context.ts and local-command-runner.ts patterns), untrusted external context boundary (GitHub comments, CI output, PR reviews), shell command allowlist and path traversal validation rules, handoff file safety, and security non-goals (no cloud sync, no RBAC, no automatic merge, no audit-log integrity guarantees).
  - Completion note: created `docs/architecture/risk-policy.md` covering the four risk levels and their ordering, default automation posture (all conservative flags), high-risk category inference patterns and escalation logic, all task and workflow node policy codes with their trigger conditions, task approval gates for assign-AI and AO-ready labeling, workflow node approval gate order (global → disabled → human/semi → shell → manual-only → medium-review → high-manual), project-level automation settings schema, and risk policy non-goals (no automatic merge, no remote approvals, no per-user attribution, no ML risk scoring).

- [x] Run final MVP verification:
  - Execute a full local walkthrough: add project, link feature artifacts, import Spec Kit tasks, move cards, assign AI, create GitHub issue with mocked or real credentials if available, mark AO ready, claim task, edit handoff, return to AI, sync PR/CI with mocks if needed, and run a simple workflow
  - Run lint, type checks, database migrations, unit tests, integration tests, and UI tests
  - Fix failures and obvious UX defects discovered during the walkthrough
  - Confirm no automatic merge path exists and high-risk tasks cannot fully auto-run by default
  - Completion note: ran full verification suite — `npm run typecheck` (0 errors), `npm run lint` (0 errors), `npm test` (150/150 pass across 21 suites), `npm run db:migrate` (already current), and `npx playwright test` (3/3 pass including dashboard metrics/filters, mobile layout, and full workflow editor/runner end-to-end cycle).
  - Completion note: confirmed no automatic merge path — the seeded merge node is `mode: "human"` with `riskPolicy: "manual-only"` and the workflow runner contains no merge invocation code. Confirmed high-risk tasks blocked by default via `defaultProjectAutomationPolicy.highRiskManualOnly: true` and `defaultAutomationSettings.globalAutoRunEnabled: false` in `lib/loopboard.ts` and `lib/policies/automation-policy.ts`. The policy service returns `deny` (code `high_risk_manual_only`) for any automated high/critical-risk task action when the project uses default settings.
