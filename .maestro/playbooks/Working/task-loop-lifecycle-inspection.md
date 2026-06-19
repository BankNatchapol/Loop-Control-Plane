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
  - '[[Phase-02-Task-Loop-Automation]]'
  - '[[Risk-Policy]]'
  - '[[Human-Takeover]]'
  - '[[Loop-Execution-Engine]]'
  - '[[GitHub-Issue-Bridge]]'
---

# Task Loop Lifecycle Inspection (Phase 02)

Inspection of existing task lifecycle, context generation, and policy hooks to inform Phase 02 task-loop automation. No code changes in this step — findings only.

## Reusable Transitions

| Target transition | Reuse path | Event(s) | Notes |
|-------------------|------------|----------|-------|
| **Assign to AI** | `LoopBoardRepository.applyTaskAction(taskId, "assign-ai")` → `applyTaskAction` in `lib/loopboard.ts` | `ASSIGNED_TO_AI` | Sets `status: ai-running`, `owner: ai`, `mode: execute`, adds `ai-assigned` label. Triggers `applyAoReadyLabelForRiskPolicy` when linked issue + policy allow. |
| **Move to AI Running** | Same as assign-ai, or `moveTask(taskId, "ai-running", actor: "system")` | `TASK_MOVED` or `ASSIGNED_TO_AI` | Prefer `assign-ai` for engine pickup so owner/mode/labels stay coherent. Status-only move is available via `moveTaskToStatus`. |
| **Needs Review** | `LoopBoardRepository.moveTask(taskId, "needs-review", actor: "system")` | `TASK_MOVED` | No dedicated `TaskAction`; use `moveTask` after executor success. |
| **Blocked** | `applyTaskAction({ action: "mark-blocked" })` or repository wrapper | `BLOCKED` | Sets `status: blocked`, adds `blocked` / `needs-decision` labels; converts AI owner to human. |
| **Done** | `applyTaskAction({ action: "mark-done" })` | `MARKED_DONE` | Sets `status: done`, `owner: human`, `mode: review`. |

### Engine pickup event recommendation

`TaskEventType` has no `ENGINE_PICKUP` or `TASK_ASSIGNED` yet. Options for Phase 02:

1. **Reuse `ASSIGNED_TO_AI`** with `actor: "system"` and a distinct message (e.g. "Engine picked up task for automated execution.") — minimal schema change.
2. **Add `ENGINE_PICKUP`** to `TaskEventType` — clearer audit trail; requires migration of event sanitizers and tests.

Recommend option 1 for Phase 02 unless UI needs a distinct badge type.

## Context Generation

`TaskContextService` (`lib/context/task-context-service.ts`) is the single writer for executor-facing artifacts:

| File | Method | When to call |
|------|--------|--------------|
| `task.md`, `context.md`, `handoff.md`, `events.jsonl` | `generateTaskContext({ task, project, feature })` | On engine job start (before backend invoke) |
| `handoff.md` only | `refreshHandoff(input)` | After status/owner changes mid-run |
| `events.jsonl` | `exportEvents(task)` / `syncExistingTaskEventsFile(task)` | After any task event append |

API wrappers in `lib/api/task-context-actions.ts` load project/feature via `getTaskContextInput(repository, taskId)`.

`generateClaudeCodePrompt` bundles all artifacts into a redacted prompt — useful reference for Phase 03/04 real CLI adapters.

## Policy Hooks

Central service: `lib/policies/automation-policy.ts`.

### For automated task pickup (planner)

Call **`evaluateTaskActionPolicy`** with:

```typescript
evaluateTaskActionPolicy({
  action: "assign-ai",
  task,
  automated: true,           // required — triggers global auto-run + risk gates
  approved: Boolean(task.github.aoReadyApprovedAt),
  automationSettings: repository.getAutomationSettings(),
  projectPolicy: project.automationPolicy,
})
```

Decision handling:

| `kind` | Planner behavior |
|--------|------------------|
| `allow` | Enqueue `task-run` job |
| `requires-approval` | Skip; append explainable reason to task event stream (e.g. `medium_risk_review_gate`, `ao_ready_approval_required`) |
| `deny` | Skip; record `global_auto_run_disabled`, `high_risk_manual_only`, etc. |

**Important:** `LoopBoardRepository.applyTaskAction` today calls `evaluateTaskActionPolicy` **without** `automated: true`, so manual UI actions bypass global auto-run. Engine pickup must **not** call `applyTaskAction` blindly — either pass `automated: true` through a new repository method or evaluate policy in the planner before enqueue.

### AO-ready approval gates (must not bypass)

From `lib/github/github-issues.ts` and repository helpers:

