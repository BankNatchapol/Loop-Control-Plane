# Phase 04: Spec Kit Importer

This phase turns Spec Kit `tasks.md` output into editable LoopBoard task cards linked back to source artifacts. It should let the user preview parsed tasks, adjust them, and import them into the Kanban board with context files ready for AI or human execution.

## Tasks

- [x] Inspect existing markdown, feature, task, and context code before adding importer logic:
  - Reuse current models, APIs, markdown rendering helpers, and context generation services
  - Keep the parser deterministic and tolerant of common Spec Kit task list formats
  - Add fixtures only where they support parser tests or importer UI validation

  Completion notes:
  - Existing task/feature model already supports importer essentials: `TaskSource` includes `spec-kit`, task events include `TASK_IMPORTED`, feature records link `PRD.md`, `spec.md`, `plan.md`, `tasks.md`, and `decisions.md`, and tasks persist labels, acceptance criteria, dependencies, mode, owner, and risk.
  - Reuse `discoverFeatureArtifacts` and `readFeatureArtifactDocument` for feature folder/artifact resolution so importer paths stay inside the project repository or configured Spec Kit root.
  - Reuse `LoopBoardRepository.createTask`, `appendTaskEvent`, and `TaskContextService.generateTaskContext`/task context actions for import writes and generated context files; duplicate detection will need importer-level logic because no stable source task ID field exists yet.
  - Current markdown support is a lightweight UI preview component, not a parser; the importer parser should live in a deterministic library module with focused `node:test` fixtures matching existing test style.

- [x] Implement a Spec Kit task parser:
  - Parse headings, checkbox tasks, task IDs, task titles, descriptions, file references, dependencies, and acceptance criteria from `tasks.md`
  - Link parsed tasks to sibling `PRD.md`, `spec.md`, `plan.md`, `tasks.md`, and `decisions.md` when present
  - Infer area labels such as frontend, backend, infra, test, and docs from task text and file paths
  - Infer risk level using conservative rules, treating auth, permissions, payments, billing, migrations, secrets, deletion, security-sensitive work, and large refactors as higher risk
  - Preserve unknown source text in notes rather than discarding it

  Completion notes:
  - Added `lib/importers/spec-kit-task-parser.ts` with a deterministic line-based parser for Spec Kit `tasks.md` checkbox lists. It preserves heading context, task source IDs, source line numbers, raw source text, descriptions, file references, dependencies, acceptance criteria, notes, owner/mode defaults, inferred labels, and conservative risk levels.
  - Added sibling artifact linking for `PRD.md`, `spec.md`, `plan.md`, `tasks.md`, and `decisions.md` when parsing with a filesystem `tasksPath`, returning missing artifact state without blocking valid task parsing.
  - Added focused parser fixtures and tests in `tests/fixtures/spec-kit-parser/mixed-tasks.md` and `tests/spec-kit-task-parser.test.ts` covering mixed headings, nested acceptance criteria, dependencies, missing task IDs, artifact links, area labels, and high/critical risk inference.
  - Verified with `node --test --import tsx tests/spec-kit-task-parser.test.ts`, `npm run lint`, `npm run typecheck`, and `npm test`.
  - Analyzed 0 task images; none were associated with this checkbox.

- [x] Add importer API routes and services:
  - Add an endpoint to parse a selected feature folder and return a preview without writing tasks
  - Add an endpoint to create tasks from an approved preview
  - Store imported tasks with source `spec_kit`, linked feature ID, source artifact paths, inferred labels, acceptance criteria, dependencies, mode, owner, and risk level
  - Append `TASK_IMPORTED` events for each created task
  - Generate or refresh each imported task's context files after creation

  Completion notes:
  - Added `SpecKitTaskImporter` in `lib/importers/spec-kit-task-importer.ts` to preview feature-linked `tasks.md` files without writes, surface parser warnings and missing artifact notices, and import approved preview tasks into the linked project/feature.
  - Added feature-scoped API routes: `POST /api/features/[featureId]/spec-kit-tasks/preview` for parse-only previews and `POST /api/features/[featureId]/spec-kit-tasks/import` for approved imports.
  - Imported tasks are created with source `spec-kit`, feature/project IDs, inferred labels/risk, acceptance criteria, dependencies, owner/mode, and source artifact paths in task handoff context paths. Each imported task receives a `TASK_IMPORTED` event with source ID, source line, `tasks.md` path, and source artifact path metadata.
  - Import generation now writes full task context files via `TaskContextService.generateTaskContext` after the `TASK_IMPORTED` event is appended.
  - Added `tests/spec-kit-task-importer.test.ts` covering preview non-writes, missing artifact notices, import creation, event creation, context generation, exclusion, and duplicate skipping by source task ID/title.
  - Verified with `npm run lint`, `npm run typecheck`, and `npm test`.
  - Could not commit or push because `/Users/bank.p/Documents/Loop-Control-Plane` is not a Git repository.
  - Analyzed 0 task images; none were associated with this checkbox.

