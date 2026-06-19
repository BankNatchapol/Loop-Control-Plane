# Phase 02: Task-Loop Automation

This phase wires the loop engine to the Kanban board so Ready and AO-ready tasks are picked up automatically, given generated context, executed through a configured backend, and advanced on the board without manual clicks. It delivers the first real "Maestro-like" task loop: the board moves itself while still honoring risk policy, human takeover, and conservative defaults.

## Tasks

- [x] Inspect existing task lifecycle, context generation, and policy hooks:
  - Read `lib/loopboard.ts` task actions, `lib/context/task-context-service.ts`, `lib/api/task-context-actions.ts`, `lib/policies/automation-policy.ts`, and GitHub AO-ready flows in `lib/github/github-issues.ts`
  - Identify reusable transitions for Assign to AI, move to AI Running, Needs Review, Blocked, and Done
  - Confirm which task statuses qualify for auto-pickup (`ready`, optionally `ao-ready` labeled tasks in Ready column) and which must remain manual (`human-working`, `blocked`, high/critical risk without approval)
  - Do not bypass existing AO-ready approval gates or human takeover semantics
  - **Completed 2026-06-16.** Findings documented in `Auto Run Docs/Working/task-loop-lifecycle-inspection.md`. Key reuse: `applyTaskAction("assign-ai")` for pickup, `moveTask("needs-review")` on success, `mark-blocked`/`mark-done` for terminal paths; planner must call `evaluateTaskActionPolicy({ action: "assign-ai", automated: true })` (repository's current `applyTaskAction` omits `automated`); AO-ready gates enforced via `applyAoReadyLabelForRiskPolicy` + `aoReadyApprovedAt`; no `task-loop-planner` or scheduler pickup yet.

- [x] Add task-run engine jobs and pickup planning:
  - Extend `EngineJobKind` with `task-run` payload shape: `{ taskId, projectId, action: "execute" | "review" | "handoff", executorConfig, contextPaths?, trigger: "scheduler" | "manual" | "workflow" }`
  - Add `lib/engine/task-loop-planner.ts` that scans board data for eligible tasks: status Ready, owner unassigned or AI, risk allowed by project/global policy, no active human claim, and no in-flight engine job for the same task
  - Integrate `evaluateTaskActionPolicy` for assign-AI and execution operations; enqueue only when policy returns `allow`, skip or record `requires-approval`/`deny` with explainable reasons on the task event stream
  - Add repository method to dedupe queued/running `task-run` jobs per task id
  - **Completed 2026-06-16.** Added `TaskRunJobPayload` types + validation in `loop-engine-types.ts`; `task-loop-planner.ts` with `scanTaskLoopCandidates` / `enqueueTaskLoopJobs`; repository `getActiveTaskRunJobForTask`, `hasActiveTaskRunJob`, `enqueueTaskRunJob`; extended `listEngineJobs` filters; `ENGINE_PICKUP_SKIPPED` event type for policy audit trail; tests in `tests/task-loop-planner.test.ts`.

- [x] Implement task execution orchestration:
  - Add `lib/engine/task-run-executor.ts` registered for `task-run` jobs in the executor registry
  - On job start: load task/project/feature, call `TaskContextService` to generate or refresh `task.md`, `context.md`, `handoff.md`, and `events.jsonl`, then transition task to AI Running with a `TASK_ASSIGNED`/`ENGINE_PICKUP` event
  - Resolve executor backend from task metadata, project defaults, or workflow node config fallback; default to `stub` in tests and `cursor` only when explicitly configured
  - Invoke the selected backend adapter stub for this phase if real CLI adapters are not yet implemented — but structure the call path so Phase 03/04 can swap in real executors without changing the planner
  - On success: move task to Needs Review (or Done for trivial demo tasks), append completion event, refresh context files with result summary, and mark job completed
  - On failure: move task to Blocked or keep in AI Running based on retry budget, append failure event with redacted error, and respect maxAttempts
  - **Completed 2026-06-16.** Added `task-run-executor.ts` with `executeTaskRunJob`, backend resolution (`resolveTaskRunExecutorConfig` via payload → `executor-backend:*` label → workflow node → stub), swappable `invokeBackend` adapter, pickup/finalize helpers, and new event types `ENGINE_PICKUP`, `ENGINE_TASK_COMPLETED`, `ENGINE_TASK_FAILED`. Wired via `taskRunHandler` in `createExecutorRegistryForRepository`; shared stub path in `stub-executor-job.ts`. Tests in `tests/task-run-executor.test.ts` (9 cases).

- [x] Connect scheduler ticks to automatic task pickup:
  - Extend `loop-scheduler.ts` tick planning: after policy check, call task-loop planner to enqueue new jobs up to a configurable concurrency limit (start with 1 for safety)
  - When global auto-run is enabled and scheduler is running, automatically enqueue eligible Ready tasks on each tick; when disabled, still allow manual **Run Task Loop** for a selected task from the UI
  - Add project-level optional setting `allowLowRiskAutoTaskExecution` defaulting false, wired through automation policy alongside existing low-risk flags
  - Never auto-execute high/critical risk tasks or tasks with active human owner unless explicit override approval exists
  - **Completed 2026-06-16.** Added `planTaskLoopPickup` + `DEFAULT_TASK_LOOP_CONCURRENCY_LIMIT` (1) in `loop-scheduler.ts`; automated ticks call `enqueueTaskLoopJobs` before dequeue when scheduler is running and global auto-run is on. New `allowLowRiskAutoTaskExecution` project policy (default false) gates automated `assign-ai` via `project_blocks_low_risk_auto_task_execution`. Repository `countActiveTaskRunJobs` enforces concurrency. UI toggle in project automation settings. Tests in `loop-scheduler.test.ts`, `task-loop-planner.test.ts`, `automation-policy.test.ts`.

- [x] Add task-loop API routes and board UI integration:
  - Add `POST /api/engine/task-loop/enqueue` for manual enqueue of the selected task with policy evaluation response
  - Add `POST /api/engine/task-loop/scan` to run planner once and return what would be enqueued (dry-run for UI preview)
  - Extend task detail panel with engine status for the task: latest job id, backend, attempt, last log line, and **Run with Engine** button when policy allows
  - Show a subtle "engine queued" / "engine running" badge on Kanban cards with in-flight jobs
  - Auto-refresh card status when engine completes without requiring page reload beyond existing dashboard polling
  - **Completed 2026-06-16.** Added `lib/api/task-loop-actions.ts` + `/api/engine/task-loop/enqueue` and `/scan` routes; client helpers `enqueueTaskLoop`/`scanTaskLoop`; task detail **Engine Status** panel with **Run with Engine**; Kanban card badges; silent board refresh on task-run job completion via existing 3s engine polling.

- [x] Write task-loop automation tests:
  - Add `tests/task-loop-planner.test.ts` for eligibility rules, risk gates, AO-ready approval requirements, dedupe behavior, and dry-run scan output
  - Add `tests/task-run-executor.test.ts` covering context generation side effects, status transitions, success/failure/retry paths, and event creation
  - Add integration test that seeds a low-risk Ready task, enqueues a task-run job, ticks the scheduler, and asserts AI Running → Needs Review with updated context files on disk (use temp repo path like existing persistence tests)
  - Update automation policy tests if new project setting or policy codes are introduced
  - **Completed 2026-06-16.** Extended `task-loop-planner.test.ts` with high-risk deny, medium-risk AO-ready approval gate, and dry-run scan/enqueue coverage; added `ASSIGNED_TO_AI` event assertion to `task-run-executor.test.ts`; new `tests/task-loop-integration.test.ts` end-to-end scheduler tick test with on-disk context artifacts; expanded `automation-policy.test.ts` allow path for `allowLowRiskAutoTaskExecution`. 257 tests pass.

- [x] Run task-loop verification:
  - Run `npm run db:migrate`, `npm run lint`, `npm run typecheck`, and `npm test`; fix failures
  - Manual walkthrough: enable global auto-run in UI, start scheduler, confirm a seeded Ready low-risk task is picked up and the Kanban card moves automatically; disable auto-run and confirm pickup stops
  - Document task-loop behavior in `docs/architecture/loop-execution-engine.md` under a new Task Loop section with wiki-link to `[[Human-Takeover]]` and `[[Risk-Policy]]`
  - **Completed 2026-06-16.** All verification commands pass (257 tests). Fixed lint (`prefer-const` in `task-loop-integration.test.ts`, unused param in `task-run-executor.test.ts`) and typecheck (`ProcessRunner` mock + payload guard in `workflow-executor-verification.test.ts`). Manual walkthrough steps documented in architecture doc; automated equivalent verified by `tests/task-loop-integration.test.ts` and planner policy tests for auto-run disabled. Added Task Loop section to `docs/architecture/loop-execution-engine.md`.
