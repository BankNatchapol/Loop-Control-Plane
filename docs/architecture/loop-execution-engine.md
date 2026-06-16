---
type: reference
title: Loop Execution Engine
created: 2026-06-16
tags:
  - engine
  - scheduler
  - executor
  - loopboard
related:
  - '[[Workflow-Editor-Runner]]'
  - '[[Workflow-Node-Executors]]'
  - '[[Spec-Kit-Importer]]'
  - '[[GitHub-Issue-Bridge]]'
  - '[[Risk-Policy]]'
  - '[[Security-Policy]]'
---

# Loop Execution Engine

Phase 01 adds a hybrid loop execution engine to Loop Control Plane. An in-app scheduler dequeues persisted jobs from SQLite, resolves a pluggable executor backend, and records redacted execution logs. Heavy work is delegated to executor implementations. Phase 03 wires the workflow graph runner in [[Workflow-Editor-Runner]] to enqueue `workflow-step` jobs that invoke real node executors (Spec Kit CLI, task import, GitHub delivery, test runs, AI review stubs) through the engine queue.

Automation gates from [[Risk-Policy]] and trusted-input boundaries from [[Security-Policy]] apply before any automated scheduler tick. Global auto-run stays off by default.

## Hybrid Architecture

```mermaid
flowchart LR
  Dashboard["Dashboard Engine Panel"]
  API["Engine API Routes"]
  Scheduler["LoopScheduler"]
  Registry["ExecutorRegistry"]
  Stub["StubExecutor"]
  SQLite["SQLite engine_jobs"]
  Future["Future CLIs\n(cursor, claude-code, codex, AO)"]

  Dashboard --> API
  API --> Scheduler
  Scheduler --> SQLite
  Scheduler --> Registry
  Registry --> Stub
  Registry -.-> Future
```

| Layer | Responsibility |
|-------|----------------|
| **Dashboard panel** | Polls status, enqueues demo jobs, manual tick, start/stop scheduler |
| **API routes** | `GET /api/engine/status`, `POST /api/engine/{start,stop,tick,demo-job}` |
| **LoopScheduler** | Tick orchestration, policy checks, dequeue, finalize job state |
| **ExecutorRegistry** | Maps `(backend, jobKind)` to an `Executor` implementation |
| **SQLite** | `engine_jobs` queue + `engine_scheduler_state` singleton |
| **Background interval** | When scheduler is `running` and global auto-run is on, `POST /api/engine/start` starts process-memory ticks every 3s |

The scheduler is not a separate daemon. It runs inside the Next.js Node process and advances work only on explicit ticks (manual button, background interval, or test harness).

## Executor Backends

Backends are declared in `lib/engine/loop-engine-types.ts`:

| Backend | Phase 01 status | Phase 03 usage |
|---------|-----------------|----------------|
| `stub` | **Implemented** | Default backend for demo jobs, workflow-step dispatch, and deterministic test doubles |
| `cursor` | Reserved | Future Cursor CLI / SDK adapter |
| `claude-code` | Reserved | Future Claude Code CLI adapter |
| `codex` | Reserved | Future Codex CLI adapter |
| `agent-orchestrator` | Reserved | Future Agent Orchestrator handoff |

Only `stub` is registered in `IMPLEMENTED_EXECUTOR_BACKENDS`. Requests for other backends return explainable errors (`executor_backend_unknown` or `executor_backend_disabled`) with human-readable reasons from `describeExecutorBackendAvailability`.

### ExecutorConfig on Nodes and Task Runs

Per-step backend settings live in existing JSON `config`, not a new column:

```json
{
  "executor": {
    "backend": "stub",
    "command": "optional-command",
    "workingDirectory": "/path/to/repo",
    "timeoutMs": 60000,
    "envAllowlist": ["NODE_ENV"]
  }
}
```

Helpers `readExecutorConfig`, `validateExecutorConfig`, and `withExecutorConfig` read and validate nested `config.executor`. Invalid config produces structured validation issues for the UI and API.

## Job Lifecycle

### Job kinds

| Kind | Usage |
|------|-------|
| `demo-ping` | Dashboard **Run Demo Job** — stub backend smoke test |
| `task-run` | Reserved — future task-scoped executor runs |
| `workflow-step` | **Implemented (Phase 03)** — bridge from workflow runner to node executors |

### Job statuses

`queued` → `running` → `completed` | `failed` | `cancelled`

