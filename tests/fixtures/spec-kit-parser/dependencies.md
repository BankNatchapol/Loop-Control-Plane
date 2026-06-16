# Tasks

## API

- [ ] T020 Add parse endpoint in `app/api/features/[featureId]/spec-kit-tasks/preview/route.ts`
  Dependencies: T010, T011

- [ ] T021 Create import service in `lib/importers/spec-kit-task-importer.ts`
  Depends on: T020
  - Write imported tasks to the repository.

- [ ] T022 Verify importer flow in `tests/spec-kit-task-importer.test.ts`
  After: T020 and T021
