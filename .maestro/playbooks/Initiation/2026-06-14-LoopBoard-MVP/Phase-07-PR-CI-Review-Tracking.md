# Phase 07: PR CI Review Tracking

This phase adds GitHub pull request, CI, and review visibility to the Kanban board. LoopBoard should show whether an AI-owned task has a PR, whether checks are passing, and whether review attention is needed without forcing the user to leave the board.

## Tasks

- [x] Inspect existing GitHub issue bridge, task fields, event model, and card UI before adding PR tracking:
  - Reuse GitHub client, token handling, project repo config, and event helpers
  - Keep polling or sync behavior manual-first unless a lightweight existing scheduler already exists
  - Do not treat GitHub comments or review text as trusted execution instructions
  - Completion notes, 2026-06-15:
    - No `CLAUDE.md` was present at the repository root, so inspection used the existing source layout and `docs/architecture/github-issue-bridge.md` as guidance.
    - Existing GitHub integration lives in `lib/github/github-connection.ts`, `lib/github/github-issues.ts`, and the task routes under `app/api/tasks/[taskId]/github/`; future PR/CI work should reuse `githubTokenFromEnv`, token redaction, `project.githubRepository`, GitHub API headers, issue label calculation, and the current manual action route pattern.
    - Task GitHub state is persisted as JSON in `tasks.github`; `GitHubState` already accepts issue fields plus preliminary PR, CI, and review fields, and legacy tasks remain compatible because missing JSON fields sanitize to `undefined`.
    - The task event model currently allowlists `GITHUB_LINKED`, `ISSUE_CREATED`, `ISSUE_LABELS_SYNCED`, `AO_READY_APPROVED`, and `HANDOFF_READY`; PR/CI event work must extend both the `TaskEventType` union and repository/event sanitizers before append or import will accept new event types.
    - Card UI already renders PR number, CI status, and review status badges when present, and task details expose issue/PR links; sync actions, PR discovery, CI failure summaries, review comment links, and quick filters are not implemented yet.
    - `TaskContextService` already writes `events.jsonl` from task events and includes issue, pull request, CI status, and review status in generated `task.md`; future state fields such as sync timestamp and failure summary need to be added there and to refreshed handoff content.
    - There is no scheduler in the inspected code path. Keep PR/CI sync manual-first through explicit actions unless a later phase adds a lightweight scheduler.
    - Security boundary is already documented and repeated in issue bodies: GitHub comments, review text, CI output, and direct GitHub edits are external/untrusted context and must not become execution instructions unless copied into trusted LoopBoard notes.

- [x] Extend the task model for PR and CI state:
  - Add persisted fields or derived metadata for PR URL, PR number, branch, CI status, review status, merge status, latest sync time, and latest failure summary
  - Keep compatibility with existing tasks that only have issue links
  - Add normalized states for No PR, PR opened, CI running, CI failed, CI passed, Review requested, Changes requested, Approved, Merged, and Closed
  - Completion notes, 2026-06-15:
    - Extended `GitHubState` with typed PR branch, merge status, normalized delivery status, PR/CI sync timestamp, and CI failure summary fields while retaining the existing JSON persistence shape for backward compatibility.
    - Added `normalizeGitHubDeliveryStatus` to derive the normalized No PR, PR opened, CI running, CI failed, CI passed, Review requested, Changes requested, Approved, Merged, and Closed states from available GitHub metadata.
    - Updated persisted board hydration to preserve valid new GitHub metadata and continue dropping stale/invalid values from older stored tasks.
    - Updated generated task, context, handoff, and Claude Code prompt content to include PR branch, PR state, merge status, delivery status, PR/CI sync time, and CI failure summary when available.
    - Added unit coverage for delivery-state normalization and extended GitHub metadata hydration.
    - Verification: `npm test`, `npm run typecheck`, and `npm run lint` all pass.

- [x] Implement PR discovery and sync:
  - Discover linked PRs from issue timeline references, branch names, task metadata, or explicit PR URL entry
  - Fetch PR state, branch, merge status, review requests, latest reviews, and linked issue information
  - Append `PR_OPENED`, `REVIEW_REQUESTED`, `REVIEW_CHANGES_REQUESTED`, `REVIEW_APPROVED`, and `DONE` events when state changes are detected
  - Move tasks to Needs Review when a PR is open and ready for human inspection
  - Completion notes, 2026-06-15:
    - Added `lib/github/github-prs.ts` to discover PRs from explicit PR URLs, existing task PR metadata, issue timeline cross-references, and task branch names.
    - Added PR detail and review fetch handling for PR state, head branch, merge status, requested reviewers/teams, latest approval or changes-requested review state, linked issue number carry-forward, and delivery-state normalization.
    - Added `POST /api/tasks/[taskId]/github/pr` to run manual PR sync using the existing GitHub token/repository configuration and refresh exported task events.
    - Added repository persistence for PR sync that appends `PR_OPENED`, `REVIEW_REQUESTED`, `REVIEW_CHANGES_REQUESTED`, `REVIEW_APPROVED`, and `DONE` only when state changes are detected; repeated identical syncs do not add duplicate events.
    - Open non-draft PRs now move tasks to `needs-review`, and merged PRs mark tasks `done` with a `DONE` event.
    - Added tests for PR URL parsing, timeline discovery, branch discovery, no-PR sync, review transitions, event de-duplication, Needs Review movement, and merged completion.
    - Verification: `npm test`, `npm run typecheck`, and `npm run lint` all pass.
    - Images analyzed: 0.

