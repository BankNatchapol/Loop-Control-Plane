# Phase 01: Loop Engine Foundation

This phase transforms Loop Control Plane from a manual tracking board into a hybrid loop engine skeleton that actually runs work. It adds an in-app scheduler, a pluggable executor registry with per-step backend configuration, persisted job/run state in SQLite, and a visible Engine panel on the dashboard. By the end, a developer can start the app, enqueue a demo job, watch the scheduler tick, see logs update in real time, and confirm the engine respects the existing conservative automation policy — without any user decisions mid-run.

## Tasks

- [x] Inspect existing execution boundaries and reuse patterns before adding engine code:
  - Read `lib/workflows/workflow-runner.ts`, `lib/policies/automation-policy.ts`, `lib/system/local-command-runner.ts`, `lib/context/task-context-service.ts`, `lib/api/loopboard-http.ts`, and `docs/architecture/workflow-editor-runner.md`
  - Confirm the MVP runner only records deterministic logs today; Phase 01 replaces that gap with a real engine layer, not another placeholder
  - Reuse repository patterns from `lib/db/loopboard-repository.ts`, API route conventions from `app/api/**`, and dashboard UI patterns from `app/page.tsx`
  - Do not enable global auto-run by default; the engine must stay off until policy explicitly allows it
  - **Completed 2026-06-16:** Full inspection documented in [[loop-engine-execution-boundaries]] (`docs/research/loop-engine-execution-boundaries.md`). Key findings: (1) `workflow-runner.ts` completes auto nodes with `"completed deterministically"` logs only — no CLI/shell execution; (2) `defaultAutomationSettings.globalAutoRunEnabled` is `false` and `evaluateGlobalAutomationPolicy` denies automated ticks until explicitly enabled; (3) `local-command-runner.ts` uses a fixed allowlist (not general execution) — future executors should follow the same narrow-adapter pattern; (4) `task-context-service.ts` prepares handoff artifacts but does not invoke agents; (5) reuse `withLoopBoardRepository`/`jsonOk`/`handleApiError` for API routes, `LoopBoardRepository` JSON-column patterns for job persistence (next migration `0008`), and dashboard badge/button styling from `app/page.tsx`; (6) no `lib/engine/` code exists yet — Phase 01 adds the real engine layer without another placeholder runner.

- [x] Define loop engine domain types and executor registry:
  - Add `lib/engine/loop-engine-types.ts` with types for `ExecutorBackend` (`stub`, `cursor`, `claude-code`, `codex`, `agent-orchestrator`), `EngineJobKind` (`demo-ping`, `task-run`, `workflow-step`), `EngineJobStatus` (`queued`, `running`, `completed`, `failed`, `cancelled`), `EngineJob`, `EngineRunLogEntry`, and `EngineSchedulerState` (`stopped`, `running`, `paused`)
  - Add `ExecutorConfig` on workflow nodes and task runs: `{ backend: ExecutorBackend; command?: string; workingDirectory?: string; timeoutMs?: number; envAllowlist?: string[] }` — stored in existing node `config` JSON, not a new column yet
  - Add `lib/engine/executor-registry.ts` with an `Executor` interface (`canHandle`, `execute`, `cancel`) and a registry that resolves backend + job kind to an executor implementation
  - Register a built-in `stub` executor that completes deterministically with redacted stdout/stderr summaries for demo and tests
  - Export helpers to validate executor config and produce explainable errors when a backend is unknown or disabled
  - **Completed 2026-06-16:** Added `lib/engine/loop-engine-types.ts` (domain types, `ExecutorConfig` nested under `config.executor` via `readExecutorConfig`/`withExecutorConfig`, validation + resolution helpers) and `lib/engine/executor-registry.ts` (`Executor` interface, `StubExecutor`, `ExecutorRegistry`, `defaultExecutorRegistry`). Non-stub backends return `executor_backend_unknown` or `executor_backend_disabled` with reasons. Added `tests/loop-engine-types.test.ts` (8 cases); `npm run typecheck`, `lint`, and full test suite pass (158 tests).

