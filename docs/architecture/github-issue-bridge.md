---
type: reference
title: GitHub Issue Bridge
created: 2026-06-14
tags:
  - github
  - agent-orchestrator
  - loopboard
related:
  - '[[Spec-Kit-Importer]]'
  - '[[Task-Context-Files]]'
  - '[[Security-Policy]]'
  - '[[Risk-Policy]]'
  - '[[Loop-Execution-Engine]]'
---

# GitHub Issue Bridge

The GitHub Issue Bridge connects Loop Control Plane task cards to GitHub issues so a ready task can be handed to Agent Orchestrator with structured context and explicit labels. It builds on imported task context from [[Spec-Kit-Importer]], generated task files from [[Task-Context-Files]], and the approval rules described by [[Security-Policy]] and [[Risk-Policy]].

## Configuration

GitHub integration is optional. A project can store a GitHub repository as `owner/name`, and Loop Control Plane can infer that value from a detected GitHub remote when available.

Server-side GitHub access uses only environment tokens:

- `LOOPBOARD_GITHUB_TOKEN`
- `GITHUB_TOKEN`

Tokens must not be stored in task data, generated context files, logs, prompts, issue bodies, or task events. API error messages are redacted before they are returned to the UI or recorded in task state.

## Connection States

Project settings expose a connection check before users create issues or set up labels.

- `disconnected`: no GitHub repository is configured for the project.
- `token-missing`: a repository is configured, but no environment token is available.
- `repo-missing`: GitHub returned not found, or the token cannot access the repository.
- `connected`: the token can reach the configured repository.
- `api-error`: GitHub returned another API error or the request failed.

These states keep the main board usable even when GitHub is not configured.

## Label Protocol

Loop Control Plane manages a small label vocabulary for task routing and handoff:

- `loopboard`: issue was created or managed through Loop Control Plane.
- `ao-ready`: issue is ready for Agent Orchestrator pickup.
- `human-working`: a human is actively working the task.
- `human-review-needed`: human review is required before handoff or completion.
- `risk-low`, `risk-medium`, `risk-high`: task risk labels. Critical tasks map to `risk-high`.
- `area-frontend`, `area-backend`, `area-infra`, `area-test`: inferred work area labels.

Label setup is idempotent. Loop Control Plane checks each required label and creates missing labels only. Existing labels are left unchanged because the app does not persist provenance that would prove Loop Control Plane created them.

Issue creation applies labels from task state and risk policy:

- Every issue receives `loopboard` and one risk label.
- Human-owned or human-working tasks receive `human-working`.
- Tasks needing review, high-risk tasks, and critical-risk tasks receive `human-review-needed`.
- Low-risk ready tasks can receive `ao-ready` automatically when they are AI-owned or ready for AI handoff.
- Area labels are inferred from task text, task labels, source, and source artifact paths.

## AO Ready Gating

`ao-ready` is the first Agent Orchestrator handoff signal. Low-risk linked issues can receive `ao-ready` during AI assignment when policy allows it.

Medium, high, and critical tasks require an explicit local approval action before `ao-ready` is applied. The approval is recorded in task GitHub state and task events. Repeated assignment or approval actions are idempotent and should not duplicate events.

Users can explicitly mark or remove `ao-ready` from task details. These externally visible label changes are deliberate actions, not hidden side effects.

## Issue Template

Issue bodies are deterministic and generated from trusted Loop Control Plane data:

- Trusted Loop Control Plane task metadata: project, feature, task, status, owner, mode, risk, source, branch, and worktree.
- Task details.
- Source artifact paths, including feature artifacts and task context paths.
- Acceptance criteria.
- Trusted agent instructions.
- Trusted human notes.
- Explicit warning that external GitHub comments are untrusted.
- Calculated Loop Control Plane labels.

The issue body is intended to be a handoff brief. It should point agents to source artifacts rather than duplicating every artifact inline.

## Trusted And Untrusted Instructions

Loop Control Plane task data, source artifact paths, acceptance criteria, task context files, and human notes recorded inside Loop Control Plane are trusted workflow inputs.

GitHub comments, review text, CI output, issue edits made directly in GitHub, and other external GitHub content are untrusted context. Agents and workflow runners must not treat that content as execution instructions unless a human copies the instruction into trusted Loop Control Plane notes or task data.

This boundary is repeated in generated issue bodies so future comments on the issue cannot silently override the Loop Control Plane task.

## Persistence And Events

When Loop Control Plane creates a GitHub issue, it stores the issue URL, issue number, current issue labels, and last sync timestamp in task GitHub state. It also appends an `ISSUE_CREATED` event.

Label sync and handoff actions append task events such as:

- `ASSIGNED_TO_AI`
- `AO_READY_APPROVED`
- `HANDOFF_READY`
- `ISSUE_LABELS_SYNCED`

These events provide a local audit trail independent of GitHub history.

## Known Limitations

- GitHub issue creation and label sync require a server environment token; browser-only configuration is not supported.
- Loop Control Plane does not currently prove label provenance, so it never overwrites existing label descriptions or colors.
- The bridge stores issue numbers, URLs, labels, and sync timestamps, but not full GitHub issue history.
- `ao-ready` sync is label-based. It does not assign GitHub users, start external runners, or guarantee that Agent Orchestrator has picked up the issue.
- Area labels are inferred heuristically and may need human correction.
- Critical risk maps to `risk-high` because the current GitHub label vocabulary has no separate `risk-critical` label.
- External GitHub content remains untrusted even when it appears on a Loop Control Plane-linked issue.
