---
type: reference
title: Spec Kit Importer
created: 2026-06-14
tags:
  - spec-kit
  - importer
  - loopboard
related:
  - '[[Project-And-Feature-Model]]'
  - '[[Task-Context-Files]]'
  - '[[Risk-Policy]]'
  - '[[Loop-Execution-Engine]]'
---

# Spec Kit Importer

The Spec Kit importer turns a feature's `tasks.md` checklist into editable Loop Control Plane task cards. It is feature-scoped: the importer reads the feature's linked `tasks.md`, previews parsed tasks without writes, lets the user edit or exclude tasks, and then creates approved tasks on the Kanban board.

This behavior depends on the feature artifact model described by [[Project-And-Feature-Model]], the generated execution files described by [[Task-Context-Files]], and the conservative task classification rules summarized by [[Risk-Policy]].

## Import Flow

1. The user selects a feature and starts Import Spec Kit Tasks.
2. `POST /api/features/[featureId]/spec-kit-tasks/preview` reads the linked feature `tasks.md` and returns parsed tasks, parser warnings, duplicate flags, linked artifacts, and missing artifact notices.
3. The preview UI lets the user edit title, description, status, owner, mode, risk, labels, dependencies, and acceptance criteria before import.
4. `POST /api/features/[featureId]/spec-kit-tasks/import` receives the approved preview payload.
5. Included, non-duplicate tasks are persisted with `source: spec-kit`, the linked project and feature IDs, source artifact paths, inferred metadata, and edited preview values.
6. Each imported task receives a `TASK_IMPORTED` event with source task ID, source line, `tasks.md` path, and source artifact path metadata.
7. `TaskContextService.generateTaskContext` creates or refreshes `task.md`, `context.md`, `handoff.md`, and `events.jsonl` for each imported task.

## Supported Task Formats

The parser is deterministic and line-oriented. It supports Markdown heading context and checkbox list items in `tasks.md`.

Supported top-level task examples:

```markdown
## API

- [ ] T001 Add checkout route in `app/api/checkout/route.ts`
- [x] BE-12 Persist payment status in `lib/payments/repository.ts`
- [ ] 2.1 Update docs in `docs/payments.md`
- [ ] Add unlabeled setup task
```

Task IDs are read from the start of the checkbox text when they match one of these forms:

- `ABC-123`
- `ABC123`
- `1`, `1.2`, or `1.2.3`

If no source task ID is present, the parser assigns `line-N` based on the checkbox line number. The remaining checkbox text becomes the task title after known markers such as `[P]`, `[FE]`, `[BE]`, `[AI]`, `[HUMAN]`, `[MVP]`, and `[OPTIONAL]` are stripped.

Indented body lines and nearby bullets are attached to the current task. The parser recognizes:

- Descriptions from plain text or bullet text.
- File references in backticks or path-like text, including common source, config, markdown, SQL, shell, and lockfile extensions.
- Dependencies from lines beginning with `dependencies:`, `deps:`, `depends on:`, `blocked by:`, or `after:`.
- Acceptance criteria from inline `Acceptance: ...` lines or an `Acceptance Criteria:` heading followed by bullets.
- Metadata and unresolved source text as notes, including lines beginning with `owner:`, `mode:`, `status:`, `risk:`, `priority:`, `estimate:`, `source:`, `area:`, `labels:`, `note:`, `todo:`, `question:`, `open question:`, `assumption:`, or `non-goal:`.

Malformed checkbox-looking lines are skipped and returned as parser warnings. Warnings do not block importing valid tasks.

## Linked Artifacts

When parsing with a filesystem `tasks.md` path, the parser checks for sibling Spec Kit artifacts:

- `PRD.md`
- `spec.md`
- `plan.md`
- `tasks.md`
- `decisions.md`

Preview responses show missing artifacts as notices. Missing sibling artifacts do not block parsing or import as long as the feature has a valid `tasks.md`.

On import, task handoff context paths use the feature's existing artifact links. These paths are also shown in task details so humans or agents can inspect the source material used to create the task.

## Inference Rules

Area labels are inferred from task text and file references:

- `frontend`: frontend, UI/UX, React, components, pages, `.tsx`, or CSS references.
- `backend`: backend, API routes, server code, database, services, or repositories.
- `infra`: deployment, Docker, workflows, Terraform, Kubernetes, or `.github/`.
- `test`: tests, fixtures, coverage, Playwright, `.test.`, or `.spec.`.
- `docs`: docs, documentation, README, ADRs, decisions, or `.md` references.

Risk is inferred conservatively:

- `critical`: payments, billing, secrets, credentials, private keys, user deletion, table drops, or likely data loss.
- `high`: authentication, authorization, permissions, security, migrations, deletion, destructive changes, large refactors, access control, or PII.
- `medium`: APIs, databases, schemas, repositories, integrations, webhooks, background jobs, or concurrency.
- `low`: tasks without recognized medium, high, or critical signals.

The preview UI can override inferred risk, labels, owner, mode, status, dependencies, acceptance criteria, title, and description before import.

## Duplicate Handling

Repeated imports are intended to be safe within a feature. The importer only compares against existing tasks for the same feature with `source: spec-kit`.

Duplicate detection uses:

- The `sourceId` stored on the task's `TASK_IMPORTED` event metadata.
- The normalized task title, with whitespace collapsed and case ignored.

Duplicates are marked in preview and skipped during import. Excluded preview tasks are also skipped. Skipped tasks are reported with the reason `duplicate` or `excluded`.

## Limitations

- The parser is not a full Markdown AST parser; it intentionally supports common Spec Kit checklist shapes with deterministic line rules.
- Only checkbox list items become tasks. Tables, prose-only task lists, and unchecked text without `- [ ]` or `* [ ]` are not imported as tasks.
- Source task IDs are not stored as a first-class task column; duplicate detection reads them from `TASK_IMPORTED` event metadata.
- Dependency references remain source IDs or numeric IDs from `tasks.md`; they are not automatically rewritten to Loop Control Plane task IDs.
- Artifact discovery is limited to the known sibling files listed above and the feature's configured artifact paths.
- Heuristic labels and risk are conservative aids for preview, not policy enforcement. Users should review high-impact imports before creating tasks.