- [x] Persist engine jobs and scheduler state in SQLite:
  - Extend `lib/db/schema.ts` with `engine_jobs` (id, kind, status, backend, projectId, taskId, workflowRunId, workflowNodeId, payload JSON, result JSON, executionLogs JSON, error, attempt, maxAttempts, queuedAt, startedAt, completedAt, createdAt, updatedAt) and `engine_scheduler_state` (singleton row: status, lastTickAt, tickCount, lastError, updatedAt)
  - Add migration `db/migrations/0008_loop_engine.sql` with JSON validation, foreign keys to projects/tasks/workflow runs where applicable, and indexes for status + queued time lookups
  - Extend `LoopBoardRepository` with create/list/get/update engine job methods, append engine log entries, fetch next queued job, and read/update scheduler state
  - Seed one completed historical demo job in `db/seed.ts` only if useful for dashboard display; do not auto-start the scheduler on boot
  - **Completed 2026-06-16:** Added migration `0008_loop_engine.sql` (`engine_jobs` + singleton `engine_scheduler_state` with FK/index constraints), Drizzle schema tables, `LoopBoardRepository` engine CRUD (`createEngineJob`, `listEngineJobs`, `getEngineJob`, `updateEngineJob`, `appendEngineLogEntry`, `fetchNextQueuedJob`, `getEngineSchedulerStatus`, `updateEngineSchedulerStatus`), seed completed `engine-job-seed-demo-ping` demo job, and `tests/loop-engine-repository.test.ts` (4 cases). Scheduler initializes `stopped` on migration; no auto-start on boot. `npm run typecheck`, `lint`, and full suite pass (162 tests).

- [x] Implement the hybrid in-app scheduler service:
  - Add `lib/engine/loop-scheduler.ts` that owns tick orchestration: read scheduler state, respect `evaluateGlobalAutomationPolicy`, dequeue at most one eligible job per tick, mark running, invoke the executor registry, persist results/logs, and finalize status
  - Support explicit `start`, `stop`, and `pause` transitions without requiring a separate daemon process; heavy work stays delegated to executor implementations (stub now, real CLIs later)
  - Add safe retry semantics: failed jobs increment attempt, requeue when under `maxAttempts`, otherwise mark failed with redacted error text
  - Redact token/secret/password/api-key shaped values in engine logs using the same patterns as `lib/workflows/workflow-runner.ts` and `lib/security/safe-context.ts`
  - Expose pure functions for unit tests: `planNextTick`, `processEngineJob`, `applySchedulerTransition`
  - **Completed 2026-06-16:** Added `lib/engine/loop-scheduler.ts` with `LoopScheduler` service (`start`/`stop`/`pause`/`tick`), pure helpers `planNextTick` (automated ticks honor scheduler state + global auto-run policy; manual ticks bypass policy), `processEngineJob` (success completion + retry/requeue up to `maxAttempts`), `applySchedulerTransition`, and `redactEngineLogEntry` via `redactSensitiveText`. Added `tests/loop-scheduler.test.ts` (8 cases). `npm run typecheck`, `lint`, and full suite pass (170 tests).

- [x] Add engine API routes and client helpers:
  - Add `GET /api/engine/status` returning scheduler state, queue counts by status, and the latest 10 jobs with redacted summaries
  - Add `POST /api/engine/start`, `POST /api/engine/stop`, and `POST /api/engine/tick` (manual single tick for development and tests)
  - Add `POST /api/engine/demo-job` that enqueues a `demo-ping` stub job for the selected project without requiring global auto-run to be enabled
  - Add typed client helpers in `lib/api/loopboard-client.ts` mirroring existing API patterns (`withLoopBoardRepository`, `jsonOk`, `handleApiError`)
  - Return policy-deny explanations from start/tick endpoints when global auto-run is disabled, except allow manual tick and demo-job enqueue paths
  - **Completed 2026-06-16:** Added `lib/api/engine-actions.ts` (status aggregation, scheduler start/stop, manual/automated tick, demo-ping enqueue, redacted job summaries), five routes under `app/api/engine/` (`status`, `start`, `stop`, `tick`, `demo-job`), `LoopSchedulerError` handling in `loopboard-http.ts`, and client helpers (`fetchEngineStatus`, `startEngineScheduler`, `stopEngineScheduler`, `tickEngine`, `enqueueEngineDemoJob`) in `loopboard-client.ts`. Start and automated tick return 403 with policy code when global auto-run is off; manual tick and demo-job work regardless. Added `tests/engine-actions.test.ts` (6 cases). `npm run typecheck`, `lint`, and full suite pass (176 tests).

