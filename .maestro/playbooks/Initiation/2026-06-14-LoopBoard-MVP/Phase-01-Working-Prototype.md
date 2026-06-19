# Phase 01: Working Prototype

This phase bootstraps LoopBoard from the current workspace and delivers a visible local web prototype: a Next.js app with a polished Kanban execution board, sample AI coding loop tasks, owner/status controls, and a task detail panel backed by local browser state. It must run end-to-end without user decisions so there is a tangible foundation before deeper integrations are added.

## Tasks

- [x] Inspect the repository and bootstrap the app foundation:
  - Search the workspace first with `rg --files`, `find`, `ls`, and existing package/config files; reuse any existing app structure if present
  - If the GitHub repo has not been cloned or the workspace is empty, initialize the project in place as a Next.js TypeScript app using the repo root as the workspace
  - Use App Router, Tailwind CSS, ESLint, and a package manager already implied by the repo; if none exists, use npm
  - Add the MVP dependencies needed for the prototype: `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `lucide-react`, and a small utility for class names if useful
  - Create or preserve a clean structure under `apps/web` and shared packages only if the repo already uses a monorepo; otherwise keep the initial app simple and coherent
  - Completion note: Workspace contained only Auto Run documents and no Git repository or package-manager signal, so the app was bootstrapped in the repo root with npm, Next.js App Router, TypeScript, Tailwind CSS, ESLint, `clsx`, `lucide-react`, and the requested `dnd-kit` packages. Verified with `npm run lint` and `npm run typecheck`.

- [x] Define the prototype domain model and seed data:
  - Create TypeScript types for `Project`, `Feature`, `Task`, `TaskEvent`, Kanban statuses, owner, mode, risk level, and source
  - Add default columns exactly matching the PRD statuses: Backlog, Spec Review, Plan Review, Ready, AI Running, Human Working, Needs Review, Blocked, Done
  - Add realistic seeded tasks that demonstrate Spec Kit import, AI assignment, human takeover, GitHub issue/PR state, handoff status, branch/worktree fields, labels, and acceptance criteria
  - Include helper functions for status labels, risk styling, owner transitions, event creation, and timestamp formatting
  - Completion note: Added `lib/loopboard.ts` with strict domain types, exact PRD Kanban columns, realistic seeded project/features/tasks, helper functions for labels, risk styles, owner transitions, event creation, timestamp formatting, and status grouping. Added `npm test` with Node's test runner plus `tsx`, and covered column order, seed metadata, grouping, and helper behavior. Updated ESLint ignores for generated Next artifacts. Verified with `npm run lint`, `npm run typecheck`, and `npm test`.

- [x] Build the first Kanban board UI:
  - Implement a dense developer-tool layout, not a marketing landing page
  - Show project context, workflow health counters, and a global auto-run disabled indicator at the top
  - Render draggable task cards grouped by the default columns using `dnd-kit`
  - Ensure dragging a card between columns updates its status in local state and appends a `TASK_MOVED` event
  - Show key card metadata: owner, mode, risk, labels, branch, worktree, GitHub issue, PR, CI/review hints, and handoff availability
  - Completion note: Replaced the placeholder home page with a dense local developer-tool board using seeded LoopBoard data, dnd-kit draggable cards, PRD column grouping, project context, workflow counters, and a global auto-run disabled indicator. Added a pure `moveTaskToStatus` helper so column drops update local task status and append `TASK_MOVED` events consistently, with test coverage for the move event behavior. Verified with `npm run lint`, `npm run typecheck`, and `npm test`.

- [x] Implement task detail and core card actions:
  - Add a side panel or drawer for the selected task with title, description, acceptance criteria, links, context paths, handoff preview, and chronological events
  - Add actions for Assign to AI, Claim for Myself, Pause AI, Return to AI, Mark Blocked, and Mark Done
  - Each action must update owner/status/labels consistently and append the appropriate event from the PRD event schema
  - Keep all behavior local and deterministic for the prototype; do not require real GitHub credentials or local shell actions yet
  - Completion note: Added a full selected-task detail drawer with metadata, GitHub links, context paths, handoff preview, acceptance criteria, chronological event history, and six local deterministic action buttons. Added `applyTaskAction` domain behavior for Assign to AI, Claim for Myself, Pause AI, Return to AI, Mark Blocked, and Mark Done so each action updates owner/status/mode/labels and appends the matching PRD event type. Covered action transitions in tests and verified with `npm run lint`, `npm run typecheck`, and `npm test`.

- [x] Add local persistence and reset controls for the prototype:
  - Persist tasks, selected task, and events to `localStorage`
  - Load seed data only when no saved state exists
  - Add a reset sample data control so the user can return to the seeded demo state
  - Make the UI resilient if stored data is incomplete or from an older prototype shape
  - Completion note: Added versioned localStorage persistence for tasks, selected task, and task event history, hydrating from seed data only when no valid saved state exists. Added a reset sample data control in the board header and parser guards that discard incomplete older task shapes, repair missing event IDs, sanitize optional metadata, and recover stale selected-task IDs. Covered persistence, malformed storage fallback, and partial stored data recovery in tests. Verified with `npm run lint`, `npm run typecheck`, and `npm test`.

- [x] Style and verify responsive behavior:
  - Use Tailwind classes consistent with a focused local developer tool
  - Avoid oversized hero sections, decorative card nesting, and one-note color palettes
  - Ensure board columns, cards, buttons, labels, and side panel text do not overlap at desktop and mobile widths
  - Use lucide icons for card actions and compact metadata where helpful
  - Completion note: Tightened the LoopBoard UI with responsive Kanban column widths, min-width guards, truncation/wrapping for long task metadata and context paths, compact icon-backed feature/status chips, denser mobile-safe action buttons, and a visible drag affordance on task cards. Added a deterministic `DndContext` id to clear the development hydration mismatch from generated dnd-kit accessibility IDs. Verified with `npm run lint`, `npm run typecheck`, `npm test`, and headless Chrome checks at 1440x1000 and 390x844 confirming no page-level horizontal overflow, intentional board horizontal scrolling, six visible detail actions, seven rendered task cards, and no Next.js issue overlay. Generated and inspected two verification screenshots in `Auto Run Docs/Working`.

- [x] Run the app and fix startup issues:
  - Install dependencies
  - Run lint/type checks available in the project
  - Start the local dev server on an available port, defaulting to `3000` if free
  - Open the running app and verify the board renders, cards drag between columns, detail actions create events, local persistence works, and reset restores seed data
  - Leave the dev server running and report the local URL when complete
  - Completion note: Ran `npm install`, `npm run lint`, `npm run typecheck`, and `npm test` successfully. Started the Next.js dev server on `http://127.0.0.1:3000` and left it running. Verified the app in headless Chrome with seven rendered task cards, all PRD Kanban columns present, detail action event creation, localStorage persistence across reload, drag-and-drop from AI Running to Needs Review with a `TASK_MOVED` event, and reset restoring seeded data. Fixed the only startup/browser issue by adding `app/icon.svg` to eliminate the missing icon 404. No task images were present to analyze.
