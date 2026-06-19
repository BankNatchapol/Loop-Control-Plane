# Phase 03: Workflow Node Executors

This phase replaces the MVP workflow runner's deterministic placeholders with real executors behind each node type. Spec Kit CLI runs automatically for spec/plan/tasks generation, the existing importer and GitHub bridge execute for real, and implement/test/review/PR steps delegate to configured backends — while human and semi-auto nodes still pause for approval per policy.

## Tasks

- [x] Inspect workflow runner, node catalog, and existing service integrations:
  - Read `lib/workflows/workflow-runner.ts`, `lib/workflows/workflow-editor.ts`, `examples/workflows/feature-development-loop.json`, `lib/importers/spec-kit-task-importer.ts`, `lib/github/github-issues.ts`, `lib/github/github-prs.ts`, and `docs/architecture/workflow-editor-runner.md`
  - Map each node type to an executor module and identify which existing functions can be called directly vs need a new adapter
  - Extend `WorkflowNode.config` schema to include `executor: { backend, args?, cwd?, timeoutMs? }` without breaking existing saved workflows (defaults when missing)
  - Keep human-input, human-review, manual-claude-code-edit, and merge nodes as approval gates — executors prepare context but do not bypass pauses
  - **Notes (2026-06-16):** Added `lib/engine/workflow-node-executor-map.ts`, `lib/engine/workflow-node-config.ts`, `WorkflowNodeConfig` / `WorkflowNodeExecutorSettings` types, catalog default executors via `catalogNodeConfig()`, and reference doc `docs/architecture/workflow-node-executors.md`. Tests in `tests/workflow-node-executor-map.test.ts`.

