# Phase 08: Workflow Editor Runner

This phase introduces the Loop Workflow Editor and a step-by-step workflow runner. The goal is a visual coding-loop designer that can save workflows, configure node modes, pause for human review, and record execution history without replacing the Kanban board.

## Tasks

- [x] Inspect existing app structure, persistence, project settings, and UI patterns before adding React Flow:
  - Reuse current layout, API, database, and component conventions
  - Add React Flow only if it is not already present
  - Keep the workflow editor as a focused tool surface inside the app, not a marketing page
  - Completion notes, 2026-06-15:
    - No `CLAUDE.md` exists in this project tree; inspected the app structure, package manifest, database schema, repository layer, API routes, styles, tests, migrations, and existing architecture docs directly.
    - App conventions: Next.js App Router with a single focused LoopBoard tool surface in `app/page.tsx`, Tailwind/global CSS in `app/globals.css`, lucide icons, `clsx`, and existing `@dnd-kit` drag/drop usage for board interactions.
    - Persistence conventions: SQLite via `node:sqlite`, Drizzle schema in `lib/db/schema.ts`, SQL migrations under `db/migrations`, seed data in `db/seed.ts`, and repository methods centralized in `lib/db/loopboard-repository.ts`.
    - API conventions: route handlers under `app/api/**` use `runtime = "nodejs"`, `withLoopBoardRepository`, `readJsonBody`, `jsonOk`, and `handleApiError` from `lib/api/loopboard-http.ts`; client calls live in `lib/api/loopboard-client.ts`.
    - Project settings already include `workflowsPath` on projects and seed data; no workflow models or workflow runner tables exist yet.
    - React Flow is not currently installed in `package.json`; future editor work should add it only when implementing the visual workflow editor and keep it embedded as an in-app tool surface.

- [x] Define workflow data models and persistence:
  - Add `Workflow`, `WorkflowNode`, `WorkflowEdge`, `WorkflowRun`, and `WorkflowRunStep` models using the PRD schemas
  - Support node `mode` values: `auto`, `human`, `semi`, and `disabled`
  - Store input artifacts, output artifacts, requireApproval, maxRetries, riskPolicy, config, execution logs, and current node state
  - Seed a default feature-development loop matching the PRD example
  - Completion notes, 2026-06-15:
    - Added workflow domain types in `lib/loopboard.ts` for `Workflow`, `WorkflowNode`, `WorkflowEdge`, `WorkflowRun`, `WorkflowRunStep`, artifact contracts, execution logs, node modes, node states, run statuses, step statuses, and risk policies.
    - Added SQLite/Drizzle persistence for normalized workflow definitions and run history in `lib/db/schema.ts` and migration `db/migrations/0006_workflow_editor_runner.sql`, including JSON validation, foreign keys, and indexes for project/workflow/run lookups.
    - Extended `LoopBoardRepository` with workflow definition save/load/update methods, graph validation for duplicate IDs and invalid edge references, workflow run creation, run-step persistence, and validation for supported node modes, risk policies, statuses, artifacts, logs, and current node references.
    - Seeded the PRD-style Feature Development Loop with Human Input, Spec Kit Actions, Human Review, Import Tasks, Create GitHub Issues, Agent Orchestrator Implement, Run Tests, AI Review, Manual Claude Code Edit, Open PR, and Merge nodes, including artifact IO, approval requirements, retry counts, risk policy, config, and the manual-edit retry edge.
    - Updated the idempotent database seed and migration tests to include workflow rows, nodes, and edges; added repository tests for default workflow persistence, custom workflow validation, and workflow run/step log persistence.
    - Verified with `npm run typecheck`, `npm test`, `npm run lint`, and `npm run db:migrate`.
    - Skipped commit/push because `/Users/bank.p/Documents/Loop-Control-Plane` is not a Git repository. Analyzed 0 task images; none were associated with this checkbox.

