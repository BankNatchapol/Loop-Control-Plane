---
type: research
title: Loop Engine Execution Boundaries Inspection
created: 2026-06-16
tags:
  - engine
  - scheduler
  - workflow-runner
  - automation-policy
related:
  - '[[Phase-01-Loop-Engine-Foundation]]'
  - '[[Workflow-Editor-Runner]]'
  - '[[Risk-Policy]]'
  - '[[Security-Policy]]'
---

# Loop Engine Execution Boundaries Inspection

Phase 01 task 1 research notes. Confirms where execution lives today and what the loop engine layer should reuse vs replace.

## MVP Workflow Runner Gap (Confirmed)

`lib/workflows/workflow-runner.ts` is a **state machine + audit logger**, not an execution engine:

- Auto nodes complete with `"completed deterministically"` log entries — no shell, CLI, or external tool invocation.
- Policy gates run through `evaluateWorkflowNodePolicy` before any step advances; denied or approval-required nodes pause the run.
- Output artifacts resolve path placeholders (`{run}`, `{feature}`, `{repository}`) but are references only.
- Completed steps link to feature/task context via `linkCompletedStepToContext` (events, not execution).
- Inline log redaction uses token/secret/password/bearer/api-key patterns (subset of `lib/security/safe-context.ts`).

**Phase 01 intent:** Add a real engine layer (`lib/engine/*`) that can dequeue and execute jobs via a pluggable executor registry. The workflow runner remains the graph/state orchestrator; engine jobs will eventually back `workflow-step` and `task-run` kinds.

## Automation Policy Boundaries

`lib/policies/automation-policy.ts`:

| Setting / function | Default / behavior |
|---|---|
| `defaultAutomationSettings.globalAutoRunEnabled` | **`false`** |
| `evaluateGlobalAutomationPolicy()` | Returns `deny` with code `global_auto_run_disabled` when off |
| `deniesAutomatedGlobalSetting()` | Blocks any `automated: true` path when global auto-run is off |
| `describeEffectiveAutomationPolicy()` | Aggregates global + project policy reasons for UI display |

Engine scheduler **must** call `evaluateGlobalAutomationPolicy` before automatic ticks. Manual tick and demo-job enqueue paths (per Phase 01 spec) should remain allowed without global auto-run.

Dashboard already surfaces policy state: header badge, global auto-run checkbox, and `effectiveAutomationPolicy` memo in `app/page.tsx`.

## Local Command Runner (Narrow, Not General Execution)

`lib/system/local-command-runner.ts`:

- Fixed allowlist: `code`, `open`, `explorer.exe`, `xdg-open` only.
- `redactSensitiveCommandValue` + path traversal validation via `validateLocalDirectory`.
- Detached spawn with minimal env — no arbitrary shell.

Future real executors (cursor, claude-code, codex) should follow this **narrow, audited adapter** pattern rather than passing raw node config strings to `spawn`.

## Task Context Service (Handoff Prep, Not Execution)

`lib/context/task-context-service.ts`:

- Writes `task.md`, `context.md`, `handoff.md`, `events.jsonl` under `data/task-contexts/`.
- Generates Claude Code prompts with `redactSensitiveText`; separates generated vs human-edited handoff sections.
- Does **not** invoke agents — prepares artifacts for human or future executor consumption.

Engine `task-run` jobs should integrate with context generation but delegate actual CLI invocation to executor implementations.

## HTTP / API Conventions to Reuse

`lib/api/loopboard-http.ts`:

```typescript
export const runtime = "nodejs"; // in route files

withLoopBoardRepository((repository) => { /* open DB, migrate, operate, close */ })
jsonOk(data) / jsonError(message, status, code)
handleApiError(error) // maps LoopBoardRepositoryError, domain errors
readJsonBody(request)
```

Route pattern (see `app/api/settings/automation/route.ts`, `app/api/workflow-runs/[runId]/actions/route.ts`):

1. Parse/validate body in route or small builder function.
2. Delegate to lib service with repository injected.
3. Return `jsonOk` or `handleApiError`.

Client mirror in `lib/api/loopboard-client.ts`: `readApiResponse`, `writeJson`, typed exports, `LoopBoardApiError`.

## Repository Patterns to Extend

`lib/db/loopboard-repository.ts`:

- Class methods with prepared statements, `json()` serialization for JSON columns.
- `inTransaction()` for multi-row writes.
- Domain errors: `ValidationError`, `NotFoundError`, `UnsupportedTransitionError`.
- `listBoardData()` aggregates projects, features, tasks, latest workflow runs, automation settings.
- Workflow run CRUD (`createWorkflowRun`, `upsertWorkflowRunStep`, `updateWorkflowRun`) is the closest analog for engine job persistence — same status lifecycle + execution logs JSON pattern.

Next migration slot: **`0008_loop_engine.sql`** (after `0007_automation_policy_settings.sql`). No `lib/engine/` code exists yet.

## Dashboard UI Patterns for Engine Panel

From `app/page.tsx`:

- Dense layout: bordered `border-slate-200` panels, `bg-slate-50` sections, compact `text-xs` controls.
- Status badges: conditional Tailwind (emerald = enabled, rose = disabled).
- Lucide icons inline with labels; buttons use `inline-flex`, `gap-1.5`, hover sky accents.
- Policy reason display via `describeEffectiveAutomationPolicy` memo — reuse for disabled Start Scheduler tooltip/message.
- Polling: `loadBoard(selectedProject?.id)` on interval or after actions; engine panel should poll `/api/engine/status` similarly.
- `data-testid` attributes on key dashboard sections for testability.

## Log Redaction Sources

Consolidate engine log redaction from:

1. `workflow-runner.ts` — inline `secretPatterns` + `redact()`
2. `lib/security/safe-context.ts` — `redactSensitiveText()` (broader patterns incl. private keys)
3. `local-command-runner.ts` — `redactSensitiveCommandValue()`

Prefer importing `redactSensitiveText` from `safe-context.ts` in engine code; align workflow-runner patterns where they overlap.

## Intentional Non-Goals (Current Codebase)

Per `docs/architecture/workflow-editor-runner.md` and code inspection:

- No arbitrary shell execution from workflow nodes.
- No automatic Spec Kit / GitHub / AO invocation in runner.
- No background scheduler or job queue — **Phase 01 adds this**.
- Global auto-run off by default; seed/tests assert `globalAutoRunEnabled === false`.

## Recommended Engine Integration Points

| Concern | Reuse |
|---|---|
| Policy gate for auto ticks | `evaluateGlobalAutomationPolicy(repository.getAutomationSettings())` |
| Policy UI copy | `describeEffectiveAutomationPolicy({ automationSettings, projectPolicy })` |
| Persistence | Extend `LoopBoardRepository` + migration `0008` |
| API surface | `withLoopBoardRepository`, `jsonOk`, `handleApiError` |
| Client | Add typed helpers to `loopboard-client.ts` |
| Dashboard panel | Match header/metrics styling in `app/page.tsx` |
| Executor config on nodes | Store in existing `WorkflowNode.config` JSON |
| Demo / test executor | Deterministic stub (mirrors workflow-runner's deterministic completion) |