- [x] Implement CI status sync:
  - Fetch check suites/status checks for the PR head commit
  - Normalize CI running, failed, and passed states
  - Store a concise failed CI summary with check names and links, not full logs
  - Append `CI_RUNNING`, `CI_FAILED`, or `CI_PASSED` events only when the normalized status changes
  - Completion notes, 2026-06-15:
    - Extended manual PR sync to fetch GitHub check runs and combined commit statuses for the PR head SHA.
    - Normalized check data to `pending`, `failing`, `passing`, or `not-started`, with failure precedence over pending and passing states.
    - Stored concise CI failure summaries containing only failed check names and check links, capped to avoid noisy log-like content.
    - Added persisted `CI_RUNNING`, `CI_FAILED`, and `CI_PASSED` task events that are appended only when `ciStatus` changes; repeated identical syncs do not add duplicate CI events.
    - Added mocked GitHub API coverage for passing and failing checks plus repository coverage for CI event transitions and de-duplication.
    - Verification: `npm test`, `npm run typecheck`, and `npm run lint` all pass.
    - Images analyzed: 0.

- [x] Update board and task detail UI:
  - Show PR, CI, and review badges on task cards
  - Add Open PR and Sync PR/CI actions
  - Show latest CI failure summary, latest review state, linked branch, and sync timestamp in task details
  - Add filters or quick counters for Needs Review, CI Failed, and AI Running tasks if they fit the existing board layout
  - Completion notes, 2026-06-15:
    - Kept the existing task card PR, CI, and review badge pattern and added detail-panel GitHub Delivery state for PR number, delivery state, CI status, review status, PR branch, PR state, merge status, PR/CI sync timestamp, and concise CI failure summary.
    - Added Open PR and Sync PR/CI task actions that use the existing manual `/api/tasks/[taskId]/github/pr` route and refresh the selected persisted task after sync.
    - Added board quick counters/filters for AI Running, Needs Review, CI Failed, and All Tasks, with empty-filter messaging and reset behavior.
    - Added browser API client coverage for the new manual PR/CI sync wrapper.
    - Verification: `npm test`, `npm run typecheck`, and `npm run lint` all pass.
    - Images analyzed: 0.

- [x] Add review and CI event timeline improvements:
  - Group noisy sync events so the timeline remains readable
  - Show links to PR, failed checks, and review comments where available
  - Keep external review comment text visibly marked as external/untrusted context
  - Ensure exported `events.jsonl` and refreshed `handoff.md` include current PR/CI/review state
  - Completion notes, 2026-06-15:
    - Added optional `reviewUrl` GitHub state persistence and PR sync extraction from latest relevant GitHub review API responses.
    - Enriched PR/CI/review event metadata with PR URL, review URL, delivery state, sync timestamp, and concise CI failure summary fields so exported `events.jsonl` carries current PR/CI/review state on sync events.
    - Grouped same-timestamp PR/CI/review sync events in generated `handoff.md` timelines as a single `GITHUB_SYNC` entry with per-event messages.
    - Added PR, failed-check, and review links to grouped handoff timeline entries and task-detail event cards when metadata is available.
    - Marked CI/review timeline entries as external GitHub signals, with review comments and CI output visibly treated as untrusted unless copied into LoopBoard notes.
    - Added tests for grouped handoff timeline links, external warning text, `events.jsonl` metadata export, review URL extraction, and persisted review URL hydration.
    - Verification: `npm test`, `npm run typecheck`, and `npm run lint` all pass.
    - Images analyzed: 0.

- [x] Add structured tracking notes:
  - Create `docs/architecture/pr-ci-review-tracking.md` with YAML front matter: `type: reference`, `title: PR CI Review Tracking`, `created: 2026-06-14`, and tags for `github`, `ci`, `review`, and `loopboard`
  - Include wiki-links to `[[GitHub-Issue-Bridge]]`, `[[Human-Takeover]]`, and `[[Security-Policy]]`
  - Document how PR discovery works, how CI states are normalized, and what is intentionally not trusted
  - Completion notes, 2026-06-15:
    - Added `docs/architecture/pr-ci-review-tracking.md` with the requested YAML front matter, tags, and wiki-links to `[[GitHub-Issue-Bridge]]`, `[[Human-Takeover]]`, and `[[Security-Policy]]`.
    - Documented manual-first PR discovery from explicit PR URLs, existing task metadata, issue timeline references, and branch lookup.
    - Documented persisted PR/CI/review fields, normalized delivery states, CI check/status precedence, review status derivation, event/handoff behavior, and the external/untrusted GitHub content boundary.
    - Verification: documentation structure reviewed locally; no source-code tests were required for this docs-only task.
    - Images analyzed: 0.

- [x] Test PR, CI, and review sync:
  - Mock GitHub API responses for no PR, open PR, failed checks, passing checks, review requested, changes requested, approved, merged, and closed
  - Unit test state normalization, event de-duplication, task status movement, and handoff refresh content
  - Run lint, type checks, mocked integration tests, and relevant UI tests, then fix failures
  - Completion notes, 2026-06-15:
    - Added scenario-driven mocked GitHub API coverage for open PR with running CI, review requested, changes requested, approved with passing commit status, merged PR, and closed PR; existing tests already covered no PR, failed checks, passing checks, PR discovery, and review URL extraction.
    - Added handoff refresh coverage proving current PR number, branch, PR state, merge status, CI status, review status, delivery status, sync timestamp, and CI failure summary are rendered into refreshed `handoff.md`.
    - Existing repository tests continue to cover normalized delivery state persistence, PR/CI/review event de-duplication, Needs Review movement for open PRs, and Done movement for merged PRs.
    - Verification: `npm test`, `npm run typecheck`, and `npm run lint` all pass.
    - Images analyzed: 0.
