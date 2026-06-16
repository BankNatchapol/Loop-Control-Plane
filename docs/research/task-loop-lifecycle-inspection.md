---
type: research
title: Task Loop Lifecycle Inspection (Phase 02)
created: 2026-06-16
tags:
  - task-loop
  - engine
  - automation
  - inspection
related:
  - '[[Risk-Policy]]'
  - '[[Human-Takeover]]'
  - '[[Loop-Execution-Engine]]'
  - '[[GitHub-Issue-Bridge]]'
---

# Task Loop Lifecycle Inspection (Phase 02)

Inspection of existing task lifecycle, context generation, and policy hooks to inform Phase 02 task-loop automation.

## Reusable Transitions

| Target transition | Reuse path | Event(s) | Notes |
|-------------------|------------|----------|-------|
| **Assign to AI** | `LoopBoardRepository.applyTaskAction(taskId, "assign-ai")` → `applyTaskAction` in `lib/loopboard.ts` | `ASSIGNED_TO_AI` | Sets `status: ai-running`, `owner: ai`, `mode: execute`, adds `ai-assigned` label. Triggers `applyAoReadyLabelForRiskPolicy` when linked issue + policy allow. |
| **Move to AI Running** | Same as assign-ai, or `moveTask(taskId, "ai-running", actor: "system")` | `TASK_MOVED` or `ASSIGNED_TO_AI` | Prefer `assign-ai` for engine pickup so owner/mode/labels stay coherent. |
| **Needs Review** | `LoopBoardRepository.moveTask(taskId, "needs-review", actor: "system")` | `TASK_MOVED` | No dedicated `TaskAction`; use after executor success. |
| **Blocked** | `applyTaskAction({ action: "mark-blocked" })` | `BLOCKED` | Sets `status: blocked`, adds `blocked` / `needs-decision` labels. |
| **Done** | `applyTaskAction({ action: "mark-done" })` | `MARKED_DONE` | Sets `status: done`, `owner: human`, `mode: review`. |

For engine pickup events, reuse `ASSIGNED_TO_AI` with `actor: "system"` unless a distinct `ENGINE_PICKUP` type is added later.

## Context Generation

`TaskContextService` (`lib/context/task-context-service.ts`) writes executor-facing artifacts:

| File | Method | When to call |
|------|--------|--------------|
| `task.md`, `context.md`, `handoff.md`, `events.jsonl` | `generateTaskContext({ task, project, feature })` | On engine job start |
| `handoff.md` | `refreshHandoff(input)` | After status/owner changes mid-run |
| `events.jsonl` | `exportEvents(task)` / `syncExistingTaskEventsFile(task)` | After task event append |

API wrappers live in `lib/api/task-context-actions.ts`.

## Policy Hooks

For automated pickup, call `evaluateTaskActionPolicy` with `action: "assign-ai"` and **`automated: true`**. The repository's `applyTaskAction` omits `automated`, so manual UI actions bypass global auto-run — the planner must evaluate policy explicitly before enqueue.

| Decision | Planner behavior |
|----------|------------------|
| `allow` | Enqueue `task-run` job |
| `requires-approval` | Skip; record reason on task event stream |
| `deny` | Skip; record policy code |

### AO-ready gates (do not bypass)

- `calculateGitHubIssueLabels` adds `ao-ready` only for ready + non-human owner + low risk.
- `applyAoReadyLabelForRiskPolicy` requires linked issue, `owner === "ai"`, policy allow, and `aoReadyApprovedAt` or low risk.
- Medium/high/critical tasks need explicit `approve-ao-ready` before automated ao-ready labeling.

## Auto-Pickup Eligibility

| Condition | Auto-pickup |
|-----------|-------------|
| `status === "ready"`, owner unassigned or ai | Eligible (policy permitting) |
| `status === "ready"` + ao-ready label | Eligible (optional AO signal) |
| `human-working`, `blocked` | Never |
| Human owner or pairing | Manual only |
| In-flight `task-run` job for same task | Skip (dedupe needed) |
| High/critical risk, default project policy | Deny |
| Medium risk + `mediumRiskRequiresReview` | Requires approval |
| `globalAutoRunEnabled === false` | Deny automated pickup; manual enqueue OK |

Seed reference: `task-local-persistence-reset` (ready, unassigned, low) is the primary auto-pickup candidate.

## Human Takeover (preserve)

- `claim-human` / `pause-ai` → human-working; engine must not pickup.
- `return-ai` → owner ai, eligible again after policy check; use `appendTaskHandoffNote`.

See `tests/human-takeover-flow.test.ts`.

## Gaps for Phase 02

| Component | Status |
|-----------|--------|
| `task-loop-planner.ts` | Not implemented |
| `task-run-executor.ts` | Not implemented |
| Scheduler task pickup on tick | Not implemented |
| Job dedupe per taskId | Not implemented |
| `allowLowRiskAutoTaskExecution` project setting | Not implemented |

`EngineJobKind: "task-run"` and stub executor support exist; repository supports `taskId` on engine jobs.

## Recommended Integration Sequence

1. Planner scans board → policy check → enqueue with dedupe.
2. Executor start: `generateTaskContext` → system assign-ai → stub backend.
3. Success: `moveTask(..., "needs-review")` → refresh context files.
4. Failure: existing retry semantics; exhaustion → blocked or stay running per budget.
5. Scheduler tick: call planner (concurrency 1) before dequeue.

## Cross-References

- [[Risk-Policy]]
- [[Human-Takeover]]
- [[Loop-Execution-Engine]]
- [[GitHub-Issue-Bridge]]
