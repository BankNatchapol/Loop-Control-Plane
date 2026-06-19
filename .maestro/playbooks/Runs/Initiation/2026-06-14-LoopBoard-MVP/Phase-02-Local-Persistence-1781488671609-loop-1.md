# Phase 02: Local Persistence

This phase replaces prototype-only browser state with a durable local data layer for projects, features, tasks, events, and generated context files. By the end, LoopBoard should preserve board state across app restarts and create the file-backed artifacts that prevent context loss.

## Tasks

- [x] Inspect existing Phase 01 implementation and choose the smallest persistence approach that fits:
  - Search existing code and package configuration before adding libraries or new patterns
  - Prefer SQLite with Drizzle or Prisma if the app already has server-side routes available; otherwise add the minimal server/API structure needed
  - Keep local-first behavior and avoid requiring authentication or cloud services
  - Document any important persistence assumptions in code comments only where the implementation would otherwise be unclear
  - Completion note: Inspected the Phase 01 Next.js App Router prototype, package configuration, domain model, localStorage hydration logic, board UI, tests, and the two generated verification screenshots in `Auto Run Docs/Working`. The current app has no API routes or database/ORM packages yet, and all durable state is concentrated in `lib/loopboard.ts` plus `app/page.tsx`. Chosen persistence direction for the next task: add minimal server/API structure in the existing App Router app, use local SQLite with Drizzle for typed schema and migrations, seed from the existing Phase 01 sample project/features/tasks, and keep `localStorage` only for harmless UI preferences such as selected task/project. This keeps LoopBoard local-first with no authentication or cloud dependency while providing a durable file-backed data layer for projects, features, tasks, events, and later context files.

- [x] Add database schema and migration setup:
  - Model `Project`, `Feature`, `Task`, and `TaskEvent` using the PRD fields as the source of truth
  - Store array/object fields such as acceptance criteria, dependencies, labels, and payload as JSON
  - Include timestamps and indexes for common lookups by project, feature, task, status, owner, and event creation time
  - Add seed data equivalent to the Phase 01 sample board so a fresh local install still has a useful demo
  - Completion note: Added Drizzle/SQLite persistence setup with `drizzle.config.ts`, typed tables in `lib/db/schema.ts`, and the initial SQL migration in `db/migrations/0001_initial_loopboard.sql` for projects, features, tasks, and task events. JSON fields now cover labels, acceptance criteria, dependencies, GitHub state, handoff state, and event payloads, with indexes for project, feature, status, owner, task, event type, and event creation-time lookups. Added idempotent `db:migrate` and `db:seed` scripts backed by `node:sqlite`, seeded from the existing Phase 01 sample board, ignored local SQLite files under `data/`, and covered migration plus seed behavior in `tests/db-seed.test.ts`. Verified with `npm run lint`, `npm run typecheck`, `npm test`, `npm run db:seed`, and an idempotent `npm run db:migrate`.

- [x] Implement server-side data access and API routes:
  - Add repository/service helpers for projects, features, tasks, and events
  - Add API routes for listing board state, creating/updating tasks, moving tasks, updating owner/mode/risk, and appending events
  - Ensure every meaningful task mutation creates an event in the same logical operation
  - Return stable, typed response shapes and friendly error messages for invalid IDs or unsupported transitions
  - Completion note: Added `LoopBoardRepository` as the server-side SQLite data access layer for listing board data, loading tasks with events, creating tasks, updating owner/mode/risk and other task fields, moving tasks, and appending task events. Added App Router API endpoints at `/api/board`, `/api/tasks`, `/api/tasks/[taskId]`, `/api/tasks/[taskId]/move`, and `/api/tasks/[taskId]/events`, all returning stable `{ ok, data }` or `{ ok, error }` JSON shapes. Task creation, move, and update operations persist their corresponding events in the same repository transaction, and invalid project/task IDs or unsupported direct owner transitions return friendly typed errors. Added focused repository tests covering board reads, task creation event creation, moves, owner/mode/risk updates, unsupported transitions, and manual event appends. Verified with `npm run lint`, `npm run typecheck`, and `npm test`.

