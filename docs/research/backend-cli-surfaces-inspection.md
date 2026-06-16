---
type: research
title: Backend CLI Surfaces Inspection
created: 2026-06-16
tags:
  - engine
  - backends
  - cursor
  - claude-code
  - codex
  - agent-orchestrator
related:
  - '[[Loop-Execution-Engine]]'
  - '[[GitHub-Issue-Bridge]]'
  - '[[Security-Policy]]'
---

# Backend CLI Surfaces Inspection

Phase 04 task 1 inventory of external agent entrypoints and Agent Orchestrator CLI semantics. Availability probes use non-interactive `--version` checks only.

## Cursor

**SDK (preferred for programmatic integration):** `@cursor/sdk` (`Agent.prompt`, `Agent.create`, `Agent.resume`) with explicit `local: { cwd }` or `cloud: { repos }`. Requires `CURSOR_API_KEY`. See Cursor SDK skill at `~/.cursor/skills-cursor/sdk/SKILL.md`.

**CLI entrypoint (Phase 04 adapter default):**

| Probe | Result (2026-06-16 dev machine) |
|-------|----------------------------------|
| `cursor agent --version` | `2026.06.15-18-00-12-6f5a2cf` |

Planned adapter invocation: fixed argv via process-runner `cursor` profile — read prompt from generated `task.md` + `context.md` paths (`ExecutorConfig.promptFile`), never shell-interpolate node `command`.

## Claude Code

| Probe | Result |
|-------|--------|
| `claude --version` | `2.1.153 (Claude Code)` |

Planned adapter: non-interactive print mode when available; reuse `TaskContextService.generateClaudeCodePrompt` for prompt assembly.

## Codex

| Probe | Result |
|-------|--------|
| `codex --version` | `codex-cli 0.137.0` |

Planned adapter: parallel structure to Claude Code; degrade with `backend_unavailable` when binary missing.

## Agent Orchestrator

**Install:** `npm install -g @aoagents/ao` (package `@aoagents/ao`).

| Probe | Result |
|-------|--------|
| `ao --version` | Not installed on inspection host |

### CLI commands (from upstream SETUP.md / quickstart)

| Command | Purpose |
|---------|---------|
| `ao start [url\|path]` | Launch dashboard + orchestrator; auto-generates `agent-orchestrator.yaml` |
| `ao spawn <issue-id>` | Spawn agent session for GitHub issue (project auto-detected from cwd) |
| `ao status` | Text dashboard; `ao status --json` for machine-readable session list |
| `ao send <session-name> "message"` | Nudge a running session |
| `ao open <session-name>` | Attach to live terminal |
| `ao session ls [--json]` | List sessions; terminated hidden unless `--include-terminated` |

**Dashboard URL:** default `http://localhost:3000` (configurable via `port:` / `AO_PUBLIC_URL`).

**GitHub pickup contract:** Loop Control Plane applies `ao-ready` on linked issues per [[GitHub-Issue-Bridge]]. AO itself spawns via `ao spawn <issue-number>` after `gh` auth; the label is the handoff signal on the Loop Control Plane side — AO polls GitHub/PR state via `gh`, not webhooks.

**Minimal config** (`examples/simple-github.yaml`):

```yaml
projects:
  my-app:
    repo: owner/my-app
    path: ~/my-app
    defaultBranch: main
```

**Fan-out:** workflow nodes may set `executor.fanOut.maxConcurrency` + `executor.fanOut.issueIds[]`; adapter enqueues parallel `ao spawn` up to concurrency with dedupe by issue number.

## Adapter contract

Defined in `lib/engine/backends/backend-adapter.ts`:

- `checkAvailability()` — lightweight CLI probe
- `execute(job, context)` — audited argv, cwd constrained under repo
- `cancel(jobId)`
- `poll?(job)` → `{ status, summary, artifacts? }`

Shared helpers:

- `resolveBackendWorkingDirectory` / `buildBackendExecutionContext`
- `assertSafeBackendConfig` — rejects legacy `command` strings on external backends

CLI probes live in `lib/engine/backends/cli-availability.ts`.

## ExecutorConfig extensions

Backend-specific fields on `ExecutorConfig`:

| Field | Type | Usage |
|-------|------|-------|
| `promptFile` | string | Relative path to generated task prompt |
| `issueNumber` | number | GitHub issue for AO / issue-scoped runs |
| `branch` | string | Target branch hint |
| `fanOut` | `{ maxConcurrency, issueIds[] }` | Parallel AO spawns |
| `aoProjectId` | string | Key under `projects:` in AO yaml |
| `model` | string | Optional Cursor / Claude / Codex model id |