- [x] Build the importer preview UI:
  - Add a feature-level Import Spec Kit Tasks action
  - Show parsed tasks in an editable preview with title, description, status, owner, mode, risk, labels, dependencies, and acceptance criteria
  - Allow excluding individual parsed tasks before import
  - Show parser warnings and missing artifact notices without blocking valid imports
  - Keep the flow self-contained and avoid requiring GitHub setup

  Completion notes:
  - Added a feature-level Spec Kit import preview flow in `app/page.tsx` with an Import Spec Kit Tasks action, parse/refresh controls, editable parsed-task cards, duplicate visibility, include/exclude toggles, and non-blocking warning/missing-artifact panels.
  - Added browser client helpers and types for the feature-scoped preview/import API routes in `lib/api/loopboard-client.ts`.
  - Preserved edited preview status during import by adding an optional validated `status` field to `SpecKitImportTaskInput` in `lib/importers/spec-kit-task-importer.ts`.
  - Added tests for the new client endpoints and edited-status import behavior in `tests/loopboard-client.test.ts` and `tests/spec-kit-task-importer.test.ts`.
  - Verified with `npm run lint`, `npm run typecheck`, `npm test`, and a local dev-server HTTP 200 check on `http://localhost:3000`.
  - Could not commit or push because `/Users/bank.p/Documents/Loop-Control-Plane` is not a Git repository.
  - Analyzed 0 task images; none were associated with this checkbox.

- [x] Connect imported tasks to the board:
  - After import, navigate or return to the Kanban board filtered to the relevant project/feature
  - Show source feature and artifact indicators on imported cards
  - Ensure imported task details show source artifact links and generated context file paths
  - Make repeated imports safe by detecting duplicates from stable source task IDs or task titles within the feature

  Completion notes:
  - Updated the board view in `app/page.tsx` so the selected feature acts as the Kanban filter, feature changes select that feature's first task, and Spec Kit imports persist the imported feature/task selection before reloading the board.
  - Added imported Spec Kit indicators to task cards, including the source feature name, `spec kit` source badge, and source artifact count.
  - Added task-detail metadata for Spec Kit import source IDs, source lines, source `tasks.md`, source artifact file links, and generated context file status rows.
  - Reused the existing importer duplicate handling, which skips repeated imports by source task ID or title within the same feature and marks duplicates in preview.
  - Verified with `npm run lint`, `npm run typecheck`, `npm test`, and a local dev-server HTTP 200 check on `http://localhost:3000`.
  - Could not commit or push because `/Users/bank.p/Documents/Loop-Control-Plane` is not a Git repository.
  - Analyzed 0 task images; none were associated with this checkbox.

- [x] Add structured technical notes for importer behavior:
  - Create `docs/architecture/spec-kit-importer.md` with YAML front matter: `type: reference`, `title: Spec Kit Importer`, `created: 2026-06-14`, and tags for `spec-kit`, `importer`, and `loopboard`
  - Include wiki-links to `[[Project-And-Feature-Model]]`, `[[Task-Context-Files]]`, and `[[Risk-Policy]]`
  - Document supported task formats, inference rules, duplicate handling, and limitations

  Completion notes:
  - Created `docs/architecture/spec-kit-importer.md` with structured YAML front matter, required tags, and wiki-links to `[[Project-And-Feature-Model]]`, `[[Task-Context-Files]]`, and `[[Risk-Policy]]`.
  - Documented the preview/import flow, supported checkbox and task ID formats, sibling artifact linking, label and risk inference rules, duplicate handling by source task ID or normalized title, and current parser/importer limitations.
  - Analyzed 0 task images; none were associated with this checkbox.

- [x] Test importer parsing and import behavior:
  - Add parser fixtures for simple tasks, nested acceptance criteria, dependencies, mixed headings, and higher-risk examples
  - Write tests for preview parsing, duplicate detection, inferred labels/risk, task creation, event creation, and context generation
  - Run lint, type checks, parser tests, and importer flow tests, then fix failures

  Completion notes:
  - Added focused parser fixtures in `tests/fixtures/spec-kit-parser/simple-tasks.md`, `nested-acceptance.md`, `dependencies.md`, and `higher-risk.md` alongside the existing mixed-heading fixture.
  - Expanded `tests/spec-kit-task-parser.test.ts` to cover simple checkbox tasks, completion state, source IDs, file references, nested acceptance criteria, dependency aliases, heading context, inferred labels, and conservative risk levels.
  - Expanded `tests/spec-kit-task-importer.test.ts` with explicit duplicate detection coverage for approved import payloads that reuse an existing task title with a different source ID, in addition to existing preview parsing, task creation, event creation, and context generation checks.
  - Verified with `node --test --import tsx tests/spec-kit-task-parser.test.ts`, `node --test --import tsx tests/spec-kit-task-importer.test.ts`, `npm run lint`, `npm run typecheck`, and `npm test`.
  - Could not commit or push because `/Users/bank.p/Documents/Loop-Control-Plane` is not a Git repository.
  - Analyzed 0 task images; none were associated with this checkbox.
