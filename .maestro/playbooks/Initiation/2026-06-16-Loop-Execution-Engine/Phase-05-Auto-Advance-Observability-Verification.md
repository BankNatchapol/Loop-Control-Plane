# Phase 05: Auto-Advance, Observability, And Full Verification

This phase completes the loop engine experience: workflows and tasks advance automatically when policy allows, operators get clear observability into runs and failures, and the full feature + task loops are verified end-to-end. Loop Control Plane should feel like Maestro driving Spec Kit planning through implementation — while high-risk work, merges, and human review nodes remain explicitly gated.

## Tasks

- [x] Implement continuous auto-advance for workflows and task loops:
  - Extend `loop-scheduler.ts` to chain ticks: when a workflow-step job completes and the run is still `running`, automatically enqueue the next node if policy allows and the node is auto/semi with approval already satisfied
  - Add `autoAdvanceEnabled` project setting defaulting false; require both global auto-run and project auto-advance before unattended workflow progression
  - After task-run success, optionally enqueue follow-up jobs (e.g., run tests, open PR) when task metadata or linked workflow run defines a next step — reuse workflow graph edges rather than hard-coded chains
  - Stop auto-advance on first `requires-approval`, `deny`, failed step, or human node; surface pause reason on workflow runner panel and Engine panel
  - Respect merge and manual-claude-code-edit nodes as hard stops even when auto-advance is enabled
  - **Notes (2026-06-16):** Added `lib/engine/auto-advance.ts` with `maybeFollowUpAfterCompletedJob`, chained tick loop in `LoopScheduler` (max 25), `project.engineSettings.autoAdvanceEnabled` (default false), UI pause reasons in workflow runner + Engine panel, and `tests/loop-engine-auto-advance.test.ts`.

- [x] Build engine observability surfaces:
  - Add `GET /api/engine/jobs/[jobId]` returning full redacted execution log timeline
  - Add `GET /api/engine/jobs` with filters for project, task, workflow run, status, and backend
  - Extend Engine dashboard panel with expandable job detail drawer: payload summary, attempts, linked task/workflow node, stdout/stderr excerpts, policy decisions, and external session ids
  - Add engine metrics to project dashboard: jobs queued/running/completed/failed in last 24h, average duration, failure rate — compute from SQLite, no external telemetry
  - Show active engine jobs count in the existing workflow health header next to global auto-run indicator
  - **Notes (2026-06-16):** Added `/api/engine/jobs` + `/api/engine/jobs/[jobId]`, `getEngineJobMetrics` in repository, `Engine (24h)` metrics on project dashboard, active-jobs header badge, and expandable job detail drawer in Loop Engine panel. Tests in `loop-engine-api.test.ts`, `engine-actions.test.ts`, `loop-engine-repository.test.ts`.

- [x] Add failure recovery, retry, and operator controls:
  - Add `POST /api/engine/jobs/[jobId]/retry` to requeue failed jobs when under maxAttempts and policy allows
  - Add `POST /api/engine/jobs/[jobId]/cancel` to mark cancelled and release task/workflow locks
  - Add `POST /api/workflow-runs/[runId]/engine-resume` to continue a run after manual approval or retried failure
  - UI buttons: Retry, Cancel, Resume Run — disabled with explainable tooltips when policy blocks action
  - Ensure idempotent retries for import-tasks and create-github-issues executors using existing duplicate detection
  - **Notes (2026-06-16):** Added `lib/engine/engine-job-recovery.ts` with operator action policy helpers, retry/cancel/resume API routes, Engine panel Retry/Cancel/Resume Run controls with policy tooltips via `workflowRunResume` on engine status, `ENGINE_TASK_CANCELLED` event type, `workflowNodeId` job filter, and tests in `tests/loop-engine-recovery.test.ts` plus idempotent retry coverage in import/GitHub issue executor tests.