- [x] Build the Engine dashboard panel and wire optional background ticks:
  - Add a compact **Loop Engine** panel to the project dashboard in `app/page.tsx` showing scheduler status, queue depth, last tick time, active backend, and recent job rows with status badges
  - Add controls: **Run Demo Job**, **Tick Once**, **Start Scheduler**, **Stop Scheduler** — disable Start when global auto-run is off and show the effective policy reason from `describeEffectiveAutomationPolicy`
  - When global auto-run is enabled and scheduler is running, trigger periodic ticks from a server-side interval started via `POST /api/engine/start` (store interval ownership in process memory; stop cleanly on `POST /api/engine/stop` and do not leak intervals across hot reload in dev without at least clearing on stop)
  - Poll engine status every few seconds while the dashboard is open so job completion is visible without manual refresh
  - Match existing dense developer-tool styling; avoid modal-heavy UX
  - **Completed 2026-06-16:** Added `LoopEnginePanel` to `app/page.tsx` (scheduler badge, queue depth, last tick, active backend, recent jobs table with status badges, four action buttons with Start gated on global auto-run + policy message). Client polls `GET /api/engine/status` every 3s. Added `lib/engine/scheduler-interval.ts` for process-memory background ticks wired from `startEngineScheduler`/`stopEngineScheduler`; auto-stops when scheduler leaves `running`. Added `tests/scheduler-interval.test.ts` (4 cases). `npm run typecheck`, `lint`, and full suite pass (180 tests).

- [x] Write loop engine foundation tests:
  - Add `tests/loop-engine-types.test.ts` for executor config validation and backend resolution
  - Add `tests/loop-scheduler.test.ts` covering enqueue/dequeue, stub executor success, retry on failure, policy deny when global auto-run disabled, manual tick allowed, and log redaction
  - Add `tests/loop-engine-api.test.ts` for status/demo-job/start/stop/tick route behavior using the repository test harness patterns from existing API tests
  - Update any board-data or seed tests affected by new tables/fields
  - **Completed 2026-06-16:** Confirmed `tests/loop-engine-types.test.ts` (8 cases) and `tests/loop-scheduler.test.ts` (9 cases, added explicit enqueue/dequeue FIFO test). Added `tests/loop-engine-api.test.ts` (5 route-level cases via `LOOPBOARD_DATABASE_PATH` harness). Extended `tests/db-seed.test.ts` with `engine_jobs`/`engine_scheduler_state` counts and engine indexes. Fixed `withLoopBoardRepository` async handling so tick routes keep the SQLite connection open until executor work completes. `npm test` passes (186 tests).

- [x] Document the engine foundation and verify the working prototype end-to-end:
  - Create `docs/architecture/loop-execution-engine.md` with YAML front matter (`type: reference`, tags: `engine`, `scheduler`, `executor`, `loopboard`) and wiki-links to `[[Workflow-Editor-Runner]]`, `[[Risk-Policy]]`, and `[[Security-Policy]]`
  - Document hybrid architecture (in-app scheduler + external executors), executor backend enum, job lifecycle, policy gates, and intentional non-goals for this phase (no real Cursor/Claude/Codex/AO invocation yet)
  - Run `npm run db:migrate`, `npm run lint`, `npm run typecheck`, and `npm test`; fix failures
  - Start the dev server, open the dashboard, click **Run Demo Job**, click **Tick Once**, and verify the job moves queued → running → completed with visible logs in the Engine panel
  - Leave the dev server running and note the local URL when complete
  - **Completed 2026-06-16:** Added `docs/architecture/loop-execution-engine.md` (hybrid architecture diagram, executor backends, job lifecycle, policy gates, API routes, dashboard panel, Phase 01 non-goals). Fixed async `withLoopBoardRepository` typing by making the helper always return `Promise<T>` and adding `await` across API routes. Verified via `npm run db:migrate`, `lint`, `typecheck`, and full test suite (186 tests). E2E confirmed via live dev server at **http://localhost:3000**: demo job enqueued (`queued`), manual tick processed job to `completed` with 5 execution log entries and last message "Engine job completed successfully." Dev server left running.
