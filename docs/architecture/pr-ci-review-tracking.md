---
type: reference
title: PR CI Review Tracking
created: 2026-06-14
tags:
  - github
  - ci
  - review
  - loopboard
related:
  - '[[GitHub-Issue-Bridge]]'
  - '[[Human-Takeover]]'
  - '[[Security-Policy]]'
---

# PR CI Review Tracking

PR CI review tracking extends the issue bridge from [[GitHub-Issue-Bridge]] so LoopBoard can show pull request, check, and review state on task cards and task details. It supports human review handoff from [[Human-Takeover]] while preserving the trust boundary defined by [[Security-Policy]].

## Purpose

LoopBoard keeps GitHub synchronization manual-first. A user explicitly runs PR/CI sync from a task, and LoopBoard stores only concise task-routing metadata:

- Pull request number, URL, branch, state, and merge status.
- CI status and a short failed-check summary.
- Review status and a link to the latest relevant approval or changes-requested review.
- Latest PR/CI sync timestamp.
- A normalized delivery status for board badges and filters.

The board remains usable when GitHub is disconnected, a token is missing, or no pull request has been opened yet.

## PR Discovery

Manual PR sync uses the configured project repository and the server-side GitHub token from the same environment-token path as issue sync. Tokens are never stored in task data, generated context files, events, or prompts.

LoopBoard discovers pull requests in this order:

1. Explicit PR URL supplied by the user during sync.
2. Existing task GitHub metadata, including stored PR number or PR URL.
3. Linked issue timeline cross-references when the task has a GitHub issue number.
4. Branch lookup using the task GitHub PR branch or task branch against `owner:branch`.

When multiple PRs are discovered, LoopBoard prefers an open or merged PR over a closed PR, then uses the most recently updated PR. It fetches PR state, head branch, head SHA, merge status, requested reviewers, latest reviews, and linked issue carry-forward. Open non-draft PRs move eligible tasks to `needs-review`; merged PRs move tasks to `done`.

## Persisted State

PR/CI/review metadata is stored in `tasks.github` and remains compatible with older tasks that only contain issue fields. Missing fields are treated as unknown or absent rather than invalid.

The tracked PR fields are:

- `pullRequestNumber`
- `pullRequestUrl`
- `pullRequestBranch`
- `pullRequestState`: `open`, `draft`, `closed`, or `merged`
- `mergeStatus`: `unknown`, `mergeable`, `conflicting`, or `merged`
- `reviewStatus`: `not-requested`, `requested`, `changes-requested`, or `approved`
- `reviewUrl`
- `ciStatus`: `not-started`, `pending`, `failing`, or `passing`
- `ciFailureSummary`
- `deliveryStatus`
- `prCiLastSyncedAt`

## Delivery Status

LoopBoard derives a normalized delivery status from GitHub metadata for consistent board display:

- `no-pr`: no PR number or URL is known.
- `pr-opened`: a PR exists, with no more specific CI or review signal.
- `ci-running`: CI has at least one pending check and no failing check.
- `ci-failed`: CI has a failing check.
- `ci-passed`: CI has at least one passing check and no pending or failing check.
- `review-requested`: review has been requested and no approval or changes-requested review is newer.
- `changes-requested`: the latest relevant review requests changes.
- `approved`: the latest relevant review approves the PR.
- `merged`: the PR state or merge status is merged.
- `closed`: the PR is closed without being marked merged.

Merged and closed states take precedence over all other signals. Review signals take precedence over CI signals, and CI failure takes precedence over running or passing.

## CI Normalization

CI sync reads both GitHub check runs and combined commit statuses for the PR head commit. LoopBoard normalizes individual checks into:

- `pending`: queued, in progress, requested, waiting, or pending.
- `passing`: successful check runs or successful commit statuses.
- `failing`: failed, cancelled, timed out, action-required, failure, or error results.
- `neutral`: any other result.

The task-level CI status is then derived as:

- `not-started` when no check data is available or all checks are neutral.
- `failing` when any check is failing.
- `pending` when no check is failing and at least one check is pending.
- `passing` when at least one check is passing and none are pending or failing.

Failure summaries include only failed check names and their GitHub links, capped to the first five failing checks with a short overflow note. LoopBoard does not fetch, store, or summarize full CI logs.

## Review Tracking

Review sync considers requested reviewers and the latest relevant GitHub review. `CHANGES_REQUESTED` and `APPROVED` reviews are sorted by submission time, and the newest relevant review determines the review status. If there is no relevant review but requested reviewers or teams are present, the task is marked `requested`; otherwise it is `not-requested`.

When available, LoopBoard stores a link to the latest relevant review. It does not store review comment bodies as trusted task instructions.

## Events And Handoff

State changes append local task events only when the normalized field changes, keeping repeated syncs idempotent:

- `PR_OPENED`
- `CI_RUNNING`
- `CI_FAILED`
- `CI_PASSED`
- `REVIEW_REQUESTED`
- `REVIEW_CHANGES_REQUESTED`
- `REVIEW_APPROVED`
- `DONE`

Generated `events.jsonl`, task context, and refreshed `handoff.md` include current PR, CI, review, delivery, branch, merge, sync timestamp, and concise failure-summary metadata. Handoff timelines group same-timestamp GitHub sync events into a `GITHUB_SYNC` entry so noisy PR, CI, and review updates remain readable.

## Trust Boundary

GitHub is external context. LoopBoard may display or link to PRs, failed checks, and reviews, but it does not trust those sources as execution instructions.

The following are intentionally not trusted:

- GitHub comments.
- Review comment text.
- CI logs and check output.
- Direct GitHub issue or PR edits.
- Branch names or PR titles as instructions.

Agents and workflow runners must treat those sources as external signals only. A human must copy any instruction from GitHub into trusted LoopBoard task data, acceptance criteria, or notes before it can direct work.

## Known Limitations

- Sync is manual-first; there is no background scheduler in the current PR/CI path.
- CI status is based on GitHub check run and commit status APIs for the PR head SHA.
- Failure summaries are intentionally brief and may not include every failing check.
- Review tracking uses the latest relevant approval or changes-requested review and requested reviewer counts; it does not model every review thread.
- Closed PRs keep prior CI and review state where available because GitHub may not return useful current check data for inactive PRs.