- [x] Build the React Flow workflow editor:
  - Render draggable nodes for Human Input, Human Review, Spec Kit actions, Import Tasks, Create GitHub Issues, Agent Orchestrator Implement, Run Tests, AI Review, Open PR, Merge, and Manual Claude Code Edit
  - Allow connecting nodes with edges and repositioning nodes
  - Add a side panel for editing node name, type, mode, input/output artifacts, approval requirement, retry count, risk policy, and config JSON
  - Save and load workflow definitions per project
  - Include validation for disconnected graphs, duplicate IDs, invalid modes, and unsafe node settings
  - Completion notes, 2026-06-16:
    - Added React Flow with `@xyflow/react`, wired its stylesheet into the app layout, and embedded the focused workflow editor in the existing LoopBoard project surface.
    - Verified `app/workflow-editor.tsx` renders project workflows with draggable React Flow nodes, edge creation/removal, node reposition persistence in draft workflow state, workflow selection, new workflow drafting, reload, and save actions.
    - Verified the editor node catalog covers Human Input, Human Review, Spec Kit Actions, Import Tasks, Create GitHub Issues, Agent Orchestrator Implement, Run Tests, AI Review, Open PR, Merge, and Manual Claude Code Edit.
    - Verified the side panel edits workflow name/description/config plus selected node name, type, mode, input/output artifacts, approval requirement, retry count, risk policy, and config JSON.
    - Verified save/load uses the existing per-project workflow APIs and repository persistence; create/update route handlers reject blocking validation issues before persistence.
    - Hardened the React Flow node-change typing and hook dependency in `app/workflow-editor.tsx` so typecheck and lint pass.
    - Updated workflow client test expectations in `tests/loopboard-client.test.ts`; existing workflow editor validation tests cover disconnected graphs, duplicate IDs, invalid references, and unsafe settings.
    - Verified with `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build`.
    - Browser plugin smoke testing could not run because the required in-app Browser runtime tool was not available in this session; production build verified the frontend compile path instead.
    - Skipped commit/push because `/Users/bank.p/Documents/Loop-Control-Plane` is not a Git repository. Analyzed 0 task images; none were associated with this checkbox.

- [x] Implement workflow import/export:
  - Save workflows as JSON in the database and allow export to project workflow folder as JSON or YAML if existing dependencies support YAML cleanly
  - Load workflow files from the configured workflow directory with path validation
  - Create `examples/workflows/feature-development-loop.yaml` or JSON equivalent if the project does not already have an example
  - Show structured validation errors before overwriting an existing workflow
  - Completion notes, 2026-06-16:
    - Added JSON workflow file import/export service in `lib/workflows/workflow-files.ts`, reusing existing workflow graph validation and repository persistence while constraining file paths to the project `repoPath` plus configured `workflowsPath`.
    - Added `POST /api/workflows/[workflowId]/export` to export saved workflows as JSON files, and `POST /api/projects/[projectId]/workflows/import` to import JSON files from the configured workflow directory.
    - Implemented structured validation error propagation for invalid paths, unsupported formats, invalid JSON, graph validation failures, and overwrite-required conflicts; imports return a `needs-overwrite` result until the existing workflow id is explicitly confirmed.
    - Added workflow editor controls for JSON export/import, inline structured validation display, and an explicit overwrite action before replacing an existing workflow.
    - Added browser client helpers and tests for the new import/export endpoints.
    - Added `examples/workflows/feature-development-loop.json` as the project example because no YAML dependency is currently installed.
    - Added focused workflow file tests for export, path traversal rejection, overwrite conflict reporting, overwrite import, and graph validation failures.
    - Verified with `npm run typecheck`, `npm test`, and `npm run lint`.
    - Skipped commit/push because `/Users/bank.p/Documents/Loop-Control-Plane` is not a Git repository. Analyzed 0 task images; none were associated with this checkbox.

- [x] Implement the step-by-step runner:
  - Add Start Run, Run Next Step, Approve Human Step, Skip Disabled Step, Fail Step, and Resume actions
  - Execute MVP node behavior deterministically: metadata/log updates, artifact checks, import trigger placeholders, issue creation calls where already implemented, and human pause handling
  - Pause at human nodes and semi-auto nodes until explicit approval
  - Skip disabled nodes and record `skipped` steps
  - Store logs and outputs for each step without including secrets
  - Completion notes, 2026-06-16:
    - Added repository update/upsert primitives for persisted workflow runs and run steps so runner transitions can update run status, current node, logs, artifacts, approvals, failures, and completion timestamps.
    - Added deterministic MVP runner logic in `lib/workflows/workflow-runner.ts` for Start Run, Run Next Step, Approve Human Step, Skip Disabled Step, Fail Step, and Resume actions.
    - Runner behavior now pauses at human, semi-auto, or approval-required nodes; completes auto nodes with resolved output artifact placeholders and metadata logs; skips disabled nodes with persisted `skipped` steps; and redacts token/secret/password/API-key style material from failed step logs.
    - Added `POST /api/workflows/[workflowId]/runs` and `POST /api/workflow-runs/[runId]/actions` endpoints plus typed browser client helpers for runner actions.
    - Added workflow editor runner controls for Start Run, Run Next, Approve, Skip Disabled, Resume, and Fail Step with current run and latest step status display.
    - Added runner tests for start/pause/approval transitions, semi-auto pause behavior, disabled-node skipping, auto-node outputs, pending-approval guardrails, and log redaction; added client endpoint tests for run start/action requests.
    - Verified with `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build`.
    - Skipped commit/push because `/Users/bank.p/Documents/Loop-Control-Plane` is not a Git repository. Analyzed 0 task images; none were associated with this checkbox.

