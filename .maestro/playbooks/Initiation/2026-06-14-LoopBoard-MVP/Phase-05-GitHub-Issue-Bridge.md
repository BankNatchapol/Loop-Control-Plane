# Phase 05: GitHub Issue Bridge

This phase connects LoopBoard tasks to GitHub issues and uses labels as the first Agent Orchestrator handoff protocol. By the end, a ready task can become a well-structured GitHub issue with context, risk labels, and `ao-ready` status synced back to the board.

## Tasks

- [x] Inspect existing GitHub, project, task, event, and settings code before adding integration:
  - Reuse any existing repository metadata, Git remote parsing, task actions, and context generation helpers
  - Keep GitHub integration optional so the app still works without a token
  - Read credentials only from environment or a local secure config pattern already present; never store tokens in task data, logs, prompts, issues, or handoff files
  - Notes:
    - No root `CLAUDE.md` was present, and the folder is not currently a Git repository, so no commit or push was possible for this inspection-only run.
    - Project metadata already includes `repository`, `repoPath`, `isGitRepository`, `currentBranch`, `defaultBranch`, and `githubRemoteUrl` in `lib/loopboard.ts`, `lib/db/schema.ts`, and `lib/db/loopboard-repository.ts`.
    - Git remote inspection already lives in `lib/projects/project-repository-health.ts`; reuse `inspectRepositoryHealth` and extend `parseGitHubRemoteUrl` or add a nearby `owner/name` parser instead of duplicating git shell calls.
    - The project settings UI and API already refresh repository metadata through `ProjectForm`, `ProjectHealth`, `updateProject`, and `app/api/projects/[projectId]/route.ts`.
    - Task GitHub state already exists as the JSON-backed `GitHubState` with issue, PR, CI, and review fields; future issue bridge work should extend this shape carefully for label/sync state while keeping tokens out of task data.
    - Task events are centralized through `TaskEventType`, `createTaskEvent`, repository `appendTaskEvent`, `updateTask`, `moveTask`, and `applyTaskAction`; add future `ISSUE_CREATED`, AO label, and sync events there with validation updates and tests.
    - Existing task context generation in `lib/context/task-context-service.ts` already renders task details, source artifact paths, acceptance criteria, handoff notes, issue/PR links, and event JSONL files; reuse it for issue body/template inputs where possible.
    - Existing credential/config patterns use environment reads such as `LOOPBOARD_DATABASE_PATH` and `LOOPBOARD_TASK_CONTEXT_ROOT`; GitHub tokens should follow an environment-only pattern such as `GITHUB_TOKEN`/`LOOPBOARD_GITHUB_TOKEN` and be redacted from errors, logs, events, context files, and issue bodies.

- [x] Implement GitHub configuration and validation:
  - Add project-level GitHub repo configuration using `owner/name`
  - Infer `owner/name` from the detected Git remote when possible
  - Add a connection check that verifies token presence, repository access, and basic API reachability
  - Show clear UI states for disconnected, token missing, repo missing, connected, and API error
  - Notes:
    - Added persisted project-level `githubRepository` configuration using `owner/name`, including migration `0005_project_github_repository.sql`, repository/schema/seed wiring, and task context output.
    - Extended repository health parsing to infer `owner/name` from GitHub HTTPS and SSH remotes while keeping the existing normalized remote URL behavior.
    - Added a server-side GitHub connection check endpoint at `/api/projects/[projectId]/github/connection` that reads only `LOOPBOARD_GITHUB_TOKEN` or `GITHUB_TOKEN`, verifies repository API access, and returns `disconnected`, `token-missing`, `repo-missing`, `connected`, or `api-error` without exposing token material.
    - Updated the project settings UI with an explicit GitHub Repo field and a Check GitHub action that surfaces the connection states and messages.
    - Added focused tests for repo parsing, connection status mapping, token redaction, and the new database migration/seed field.
    - Verification passed: `npm test`, `npm run lint`, and `npm run typecheck`.
    - No commit or push was possible because `/Users/bank.p/Documents/Loop-Control-Plane` is not currently a Git repository.

