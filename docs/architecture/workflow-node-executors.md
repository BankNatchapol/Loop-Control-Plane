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
