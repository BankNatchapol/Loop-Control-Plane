---
type: reference
title: Workflow Node Executors
created: 2026-06-16
tags:
  - workflow
  - engine
  - executor
  - loopboard
related:
  - '[[Workflow-Editor-Runner]]'
  - '[[Loop-Execution-Engine]]'
  - '[[Spec-Kit-Importer]]'
  - '[[GitHub-Issue-Bridge]]'
  - '[[Security-Policy]]'
---

# Workflow Node Executors

Phase 03 inspection maps each workflow catalog node type to a future executor module, documents approval-gate boundaries, and extends `WorkflowNode.config` with nested `executor` settings that default safely when missing.

## Config Schema

Per-node backend settings live in existing JSON `config` without a migration:

```json
{
  "command": "npm test",
  "executor": {
    "backend": "stub",
    "args": ["test"],
    "cwd": "/path/to/repo",
    "timeoutMs": 600000
  }
}
```

| Field | Purpose |
|-------|---------|
| `executor.backend` | Registered engine backend (`stub`, `cursor`, `claude-code`, `codex`, `agent-orchestrator`) |
| `executor.args` | argv-style CLI arguments (no shell interpolation) |
| `executor.cwd` | Working directory alias normalized to `workingDirectory` |
| `executor.timeoutMs` | Positive millisecond timeout for subprocess or adapter work |
| `executor.command` | Legacy single command string; merged when `args` is absent |
| `executor.workingDirectory` | Legacy cwd field; `cwd` takes precedence when both are set |

Helpers in `lib/engine/workflow-node-config.ts`:

- `resolveWorkflowNodeExecutorConfig(node)` — explicit nested config, per-type defaults, legacy `command` merge
- `normalizeWorkflowNodeConfig(config, nodeType)` — editor/catalog normalization without breaking `{}` saved workflows
- `parseWorkflowNodeExecutorConfig(node)` — structured validation via `validateExecutorConfig`

Approval-gate nodes keep empty config by default. Automatable catalog nodes receive default `executor` objects from `catalogNodeConfig()` in `lib/workflows/workflow-editor.ts`.

## Approval Gates

These node types always pause for operator approval. Executors may prepare artifact paths and context summaries but must not bypass `evaluateWorkflowNodePolicy` pauses:

| Node type | Role |
|-----------|------|
| `human-input` | Capture feature brief / PRD |
| `human-review` | Review generated Spec Kit artifacts |
| `manual-claude-code-edit` | Human-directed fix loop after AI review |
| `merge` | Human-controlled merge approval |

`isWorkflowApprovalGateNode()` in `lib/engine/workflow-node-executor-map.ts` centralizes this list.

## Node Type → Executor Module Map

| Node type | Executor module | Default backend | Reuse directly | Needs adapter |
|-----------|-----------------|-----------------|---------------|---------------|
| `human-input` | — (approval gate) | `stub` | — | — |
| `spec-kit-actions` | `lib/engine/executors/spec-kit-actions-executor.ts` | `stub` | `resolveArtifactPath` | process-runner spec-kit profile, `{feature}` resolution, output verification |
| `human-review` | — (approval gate) | `stub` | — | — |
| `import-tasks` | `lib/engine/executors/import-tasks-executor.ts` | `stub` | `SpecKitTaskImporter.importFeature`, parser | tasks.md path resolution, loopboard artifact linkage |
| `create-github-issues` | `lib/engine/executors/create-github-issues-executor.ts` | `stub` | `createGitHubIssue`, label/body helpers, task policy | iterate feature tasks, untrusted artifact marking |
| `agent-orchestrator-implement` | `lib/engine/executors/agent-orchestrator-implement-executor.ts` | `agent-orchestrator` | `TaskContextService.generateTaskContext` | AO backend adapter, branch artifacts |
| `run-tests` | `lib/engine/executors/run-tests-executor.ts` | `stub` | — | process-runner npm profile, test-report artifact |
| `ai-review` | `lib/engine/executors/ai-review-executor.ts` | `stub` | `sanitizeExternalSummary` | review backend adapter, `branchLabel` for conditional edges |
| `manual-claude-code-edit` | — (approval gate) | `claude-code` | `TaskContextService.generateClaudeCodePrompt` | optional context prep only |
| `open-pr` | `lib/engine/executors/open-pr-executor.ts` | `stub` | `syncGitHubPullRequest`, `parseGitHubPullRequestNumber` | `gh pr create` fallback via process-runner |
| `merge` | — (approval gate) | `stub` | — | — |

Authoritative mapping data: `workflowNodeExecutorMap` in `lib/engine/workflow-node-executor-map.ts`.

## Process Runner

Audited subprocess execution for workflow node executors lives in `lib/engine/process-runner.ts`:

| Profile | Command | Default args | Notes |
|---------|---------|--------------|-------|
| `spec-kit` | Discovered via `--version` (`spec-kit`, `speckit`, `specify`) | `[]` | Fails with `spec_kit_unavailable` when CLI missing |
| `npm-test` | `npm` | `["test"]` | Runs project test script in validated repo cwd |
| `git` | `git` | `[]` | Fixed allowlist; no shell interpolation |
| `gh` | `gh` | `[]` | GitHub CLI for PR/issue fallbacks |
| `cursor` | `cursor` | `[]` | Placeholder profile (Phase 04 adapters) |
| `claude` | `claude` | `[]` | Placeholder profile (Phase 04 adapters) |
| `codex` | `codex` | `[]` | Placeholder profile (Phase 04 adapters) |

Safety controls:

- Fixed command allowlist — rejects binaries outside profile definitions.
- `shell: false` spawn with argv-only args; shell metacharacters in args are rejected.
- `cwd` validated through `validateLocalDirectory` against `projectRepoPath`.
- Timeout enforcement (default 300s) with `timedOut` results.
- stdout/stderr captured with 256 KiB byte limits; log summaries redacted via `redactSensitiveText`.
- Environment built from an allowlist (`PATH`, `NODE_ENV`, `HOME`, etc.) — never full `process.env`.
- Shell-capable workflow nodes must pass `evaluateWorkflowNodePolicy` via optional `policy` on `ProcessRunOptions`; auto mode stays blocked unless explicitly approved.

Helpers: `ProcessRunner`, `runProcessProfile`, `assertProcessRunPolicyAllowed`, `discoverSpecKitBinary`, `resolveProcessProfile`.

Tests: `tests/process-runner.test.ts`.

## Workflow Step Executors

Phase 03 adds real executors for planning nodes under `lib/engine/executors/`:

| Module | Node type | Behavior |
|--------|-----------|----------|
| `spec-kit-actions-executor.ts` | `spec-kit-actions` | Runs chained Spec Kit CLI actions (`spec`, `plan`, `tasks`) via process-runner; verifies required output files exist |
| `import-tasks-executor.ts` | `import-tasks` | Calls `SpecKitTaskImporter.importFeature` with resolved `tasks.md` path and feature linkage |
| `create-github-issues-executor.ts` | `create-github-issues` | Creates GitHub issues for feature tasks via `createGitHubIssue`; honors `evaluateTaskPolicy` for low-risk auto issue creation |
| `open-pr-executor.ts` | `open-pr` | Discovers PRs with `syncGitHubPullRequest`; falls back to `gh pr create` via process-runner |
| `run-tests-executor.ts` | `run-tests` | Runs `npm test` (or configured args) via process-runner; writes summarized `test-report` artifact |
| `ai-review-executor.ts` | `ai-review` | Stub review backend summarizing branch and test-report paths; returns `branchLabel` for conditional edges |
| `workflow-step-dispatcher.ts` | `workflow-step` jobs | Routes engine jobs to the correct executor by `nodeType` |

Shared helpers: `workflow-artifact-paths.ts` (placeholder resolution, `markWorkflowArtifactUntrusted`), `workflow-step-types.ts` (payload parsing, delegated node types).

External and GitHub-derived output artifacts are tagged with `[external/untrusted]` in `description` per [[Security-Policy]].

The workflow runner enqueues `workflow-step` engine jobs for all delegated node types (`spec-kit-actions`, `import-tasks`, `create-github-issues`, `open-pr`, `run-tests`, `ai-review`) when automation policy allows (including after human approval on semi nodes). Steps enter `running` status until `LoopScheduler.tick` completes the job and calls `completeWorkflowStepFromEngineJob`, which links artifacts, appends events, and advances the graph (including conditional edges via `branchLabel`).

`LoopScheduler` registers `createExecutorRegistryForRepository(repository)` so dequeued workflow-step jobs invoke the dispatcher instead of stub-only completion, then applies runner completion hooks on terminal job outcomes.

Tests: `tests/spec-kit-actions-executor.test.ts`, `tests/import-tasks-executor.test.ts`, `tests/create-github-issues-executor.test.ts`, `tests/open-pr-executor.test.ts`, `tests/run-tests-executor.test.ts`, `tests/ai-review-executor.test.ts`.

## Runner vs Engine Boundary

`lib/workflows/workflow-runner.ts` remains the graph state machine. Phase 03 replaces deterministic `"completed deterministically"` completion for automatable nodes by enqueueing `workflow-step` engine jobs (later tasks in this phase). Until those jobs run:

- Policy gates still call `evaluateWorkflowNodePolicy` before any step advances.
- Shell-capable nodes (`run-tests`, nodes with `command`/`args`) stay blocked in auto mode unless explicitly approved.
- GitHub and external outputs must be marked untrusted per [[Security-Policy]].

## Related Documents

- [[Loop-Execution-Engine]] — job queue, executor registry, and `workflow-step` kind
- [[Workflow-Editor-Runner]] — editor catalog, runner pause semantics, artifact placeholders
- [[Spec-Kit-Importer]] — task import reuse for `import-tasks`
- [[GitHub-Issue-Bridge]] — issue and PR helpers for delivery nodes