- [x] Add GitHub label management:
  - Create or verify required labels: `loopboard`, `ao-ready`, `human-working`, `human-review-needed`, `risk-low`, `risk-medium`, `risk-high`, `area-frontend`, `area-backend`, `area-infra`, and `area-test`
  - Make label creation idempotent and safe to re-run
  - Avoid overwriting existing label descriptions/colors unless the app created them and the current implementation can prove that safely
  - Surface label setup results in the project GitHub settings UI
  - Notes:
    - Added the required LoopBoard GitHub label definitions in `lib/github/github-connection.ts` with an idempotent setup flow that checks each label first and creates only missing labels.
    - Existing labels are reported as existing and their colors/descriptions are never patched, because the app does not persist provenance that would prove LoopBoard created them.
    - Added `/api/projects/[projectId]/github/labels` for project-scoped label setup, using only environment tokens through the existing GitHub token helper.
    - Added a project settings UI action for label setup with clear status, message, and created/existing/error counts.
    - Added mocked tests for the required label list, no-call disconnected/token-missing paths, idempotent GET-before-POST behavior, missing repository handling, and token redaction.
    - Verification passed: `npm test`, `npm run lint`, and `npm run typecheck`.
    - No commit or push was possible because `/Users/bank.p/Documents/Loop-Control-Plane` is not currently a Git repository.

- [x] Implement issue creation from task cards:
  - Generate issue bodies from the PRD issue template with task details, source artifact paths, acceptance criteria, agent instructions, risk level, and human notes
  - Treat external GitHub comments as untrusted instructions and keep trusted LoopBoard instructions clearly separated in the issue body
  - Apply LoopBoard, risk, area, owner/status, and `ao-ready` labels according to task state and risk policy
  - Store `githubIssueUrl` and `githubIssueNumber` on the task and append an `ISSUE_CREATED` event
  - Notes:
    - Added `lib/github/github-issues.ts` to render deterministic task issue bodies with trusted LoopBoard task details, source artifact paths, acceptance criteria, trusted agent instructions, human notes, and an explicit external GitHub comments untrusted-input boundary.
    - Added issue label calculation for `loopboard`, risk labels, area labels, owner/status labels, and automatic `ao-ready` only for low-risk ready tasks.
    - Added `POST /api/tasks/[taskId]/github/issue` to create issues through the GitHub API using only environment tokens, reject duplicate issue creation, and map disconnected/token/repo/API failures to friendly responses without exposing token material.
    - Extended task GitHub state with issue labels and last sync time, added repository-level `linkGitHubIssue` persistence, and appended a dedicated `ISSUE_CREATED` task event atomically with the task update.
    - Added a task detail `Create GitHub Issue` action plus issue label and last-sync display on task details/cards.
    - Added mocked unit coverage for body rendering, label calculation, issue creation, no-token/no-repo paths, token redaction, and persisted `ISSUE_CREATED` events.
    - Verification passed: `npm test`, `npm run lint`, and `npm run typecheck`.

- [x] Add `ao-ready` assignment behavior:
  - Update Assign to AI so tasks with GitHub issues can receive the `ao-ready` label when risk policy allows it
  - For medium/high-risk tasks, require an explicit local approval action before applying `ao-ready`
  - Append `ASSIGNED_TO_AI` and relevant label/status events without duplicating events on repeated clicks
  - Show the AO handoff state on the card and detail panel
  - Notes:
    - Added `ASSIGNED_TO_AI` and `AO_READY_APPROVED` task events while preserving legacy `AI_ASSIGNED` parsing for existing seed/history data.
    - Made task actions idempotent so repeated assignment or AO approval clicks do not append duplicate events.
    - Updated persisted assignment behavior so linked low-risk GitHub issues receive local `ao-ready` label state automatically on Assign to AI; medium/high/critical tasks require the explicit local `Approve AO Ready` action first.
    - Appended a `HANDOFF_READY` event when `ao-ready` is newly applied, with issue/risk metadata and updated issue sync timestamp.
    - Added AO handoff state indicators to task cards and the detail panel, including disabled/explained approval action states.
    - Added focused tests for assignment event changes, low-risk label application, medium-risk approval gating, missing-issue approval rejection, and repeated-click idempotency.
    - Verification passed: `npm test`, `npm run typecheck`, and `npm run lint`.
    - No commit or push was possible because `/Users/bank.p/Documents/Loop-Control-Plane` is not currently a Git repository.