- **`calculateGitHubIssueLabels`**: adds `ao-ready` only when `status === "ready"`, `owner !== "human"`, `risk === "low"`.
- **`applyAoReadyLabelForRiskPolicy`**: applies `ao-ready` on assign-ai/approve-ao-ready only when:
  - Linked GitHub issue exists
  - `owner === "ai"`
  - `evaluateTaskPolicy({ operation: "mark-ao-ready", automated: true })` returns `allow`
  - `hasAoReadyApproval(task)` — low risk **or** `github.aoReadyApprovedAt`
- Medium/high/critical tasks require explicit **`approve-ao-ready`** before automated ao-ready labeling.

Engine auto-pickup must treat `requires-approval` from ao-ready checks the same as assign-ai — never auto-apply ao-ready without prior approval.

## Auto-Pickup Eligibility Matrix

| Condition | Auto-pickup | Rationale |
|-----------|-------------|-----------|
| `status === "ready"` | **Eligible** | Primary pickup column |
| `status === "ready"` + `ao-ready` label (GitHub or local) | **Eligible (optional)** | AO-ready handoff signal; still requires policy allow |
| `owner === "unassigned"` or `owner === "ai"` | **Eligible** | No active human claim |
| `owner === "human"` or `owner === "pairing"` | **Manual only** | Active human involvement |
| `status === "human-working"` | **Never auto** | Human takeover semantics |
| `status === "blocked"` | **Never auto** | Awaiting human decision |
| `status === "ai-running"` with in-flight job | **Skip (dedupe)** | Same task must not double-enqueue |
| `risk === "low"` + `allowLowRiskAutoTaskExecution` (future project flag) | **Eligible when flag on** | Phase 02 task 4 adds this setting (not present yet) |
| `risk === "medium"` | **Requires approval** when `mediumRiskRequiresReview` | AO-ready approval or explicit override |
| `risk === "high"` / `"critical"` | **Deny** when `highRiskManualOnly` (default) | Manual assign-ai only |
| Inferred high-risk categories | Effective risk escalated to `high` | `inferEffectiveTaskRisk` |
| `globalAutoRunEnabled === false` | **Deny automated pickup** | Manual "Run Task Loop" still allowed (Phase 02 task 4) |

### Seed data reference

| Task ID | Status | Owner | Risk | Auto-pickup? |
|---------|--------|-------|------|--------------|
| `task-local-persistence-reset` | ready | unassigned | low | Yes (when global auto-run + future project flag) |
| `task-ai-board-dragging` | ai-running | ai | high | No — already running |
| `task-human-takeover-actions` | human-working | human | critical | No |
| `task-blocked-automation-policy` | blocked | human | high | No |

## Human Takeover Semantics (must preserve)

| Action | Effect | Engine impact |
|--------|--------|---------------|
| `claim-human` | `human-working`, owner human, removes `ao-ready` from issue labels | Engine must not pickup; cancel or skip in-flight job |
| `pause-ai` | Same column as claim-human with `ai-paused` label | Same |
| `return-ai` | owner → ai; status stays `ai-running` or reverts to `ready` | Eligible again after policy check; append handoff note via `appendTaskHandoffNote` |

Existing integration test: `tests/human-takeover-flow.test.ts`.

## Existing Engine Infrastructure (gaps for Phase 02)

| Component | Status |
|-----------|--------|
| `EngineJobKind: "task-run"` | Declared in `loop-engine-types.ts`; stub executor accepts it |
| `task-loop-planner.ts` | **Not implemented** |
| `task-run-executor.ts` | **Not implemented** |
| Scheduler task pickup on tick | **Not implemented** — only dequeues existing queued jobs |
| Job dedupe per taskId | **Not implemented** — `createEngineJob` has no uniqueness constraint |
| `allowLowRiskAutoTaskExecution` project setting | **Not implemented** |

Repository already supports `taskId` on engine jobs (`createEngineJob`, `listEngineJobs` filter).

## Recommended Phase 02 Integration Sequence

1. **Planner** scans board → `evaluateTaskActionPolicy({ action: "assign-ai", automated: true })` → enqueue with dedupe.
2. **Executor** on start: `generateTaskContext` → `applyTaskAction` or system-level assign with `actor: "system"` → invoke stub backend.
3. **Executor** on success: `moveTask(..., "needs-review")` → `refreshHandoff` → `exportEvents`.
4. **Executor** on failure: retry via existing `processEngineJob` semantics; on exhaustion `mark-blocked` or stay in `ai-running` per retry budget.
5. **Scheduler tick**: after policy check, call planner (concurrency limit 1) before `fetchNextQueuedJob`.

## Cross-References

- [[Risk-Policy]] — policy codes and default posture
- [[Human-Takeover]] — claim/pause/return flows
- [[Loop-Execution-Engine]] — job lifecycle and stub backend
- [[GitHub-Issue-Bridge]] — ao-ready labeling rules