- [x] Harden engine security and policy integration:
  - Audit all new API routes through `evaluateGlobalAutomationPolicy` and task/workflow policy helpers; no silent bypass paths
  - Confirm engine logs, job payloads, and exported JSON never contain GitHub tokens, AO secrets, or env values — add regression tests mirroring `tests/automation-policy.test.ts` redaction cases
  - Block automatic execution for high/critical risk tasks and manual-only workflow nodes even if auto-advance and global auto-run are enabled
  - Add engine-specific policy codes to `lib/policies/automation-policy.ts` with tests and display them in UI effective policy summaries
  - Update `docs/architecture/risk-policy.md` and `docs/architecture/security-policy.md` with engine automation gates and wiki-link to `[[Loop-Execution-Engine]]`
  - **Notes (2026-06-16):** Added `evaluateEnginePolicy`, `assertEnginePolicyAllowed`, and `EnginePolicyError` in `lib/policies/automation-policy.ts`; wired scheduler, task-loop, auto-advance, and API guards; extended `describeEffectiveAutomationPolicy` with engine settings in dashboard + workflow editor; added `tests/loop-engine-security.test.ts` for policy codes and secret redaction regression.

- [x] Write observability and auto-advance tests:
  - Add `tests/loop-engine-auto-advance.test.ts` for chained workflow progression, pause on human node, stop on deny, and project auto-advance flag behavior
  - Add `tests/loop-engine-recovery.test.ts` for retry/cancel/resume flows and idempotent GitHub/import retries
  - Add `tests/loop-engine-observability.test.ts` for job list filters, redacted detail responses, and dashboard metrics queries
  - Extend Playwright coverage in `tests/ui/` or existing spec with Engine panel visibility, demo job flow, and auto-run disabled default state
  - **Notes (2026-06-16):** `loop-engine-auto-advance.test.ts` and core recovery tests were already present from Phase 05 earlier tasks; added `loop-engine-observability.test.ts` (4 tests for filters, redaction, metrics), extended `loop-engine-recovery.test.ts` with idempotent import/GitHub retry cases after operator requeue, and added `tests/ui/loop-engine-panel.spec.ts` (3 Playwright tests). All 327 unit tests pass; Playwright currently blocked by pre-existing `node:child_process` client-bundle error in `app/page.tsx` import chain — to be fixed in full verification walkthrough.

- [x] Run full loop verification walkthrough:
  - Execute end-to-end feature loop with mocks/stubs where external CLIs unavailable: human-input approval → spec-kit-actions → human-review approval → import-tasks → create-github-issues (mocked) → agent-orchestrator-implement (mocked fan-out) → run-tests → ai-review → open-pr (mocked) — confirm board + workflow events update at each stage
  - Execute end-to-end task loop: import Spec Kit task → Ready → engine pickup → backend execution (stub) → Needs Review → Done
  - Confirm high-risk seeded task cannot auto-run with default settings; confirm merge node never auto-executes
  - Run `npm run db:migrate`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run test:ui`; fix failures
  - Finalize `docs/architecture/loop-execution-engine.md` with Auto-Advance, Observability, and Verification sections; add `related:` wiki-links across architecture docs
  - **Notes (2026-06-16):** Extended `tests/workflow-executor-verification.test.ts` through open-pr with mocked GitHub/gh; added `tests/loop-full-verification.test.ts` for high-risk pickup + merge hard-stop; split client-safe `task-loop-eligibility.ts` and `auto-advance-ui.ts` to fix Playwright `node:child_process` bundle error; all 330 unit + 6 Playwright tests pass; finalized loop-execution-engine.md Phase 05 sections and wiki-links on workflow-editor-runner, github-issue-bridge, spec-kit-importer, pr-ci-review-tracking.

- [x] Polish dashboard UX for the completed engine:
  - Improve empty states: engine never run, no jobs queued, backend unavailable, AO not configured
  - Verify desktop and mobile layouts for Engine panel + job drawer — no overlapping controls or hidden retry buttons
  - Add concise README section under Loop Execution Engine describing how to enable global auto-run safely and run the Feature Development Loop
  - Leave dev server running after verification and capture optional screenshots to `Auto Run Docs/Initiation/Working/` if useful for review
  - **Notes (2026-06-16):** Added `lib/engine/engine-panel-empty-states.ts` with contextual callouts in Loop Engine panel, queue-depth hints, backend unavailability detail list, Engine (24h) metrics empty hint, full-width mobile recovery actions in job drawer; extended `tests/ui/loop-engine-panel.spec.ts` (5 tests) and `tests/engine-panel-empty-states.test.ts`; README sections for safe auto-run enablement and Feature Development Loop; screenshots in `Auto Run Docs/Initiation/Working/engine-panel-{desktop,mobile}.png`.