- [x] Wire the UI to persisted APIs:
  - Replace direct seed/localStorage task state with API-backed loading and mutation flows
  - Preserve the Phase 01 board interactions, detail panel, and action behavior
  - Add loading, empty, and error states that fit the existing UI
  - Keep localStorage only for harmless UI preferences such as selected project or collapsed panels
  - Completion note: Replaced the board page's prototype seed/localStorage task state with API-backed board loading from `/api/board`, persisted drag moves through `/api/tasks/[taskId]/move`, and persisted task action buttons through a new `/api/tasks/[taskId]/actions` route. Added a typed browser API client, repository support for applying existing Phase 01 task actions in one transaction, and UI loading, empty, reload, task-selection, and mutation-error states while keeping localStorage limited to selected project/task preferences. Added tests for the action persistence path and client endpoint/error handling. Verified with `npm run lint`, `npm run typecheck`, `npm test`, `npm run db:seed`, local `curl` checks against `http://localhost:3000`, and a persisted action-route smoke test that was cleaned from the local demo database afterward.

- [x] Generate durable task context artifacts:
  - Add a context-file service that can create per-task folders and files under a configurable local task context root
  - Generate `task.md`, `context.md`, `handoff.md`, and `events.jsonl` for each task using the PRD templates
  - Include source artifact links, acceptance criteria, owner/status, branch/worktree/PR/issue fields, and latest event timeline
  - Make generation idempotent so re-running it updates known generated sections without destroying clearly marked human notes
  - Completion note: Added `TaskContextService` with configurable `LOOPBOARD_TASK_CONTEXT_ROOT` support and a default local root at `data/task-contexts`. The service now creates per-task folders with generated `task.md`, `context.md`, `handoff.md`, and `events.jsonl` files containing source artifacts, acceptance criteria, owner/status/mode/risk, branch/worktree, GitHub issue/PR/CI/review fields, handoff details, and the latest event timeline. Markdown files use generated-section and human-notes markers so reruns refresh LoopBoard-owned content while preserving clearly marked human notes, and `events.jsonl` is regenerated idempotently from the persisted event stream. Added `npm run contexts:generate` to generate all current database tasks, ignored generated context folders under `data/task-contexts/`, and covered single-task generation, all-task generation, JSONL output, relative paths, and human-note preservation in `tests/task-context-service.test.ts`. Verified with `npm run lint`, `npm run typecheck`, `npm test`, and `npm run contexts:generate`, which generated 7 local task context folders.

- [x] Add event export and handoff refresh actions:
  - Add task detail actions to export events as JSONL and refresh `handoff.md`
  - Append every task event to the corresponding `events.jsonl` file when the task has a context folder
  - Show generated file paths in the task detail panel with copy/open affordances if the platform supports them
  - Handle missing folders or write errors gracefully with visible task-level feedback
  - Completion note: Added task context API support at `/api/tasks/[taskId]/context` for status reads plus event JSONL export and `handoff.md` refresh actions. Extended `TaskContextService` with focused methods for exporting `events.jsonl`, refreshing only handoff markdown while preserving human notes, reporting generated file path status, and syncing existing event logs after persisted task mutations. Existing task creation, update, move, action, and manual event routes now refresh `events.jsonl` when a task context folder already exists, while write failures return friendly context-file errors for explicit actions and are logged without breaking core task mutations for background sync. The task detail panel now shows context-file actions, generated absolute paths, file existence state, copy buttons, file open links where supported by the browser, and visible task-level success/error feedback. Added focused service and browser-client tests. Verified with `npm run lint`, `npm run typecheck`, `npm test`, and a local Next smoke test against `GET /`, `GET /api/tasks/task-import-spec-kit-board/context`, and `POST /api/tasks/task-import-spec-kit-board/context` for `export-events`. Analyzed 0 task images; none were associated with this checkbox.

- [x] Test persistence and context generation:
  - Write focused tests for schema/service helpers, task mutation event creation, JSONL export, and handoff generation
  - Run migrations against a local SQLite database and verify seeded data appears on the board
  - Restart the dev server and confirm tasks/events persist
  - Fix any lint, type, migration, or test failures before finishing
  - Completion note: Added `tests/persistence-integration.test.ts` to exercise a real temporary SQLite file across migration, seed, task mutation, context generation, database close, and database reopen. The existing focused tests continue to cover schema/seed helpers, repository task mutation event creation, JSONL export, handoff refresh, context status, and browser API client behavior. Verified with `npm run lint`, `npm run typecheck`, and `npm test` (30 passing tests). Also ran `npm run db:migrate`, `npm run db:seed`, and `npm run contexts:generate` against an isolated local SQLite database, then started `next dev` on port 3100, confirmed `/api/board` returned 1 project, 3 features, and 7 tasks, appended a `HANDOFF_READY` event through `/api/tasks/task-local-persistence-reset/events`, restarted the dev server, and confirmed the task still had the persisted event plus the matching `events.jsonl` line. Analyzed 0 task images; no images were associated with this checkbox.