- [x] Connect workflow runs back to project and board context:
  - Let a run target a project and optionally a feature
  - Show latest run status on the project dashboard
  - Link workflow run steps to imported tasks, created issues, or generated artifacts when applicable
  - Add task or feature events when workflow steps materially change their state
  - Completion notes, 2026-06-16:
    - Confirmed workflow runs already persist `projectId` and optional `featureId`; wired `startWorkflowRun` to set the workflow project explicitly and accept the currently selected feature from the editor.
    - Added `latestWorkflowRuns` to `BoardData`, repository latest-run lookup by project, and a compact Latest Workflow Run status panel in the existing project dashboard header.
    - Added workflow provenance event types for task and feature history, plus repository support for appending feature events with the same validation/sanitization model used by task events.
    - Runner now records `WORKFLOW_RUN_STARTED` feature events and `WORKFLOW_STEP_COMPLETED` feature/task events when completed steps affect a targeted feature, task artifact, imported-task node, issue node, or PR node context.
    - The workflow editor now starts saved runs against the selected feature and shows the target feature in the runner panel.
    - Added tests for feature-targeted starts, latest project run board data, workflow-generated feature events, and task event links from generated artifacts; updated board-data fixtures for the new latest-run field.
    - Verified with `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build`.
    - Browser plugin smoke testing could not run because the required in-app Browser Node REPL tool was not available in this session; production build verified the frontend compile path instead.
    - Skipped commit/push because `/Users/bank.p/Documents/Loop-Control-Plane` is not a Git repository. Analyzed 0 task images; none were associated with this checkbox.

- [x] Add structured workflow architecture notes:
  - Create `docs/architecture/workflow-editor-runner.md` with YAML front matter: `type: reference`, `title: Workflow Editor Runner`, `created: 2026-06-14`, and tags for `workflow`, `react-flow`, `runner`, and `loopboard`
  - Include wiki-links to `[[GitHub-Issue-Bridge]]`, `[[Spec-Kit-Importer]]`, `[[Risk-Policy]]`, and `[[Security-Policy]]`
  - Document node types, modes, runner behavior, pause semantics, and future automation boundaries
  - Completion notes, 2026-06-16:
    - Added `docs/architecture/workflow-editor-runner.md` with the required YAML front matter, workflow/react-flow/runner/loopboard tags, and wiki-link references to `[[GitHub-Issue-Bridge]]`, `[[Spec-Kit-Importer]]`, `[[Risk-Policy]]`, and `[[Security-Policy]]`.
    - Documented the workflow data model, supported node catalog, execution modes, validation rules, editor behavior, import/export boundaries, runner actions, pause semantics, context event links, log redaction, and future automation boundaries.
    - Matched the structure and tone of existing architecture references in `docs/architecture`.
    - Skipped automated tests because this task only adds a Markdown architecture reference and updates the checklist document.
    - Skipped commit/push because `/Users/bank.p/Documents/Loop-Control-Plane` is not a Git repository. Analyzed 0 task images; none were associated with this checkbox.

- [x] Test workflow editing and running:
  - Unit test workflow validation, save/load, import/export, runner transitions, human pause behavior, disabled node skipping, and log redaction
  - UI test creating a simple workflow, connecting nodes, saving it, starting a run, pausing at a human node, approving it, and completing the run
  - Run lint, type checks, unit tests, and UI tests, then fix failures
  - Completion notes, 2026-06-16:
    - Confirmed existing unit coverage for workflow validation, save/load API clients, import/export file behavior, runner transitions, human and semi-auto pause behavior, disabled-node skipping, and secret redaction.
    - Added Playwright UI coverage in `tests/ui/workflow-editor-runner.spec.ts` plus `playwright.config.ts` and `npm run test:ui`; the UI test uses a seeded temporary SQLite database, creates a simple workflow, connects a Run Tests node, saves it, starts a run, pauses at the human node, approves it, and completes the run.
    - Added stable workflow editor test hooks and an accessible selected-node "Connect to" control so edge creation is available through the side panel as well as React Flow interactions.
    - Fixed a workflow editor state race where creating a new unsaved workflow immediately triggered the load effect and restored the persisted workflow; the loader now tracks the selected workflow through a ref instead of reloading on selected ID changes.
    - Installed Playwright Chromium locally for UI test execution and added `@playwright/test` as a dev dependency.
    - Verified with `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:ui`, and `npm run build`.
    - Skipped commit/push because `/Users/bank.p/Documents/Loop-Control-Plane` is not a Git repository. Analyzed 0 task images; none were associated with this checkbox.
