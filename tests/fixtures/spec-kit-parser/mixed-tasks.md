# Tasks

## Phase 1: Backend

- [ ] T001 Create importer API route in `app/api/spec-kit/import/route.ts`
  Parse feature folder input and return preview data.
  Dependencies: T000
  Acceptance Criteria:
    - Returns parsed tasks without writing database rows.
    - Reports missing artifacts as warnings.
  Note: API auth policy remains open.

- [x] T002 [P] Add parser tests in tests/spec-kit-task-parser.test.ts
  - Include fixtures for dependencies and acceptance criteria.

## Phase 2: Frontend

- [ ] T003 [US1] Build preview component in `app/page.tsx`
  Unknown: final modal copy.
  AC: User can exclude an imported task.

- [ ] Harden auth permissions before deleting stale imported tasks
  Depends on: T001, T003
  - Touches `lib/db/loopboard-repository.ts`