1. **Enqueue** — `createEngineJob` inserts a row with `status: queued`, `attempt: 1`, and initial execution logs.
2. **Tick plan** — `planNextTick` checks scheduler state, global automation policy (for automated ticks), and whether a queued job exists.
3. **Dequeue** — `fetchNextQueuedJob` returns the oldest eligible job (FIFO by `queued_at`).
4. **Execute** — Job marked `running`; registry resolves executor; `execute` returns stdout/stderr summaries and log entries.
5. **Finalize** — `processEngineJob` sets `completed` on success, or increments `attempt` and requeues when under `maxAttempts`, otherwise `failed` with redacted error text.

### Scheduler states

| State | Meaning |
|-------|---------|
| `stopped` | Default on boot; no automatic ticks |
| `running` | Accepts automated ticks when global auto-run is enabled |
| `paused` | Skips automated ticks until resumed |

Transitions: `start`, `stop`, `pause` via `applySchedulerTransition` and `LoopScheduler` service methods.

### Retry semantics

Failed executor results increment `attempt`. When `attempt < maxAttempts`, the job returns to `queued` with a retry log entry. Otherwise it stays `failed` with redacted error text in `error` and execution logs.

## Policy Gates

Engine behavior follows `lib/policies/automation-policy.ts`:

| Action | Global auto-run off | Global auto-run on |
|--------|---------------------|---------------------|
| **Run Demo Job** (`POST /api/engine/demo-job`) | Allowed | Allowed |
| **Tick Once** (`POST /api/engine/tick`, manual mode) | Allowed | Allowed |
| **Start Scheduler** (`POST /api/engine/start`) | **403** — policy deny | Allowed; starts background interval |
| **Automated tick** (background interval) | Skipped — policy deny | Allowed when scheduler is `running` |

`evaluateGlobalAutomationPolicy` returns `deny` with code `global_auto_run_disabled` when `globalAutoRunEnabled` is false. The dashboard **Start Scheduler** button is disabled and shows `describeEffectiveAutomationPolicy` reasons.

Manual ticks bypass the global policy gate so developers can exercise the engine without enabling background automation.

## Log Redaction

Engine logs pass through `redactEngineLogEntry` and `redactSensitiveText` (`lib/security/safe-context.ts`), matching patterns used by the workflow runner: tokens, secrets, passwords, bearer values, and api-key-shaped strings are replaced before persistence and API responses.

## Persistence

Migration `db/migrations/0008_loop_engine.sql` adds:

- **`engine_jobs`** — job queue with JSON `payload`, `result`, and `execution_logs`; optional FKs to projects, tasks, and workflow runs; indexes on `status`, `(status, queued_at)`, and project lookups.
- **`engine_scheduler_state`** — singleton row `id = 'default'`; initialized to `stopped` with `tick_count = 0`.

`LoopBoardRepository` exposes create/list/get/update job methods, `appendEngineLogEntry`, `fetchNextQueuedJob`, and scheduler read/update helpers. Seed data includes one completed historical `demo-ping` job for dashboard display; the scheduler is **not** auto-started on boot.

## API and Client Helpers

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engine/status` | GET | Scheduler state, queue counts by status, latest 10 jobs (redacted summaries), automation policy |
| `/api/engine/start` | POST | Start scheduler + background ticks (requires global auto-run) |
| `/api/engine/stop` | POST | Stop scheduler + clear background interval |
| `/api/engine/tick` | POST | Single tick; body `{ mode?: "manual" \| "automated" }` |
| `/api/engine/demo-job` | POST | Enqueue stub `demo-ping` for `{ projectId }` |

Typed client helpers in `lib/api/loopboard-client.ts`: `fetchEngineStatus`, `startEngineScheduler`, `stopEngineScheduler`, `tickEngine`, `enqueueEngineDemoJob`.

## Dashboard Engine Panel

The **Loop Engine** panel on the project dashboard (`app/page.tsx`) shows:

- Scheduler status badge (`stopped` / `running` / `paused`)
- Queue depth and last tick time
- Active backend from the most recent job
- Recent job rows with status badges and last log message

Controls: **Run Demo Job**, **Tick Once**, **Start Scheduler**, **Stop Scheduler**. Status polls every 3 seconds while the dashboard is open.

The workflow runner panel also shows the latest engine job for the current workflow step and exposes **Run Next Step (Engine)** when global auto-run is off (see [[Workflow-Editor-Runner]]).

## Workflow Executors

Phase 03 connects the graph runner to the engine queue. When automation policy allows (including after human approval on semi nodes), `runNextWorkflowStep` enqueues `workflow-step` jobs instead of completing automatable nodes inline. Steps enter `running` status until `LoopScheduler.tick` finishes the job and calls `completeWorkflowStepFromEngineJob`, which links artifacts, appends feature/task events, and advances the graph (including conditional edges via `branchLabel` from executors such as `ai-review`).

```mermaid
sequenceDiagram
  participant Runner as Workflow Runner
  participant SQLite as engine_jobs
  participant Scheduler as LoopScheduler
  participant Dispatcher as workflow-step-dispatcher
  participant Executor as Node Executor

  Runner->>SQLite: enqueue workflow-step job
  Runner->>Runner: step status running
  Scheduler->>SQLite: dequeue job
  Scheduler->>Dispatcher: StubExecutor workflowStepHandler
  Dispatcher->>Executor: spec-kit / import / GitHub / tests / review
  Executor-->>Scheduler: success + outputArtifacts
  Scheduler->>Runner: completeWorkflowStepFromEngineJob
  Runner->>Runner: advance currentNodeId