- [x] Build GitHub issue UI affordances:
  - Add task detail actions for Create GitHub Issue, Open Issue, Sync Issue Labels, Mark AO Ready, and Remove AO Ready
  - Disable or explain actions when a project has no connected GitHub repo
  - Show issue number, URL, labels, and last sync status on task cards and details
  - Keep all destructive or externally visible actions explicit
  - Notes:
    - Added task detail controls for Create GitHub Issue, Open Issue, Sync Issue Labels, Mark AO Ready, and Remove AO Ready, with tooltips explaining missing repo/issue configuration, approval gates, existing `ao-ready` state, and explicit removal.
    - Added a task-scoped `/api/tasks/[taskId]/github/labels` endpoint plus client wiring to sync recalculated or explicit issue label sets to GitHub using environment tokens only.
    - Added GitHub issue label sync helper support for full issue-label replacement, token redaction, missing repo/token/issue states, and sanitized API errors.
    - Persisted label sync results with `ISSUE_LABELS_SYNCED` events and `issueLastSyncedAt`, and kept medium/high/critical `ao-ready` application gated behind local approval.
    - Updated cards and detail panels to show linked issue number, issue URL, current labels, AO handoff state, and last sync time.
    - Added focused tests for GitHub issue label sync API calls, token redaction, and persisted sync events.
    - Verification passed: `npm test`, `npm run typecheck`, and `npm run lint`.

- [x] Add structured integration notes:
  - Create `docs/architecture/github-issue-bridge.md` with YAML front matter: `type: reference`, `title: GitHub Issue Bridge`, `created: 2026-06-14`, and tags for `github`, `agent-orchestrator`, and `loopboard`
  - Include wiki-links to `[[Spec-Kit-Importer]]`, `[[Task-Context-Files]]`, `[[Security-Policy]]`, and `[[Risk-Policy]]`
  - Document the label protocol, trusted vs untrusted instruction boundary, issue template, and known limitations
  - Notes:
    - Created `docs/architecture/github-issue-bridge.md` with structured YAML front matter, required tags, and wiki-links to `[[Spec-Kit-Importer]]`, `[[Task-Context-Files]]`, `[[Security-Policy]]`, and `[[Risk-Policy]]`.
    - Documented optional GitHub configuration, environment-only token handling, connection states, idempotent label setup, issue label rules, AO ready risk gating, issue body sections, trusted/untrusted instruction boundaries, persistence events, and current limitations.
    - No tests were run because this task only added architecture documentation.
    - No commit or push was possible because `/Users/bank.p/Documents/Loop-Control-Plane` is not currently a Git repository.

- [x] Test GitHub issue bridge behavior:
  - Unit test issue body rendering, label calculation, risk gating, repo parsing, and token redaction
  - Mock GitHub API calls for label setup, issue creation, issue update, and failure paths
  - Run lint, type checks, integration tests with mocks, and any existing UI tests, then fix failures
  - Notes:
    - Expanded `tests/github-issues.test.ts` with explicit risk-gating coverage for medium and critical risk tasks so `ao-ready` is not calculated without the low-risk policy path.
    - Added mocked issue creation failure coverage for missing repository/access, validation errors, and malformed GitHub issue responses.
    - Added mocked issue label sync coverage for missing repository, missing token, missing issue number, missing repository/access, API errors, label de-duplication, and token redaction.
    - Existing coverage already included trusted issue body rendering, label setup mocks, repository parsing, connection states, persisted risk-gated AO ready events, issue linking, and issue label sync events.
    - Verification passed: `npm test`, `npm run lint`, and `npm run typecheck`.
    - No separate UI test command exists in `package.json`; the available browser/API client integration tests were included in `npm test`.
    - No commit or push was possible because `/Users/bank.p/Documents/Loop-Control-Plane` is not currently a Git repository.