- [x] Build safe process execution utilities for external CLIs:
  - Add `lib/engine/process-runner.ts` for audited subprocess execution: fixed command allowlist, no shell interpolation, cwd constrained to project repo via `validateLocalDirectory`, timeout enforcement, stdout/stderr capture with size limits, and redacted summaries in logs
  - Add command profiles for `spec-kit` (or the project's Spec Kit CLI binary name discovered via `command -v` / `--version` check), `npm test`, `git`, `gh`, and placeholder profiles for `cursor`, `claude`, and `codex` CLIs
  - Reuse `lib/system/local-command-runner.ts` patterns for env allowlists; never pass through full process.env
  - Wire shell-capable nodes through `evaluateWorkflowNodePolicy` — auto mode remains blocked for shell commands unless explicitly approved
  - **Notes (2026-06-16):** Added `ProcessRunner`, profile resolution (`spec-kit`/`speckit`/`specify` discovery), policy gate via `assertProcessRunPolicyAllowed`, injectable spawner for tests, and `tests/process-runner.test.ts` (allowlist, cwd traversal, timeout, redaction, policy). Documented in `docs/architecture/workflow-node-executors.md` Process Runner section.

- [x] Implement Spec Kit and planning node executors:
  - Add `lib/engine/executors/spec-kit-actions-executor.ts` that reads input artifacts (feature brief path), resolves `{feature}` placeholders against the run's feature, and invokes Spec Kit CLI commands to generate `spec.md`, `plan.md`, and `tasks.md` under the project Spec Kit root
  - Verify output files exist before marking step completed; on missing outputs, fail step with structured error and respect node `maxRetries`
  - Add `lib/engine/executors/import-tasks-executor.ts` calling existing `SpecKitTaskImporter` with the resolved `tasks.md` path and feature linkage — reuse duplicate detection and context file generation from Phase 04 MVP importer
  - Update workflow runner to delegate `spec-kit-actions` and `import-tasks` node execution to engine jobs instead of immediate deterministic completion when mode/policy allows
  - **Notes (2026-06-16):** Added `spec-kit-actions-executor`, `import-tasks-executor`, `workflow-step-dispatcher`, and shared artifact path helpers. `LoopScheduler` now uses `createExecutorRegistryForRepository` so workflow-step jobs dispatch to real executors. Workflow runner enqueues `workflow-step` jobs (step status `running`) for delegated node types after policy approval. Tests: `tests/spec-kit-actions-executor.test.ts`, `tests/import-tasks-executor.test.ts`, workflow-runner delegation cases.

- [x] Implement GitHub and delivery node executors:
  - Add `lib/engine/executors/create-github-issues-executor.ts` reusing `lib/github/github-issues.ts` for linked tasks on the feature, honoring project automation policy for low-risk auto issue creation
  - Add `lib/engine/executors/open-pr-executor.ts` reusing PR discovery/create helpers from `lib/github/github-prs.ts` where available, or `gh pr create` through process-runner when configured
  - Add `lib/engine/executors/run-tests-executor.ts` running the project's test script (default `npm test`) in repo cwd, writing a summarized report artifact to `loopboard://runs/{run}/test-report`
  - Add `lib/engine/executors/ai-review-executor.ts` that invokes the configured review backend (default stub summarizing diff + test report paths) and writes `review-notes` artifact — real agent invocation comes through backend adapters in Phase 04
  - Ensure all GitHub/external outputs are marked untrusted in artifacts per `[[Security-Policy]]`
  - **Notes (2026-06-16):** Added four delivery executors, `markWorkflowArtifactUntrusted` / placeholder helpers in `workflow-artifact-paths.ts`, dispatcher routes for `create-github-issues`, `open-pr`, `run-tests`, and `ai-review`, and `branchLabel` on `WorkflowStepExecutorResult`. Fixed `insertProject` column order swapping `specKitRoot` and `githubRepository`. Tests: `tests/create-github-issues-executor.test.ts`, `tests/open-pr-executor.test.ts`, `tests/run-tests-executor.test.ts`, `tests/ai-review-executor.test.ts`.

- [x] Integrate workflow-step jobs into the loop engine and runner:
  - Add `EngineJobKind` `workflow-step` payload: `{ workflowRunId, workflowNodeId, nodeType, executorConfig, inputArtifacts, outputArtifacts }`
  - Extend `loop-scheduler.ts` to process workflow-step jobs and call `runNextWorkflowStep` completion hooks only after executor success
  - Refactor `lib/workflows/workflow-runner.ts` so auto/semi nodes enqueue engine jobs instead of completing inline; paused runs wait for job completion or approval as today
  - On executor completion, link outputs via existing `linkCompletedStepToContext`, append feature/task events, and advance `currentNodeId` using existing edge traversal
  - Support conditional edges minimally: honor edge `label` when executor result includes `branchLabel` (e.g., ai-review → approved vs needs changes)
  - **Notes (2026-06-16):** Expanded `ENGINE_DELEGATED_WORKFLOW_NODE_TYPES` to all delivery executors. Added `completeWorkflowStepFromEngineJob` with `branchLabel`-aware `nextNodeId`, wired from `LoopScheduler.tick` after terminal job outcomes. Tests updated in `tests/workflow-runner.test.ts` and `tests/loop-scheduler.test.ts`.

- [x] Extend workflow editor UI for per-node executor configuration:
  - In `app/workflow-editor.tsx` side panel, add executor backend dropdown and optional args/timeout fields for automatable node types
  - Show policy warnings when shell-capable nodes are set to auto without approval
  - Display last engine job status on the runner panel for the current workflow step
  - Add **Run Next Step (Engine)** control that enqueues and ticks when global auto-run is off
  - **Notes (2026-06-16):** Added `lib/workflows/workflow-executor-editor.ts` helpers, executor side-panel fields (`data-testid="workflow-node-executor-config"`), combined shell policy warnings, runner engine job status panel, `run-next-engine` action via `runNextWorkflowStepWithEngineTick`, and `workflowRunId`/`workflowNodeId` on `EngineJobSummary`. Tests: `tests/workflow-executor-editor.test.ts`, workflow-runner run-next-engine case.

- [x] Write workflow executor tests:
  - Add `tests/process-runner.test.ts` for allowlist rejection, cwd traversal blocking, timeout, and log redaction
  - Add `tests/spec-kit-actions-executor.test.ts` with mocked process-runner verifying artifact path resolution and retry behavior
  - Add `tests/import-tasks-executor.test.ts` reusing existing Spec Kit fixture markdown
  - Add `tests/workflow-engine-integration.test.ts` that runs a trimmed workflow graph (import-tasks → create-github-issues with mocks) through engine jobs
  - Update workflow runner tests to expect engine delegation instead of instantaneous auto completion where applicable
  - **Notes (2026-06-16):** Prior tasks already added unit tests for process-runner, spec-kit-actions, import-tasks, and delivery executors; workflow-runner tests already assert engine delegation. Added `tests/workflow-engine-integration.test.ts` exercising import-tasks → create-github-issues via `LoopScheduler` ticks with mocked GitHub issue creation. Full suite passes (`npm test`).

- [x] Run workflow executor verification:
  - Run `npm run db:migrate`, `npm run lint`, `npm run typecheck`, and `npm test`; fix failures
  - Manual walkthrough on Feature Development Loop: start run, approve human-input with fixture brief, execute spec-kit-actions (or mock if CLI unavailable in CI), import tasks, and confirm tasks appear on board with workflow events
  - Update `docs/architecture/loop-execution-engine.md` with Workflow Executors section and wiki-links to `[[Spec-Kit-Importer]]`, `[[GitHub-Issue-Bridge]]`, and `[[Workflow-Editor-Runner]]`
  - **Notes (2026-06-16):** All verification commands pass (`db:migrate`, `lint`, `typecheck`, `npm test` — 228 tests). Added `tests/workflow-executor-verification.test.ts` exercising Feature Development Loop through human-input → spec-kit-actions (mocked CLI) → human-review → import-tasks with board tasks and `WORKFLOW_STEP_COMPLETED` events. Updated `docs/architecture/loop-execution-engine.md` with Workflow Executors section, sequence diagram, executor table, and wiki-links.