```

| Node type | Executor module | Reuses |
|-----------|-----------------|--------|
| `spec-kit-actions` | `lib/engine/executors/spec-kit-actions-executor.ts` | Spec Kit CLI via `process-runner` |
| `import-tasks` | `lib/engine/executors/import-tasks-executor.ts` | [[Spec-Kit-Importer]] |
| `create-github-issues` | `lib/engine/executors/create-github-issues-executor.ts` | [[GitHub-Issue-Bridge]] |
| `open-pr` | `lib/engine/executors/open-pr-executor.ts` | [[GitHub-Issue-Bridge]] PR helpers |
| `run-tests` | `lib/engine/executors/run-tests-executor.ts` | `process-runner` npm-test profile |
| `ai-review` | `lib/engine/executors/ai-review-executor.ts` | Stub review backend; `branchLabel` for edges |

Approval-gate nodes (`human-input`, `human-review`, `manual-claude-code-edit`, `merge`) still pause for operator approval. Executors prepare context but never bypass `evaluateWorkflowNodePolicy`. External and GitHub-derived artifacts are tagged `[external/untrusted]` per [[Security-Policy]].

Subprocess safety (allowlisted commands, cwd validation, timeouts, redacted logs) lives in `lib/engine/process-runner.ts`. Full node mapping, config schema, and editor UI are documented in [[Workflow-Node-Executors]].

Verification: `npm run db:migrate`, `npm run lint`, `npm run typecheck`, and `npm test` (228 tests). Feature Development Loop walkthrough coverage lives in `tests/workflow-executor-verification.test.ts` (human-input → spec-kit-actions with mocked CLI → human-review → import-tasks, confirming board tasks and workflow events).

## Key Source Files

| Path | Role |
|------|------|
| `lib/engine/loop-engine-types.ts` | Domain types, executor config validation |
| `lib/engine/executor-registry.ts` | `Executor` interface, `StubExecutor`, registry |
| `lib/engine/loop-scheduler.ts` | Tick orchestration, pure test helpers |
| `lib/engine/scheduler-interval.ts` | Process-memory background tick interval |
| `lib/api/engine-actions.ts` | Status aggregation and route action handlers |
| `app/api/engine/**` | HTTP route handlers |
| `lib/engine/executors/workflow-step-dispatcher.ts` | Routes `workflow-step` jobs to node executors |
| `lib/engine/process-runner.ts` | Audited subprocess execution for CLIs |
| `lib/workflows/workflow-runner.ts` | Graph state machine; enqueues engine jobs |
| `tests/loop-engine-*.test.ts` | Types, scheduler, repository, API coverage |
| `tests/workflow-engine-integration.test.ts` | Trimmed import-tasks → create-github-issues engine path |
| `tests/workflow-executor-verification.test.ts` | Feature Development Loop walkthrough verification |

## Intentional Non-Goals (remaining)

- **No real agent CLI backends yet** — Cursor, Claude Code, Codex, and Agent Orchestrator backends are typed and validated but adapters are Phase 04 work.
- **No task-run automation** — Task cards do not auto-spawn engine jobs.
- **No global auto-run by default** — Operators must explicitly enable automation before the scheduler runs unattended.
- **No distributed queue** — Single-process SQLite queue; no Redis, no multi-instance coordination.

Future phases will register real agent executors, wire `task-run` jobs to task context handoff artifacts, and extend review/implementation backends. See [[Workflow-Node-Executors]] for the Phase 03 node-type mapping and config schema.

## Related Documents

- [[Workflow-Editor-Runner]] — graph runner, approval gates, runner panel engine controls
- [[Workflow-Node-Executors]] — per-node executor modules, process runner, config schema
- [[Spec-Kit-Importer]] — task import reuse for `import-tasks` workflow steps
- [[GitHub-Issue-Bridge]] — issue and PR helpers for delivery nodes
- [[Risk-Policy]] — global auto-run defaults and risk gates
- [[Security-Policy]] — token handling and trusted-input rules
- [[loop-engine-execution-boundaries]] — Phase 01 inspection notes on reuse boundaries
