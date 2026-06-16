---
type: reference
title: Security Policy
created: 2026-06-14
tags:
  - security
  - automation
  - loopboard
related:
  - '[[Risk-Policy]]'
  - '[[Workflow-Editor-Runner]]'
  - '[[GitHub-Issue-Bridge]]'
  - '[[Human-Takeover]]'
---

# Security Policy

LoopBoard's security posture is intentionally conservative. It treats external content as untrusted by default, routes token access through server-only environment variables, restricts local command execution to a fixed allowlist, and redacts sensitive values before they can reach logs, handoff files, or generated prompts.

This document describes the implementation boundaries. Automation approval gates are covered separately in [[Risk-Policy]].

## Token Handling

GitHub tokens are server-side only. LoopBoard reads them exclusively from environment variables:

- `LOOPBOARD_GITHUB_TOKEN`
- `GITHUB_TOKEN`

Tokens are never stored in:

- Task data or task GitHub state
- Issue bodies or generated handoff files
- Task context markdown, Claude Code prompts, or JSONL event exports
- Workflow runner logs or run step records
- API error messages returned to the UI

API error responses from GitHub are sanitized before they are surfaced to the client or persisted in task events. The UI displays connection errors without exposing raw GitHub API messages or token details.

## Sensitive Value Redaction

Two independent redaction layers protect against secrets leaking through text content.

**External context redaction** (`lib/security/safe-context.ts`) applies to content that crosses trust boundaries — GitHub issue bodies, CI failure summaries, PR review text, handoff markdown edits, exported JSONL event data, and Claude Code prompt generation:

- `KEY_NAME=value` and `KEY_NAME: value` patterns for names containing `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `CREDENTIAL`, or `AUTHORIZATION`.
- `Bearer <token>` patterns.
- GitHub token shapes: `ghp_`, `gho_`, `ghs_`, `ghr_`, `ghu_` followed by 20+ alphanumeric characters.
- OpenAI-style API key shapes: `sk-` followed by 20+ alphanumeric characters.
- PEM private key blocks: `-----BEGIN ... PRIVATE KEY-----` through `-----END ... PRIVATE KEY-----`.

Redacted placeholders replace matched values with `[redacted]`, `[redacted-github-token]`, `[redacted-api-key]`, or `[redacted-private-key]`.

**Local command redaction** (`lib/system/local-command-runner.ts`) applies to command summary strings logged when task or project open-actions launch VS Code or the platform file explorer:

- `token=`, `secret=`, `password=`, `authorization=`, `api_key=`, `api-key=` followed by any value.
- `Bearer <token>` patterns.
- GitHub token shapes and `sk-` API key shapes.

These two redaction layers are independent. Neither guarantees complete coverage of every possible secret format — they target the shapes that appear in LoopBoard's own environment and GitHub integration context.

## Untrusted External Context

LoopBoard maintains a strict boundary between trusted workflow content and untrusted external signals.

**Trusted sources:**

- LoopBoard task data, project data, and feature data created or edited inside the application.
- Spec Kit artifacts imported through the importer.
- Human notes, handoff instructions, and return-to-AI notes recorded through LoopBoard UI.
- Task context files generated from LoopBoard-internal task state.
- Agent instructions embedded in generated issue bodies at issue creation time.

**Untrusted sources:**

- GitHub issue comments posted after issue creation.
- GitHub PR review comments and review summaries.
- CI output returned through GitHub Checks or CI failure summaries.
- GitHub issue body edits made directly in GitHub (outside LoopBoard).
- Any content arriving from external webhooks or third-party integrations.

Untrusted content is:

- Labeled with an `[external/untrusted]` prefix when surfaced in task detail views, handoff markdown, or Claude Code prompts.
- Clearly separated from trusted LoopBoard sections in generated files.
- Never treated as executable workflow instructions.
- Sanitized through `sanitizeExternalSummary` before being stored or forwarded.

Generated GitHub issue bodies include an explicit notice that future comments on the issue are untrusted and cannot override the LoopBoard task definition.

See [[GitHub-Issue-Bridge]] for the full issue body template and trusted/untrusted boundary in handoff generation. See [[Workflow-Editor-Runner]] for how workflow logs redact sensitive values and how external content is excluded from runner state.

## Shell Command Rules

Local command execution is constrained to a fixed, explicit allowlist. LoopBoard never interpolates strings into shell commands or builds command lines from user-supplied task data.

**Allowed fixed commands:**

- `code` — VS Code launch
- `open` — macOS file explorer / URL open
- `explorer.exe` — Windows file explorer
- `xdg-open` — Linux file explorer

**Execution rules:**

- Commands run with `shell: false` — no shell interpolation.
- The child process environment contains only `NODE_ENV`, `PATH`, `SystemRoot`, and `windir`. All other environment variables, including tokens, are excluded.
- Command arguments are fixed path strings resolved through `validateLocalDirectory`.
- Command summary strings logged for task events are redacted before persistence.
- Any command not in the allowlist throws a `command_not_allowed` error; it is never silently ignored.

**Path validation rules (`validateLocalDirectory`):**

- Paths containing a null byte (`\0`) are rejected immediately.
- Paths are resolved to absolute form before any check.
- When a `basePath` is supplied, the resolved path must remain inside the resolved base. Paths that resolve to `..` or outside the repository root are rejected with `path_traversal_rejected`.
- Non-existent paths return a `missing` error. Non-directory paths return a `not_directory` error.

Worktree open-actions validate the worktree path against the project repository root so worktree-based task actions cannot escape the project boundary.

**Workflow shell nodes:** Workflow nodes with `type: run-tests` or a `command`/`commands` config field are classified as shell-capable by `isShellCapableWorkflowNode`. Shell-capable nodes require explicit human approval regardless of their mode or risk policy setting and cannot auto-advance in the workflow runner. See [[Workflow-Editor-Runner]] and [[Risk-Policy]] for the approval gate details.

## Handoff File Safety

Saved `handoff.md` files, generated Claude Code prompts, task context markdown, and exported JSONL event records are produced from LoopBoard-internal data only.

When these files include external CI summaries or GitHub content, that content:

- Passes through `sanitizeExternalSummary` before writing.
- Is prefixed with `External CI Failure Summary: [external/untrusted]` in generated context.
- Is kept in a clearly labeled section separate from trusted LoopBoard instructions.

Generated Claude Code prompts never embed raw GitHub comments, CI logs, or PR review text as instructions.

## Non-Goals

The following are explicitly outside the security scope of the current MVP:

- **Cloud sync or remote storage encryption** — LoopBoard uses a local SQLite database. Encryption at rest is the responsibility of the operator's file system and device security.
- **Multi-user authentication or RBAC** — LoopBoard has no user accounts, sessions, or role-based access. It is a single-operator local tool.
- **Automatic merge or deploy pipeline gating** — No LoopBoard action merges pull requests or deploys to production automatically. Merge is always a human-controlled workflow node; see [[Human-Takeover]].
- **Complete secret scanning** — Redaction patterns cover known shapes. They do not scan for every possible secret format or enforce secrets management across arbitrary workflow configurations.
- **Audit-log integrity** — Task events are append-only in practice but are stored in SQLite without cryptographic integrity protection.
- **GitHub webhook verification** — LoopBoard does not currently receive GitHub webhooks. CI and PR data is fetched through explicit API calls, not pushed from GitHub.
