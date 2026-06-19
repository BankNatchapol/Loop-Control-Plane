# Phase 04: Agent Backends And Orchestrator Adapter

This phase adds real external agent backends — Cursor, Claude Code, Codex, and Agent Orchestrator — behind the executor registry, with per-step configuration and multi-agent fan-out for parallel work. Loop Control Plane can delegate heavy execution externally while the in-app scheduler tracks job state, syncs results back to the Kanban board, and keeps human approval gates intact.

## Tasks

- [x] Inspect CLI/SDK surfaces and define backend adapter contracts:
  - Read Cursor SDK skill if present at `~/.cursor/skills-cursor/sdk/SKILL.md`; otherwise document assumed CLI entrypoints (`cursor agent`, `claude`, `codex`) and verify availability with non-interactive `--version` checks only
  - Review Agent Orchestrator docs at https://github.com/AgentWrapper/agent-orchestrator (SETUP.md, CLI.md, examples/simple-github.yaml) for `ao spawn`, `ao status`, `ao send`, dashboard URL, and GitHub `ao-ready` pickup semantics
  - Add `lib/engine/backends/backend-adapter.ts` interface: `checkAvailability()`, `execute(job, context)`, `cancel(jobId)`, `poll?(job)` returning `{ status, summary, artifacts? }`
  - Extend `ExecutorConfig` with backend-specific options: `{ promptFile?, issueNumber?, branch?, fanOut?: { maxConcurrency, issueIds[] }, aoProjectId?, model? }`
  - All adapters must run with cwd constrained to project repo/worktree and never accept arbitrary shell strings from node config
  - **Notes (2026-06-16):** Cursor SDK skill read; local probes — `cursor agent --version`, `claude --version`, `codex --version` OK; `ao --version` missing. AO CLI.md 404 upstream; SETUP.md + quickstart cover spawn/status/send. Contract in `lib/engine/backends/backend-adapter.ts`, probes in `cli-availability.ts`, research in `docs/research/backend-cli-surfaces-inspection.md`.

- [x] Implement Cursor, Claude Code, and Codex backend adapters:
  - Add `lib/engine/backends/cursor-backend.ts` invoking Cursor CLI/SDK with prompt from generated `task.md` + `context.md` paths; capture exit code and redacted stdout tail in engine logs
  - Add `lib/engine/backends/claude-code-backend.ts` reusing prompt assembly from `TaskContextService.generateClaudeCodePrompt` and launching Claude Code in print/non-interactive mode when available
  - Add `lib/engine/backends/codex-backend.ts` with parallel structure for Codex CLI if installed; degrade gracefully with explainable `backend_unavailable` errors when binary missing
  - Register all three in `executor-registry.ts` and wire task-run + workflow-step jobs to resolve backend from node/task/project config with fallback order: node config → project default → global default (`stub` in CI, configurable locally)
  - Add project settings fields for default task backend and default review backend persisted in project config JSON
  - **Notes (2026-06-16):** Shared CLI adapter factory in `cli-backend-adapters.ts`; `ExternalBackendExecutor` wraps adapters for task-run orchestration; `executor-config-resolver.ts` + `Project.engineSettings` (migration `0009`); process-runner cursor/claude/codex profiles enabled; tests in `tests/backend-adapters.test.ts`.

- [x] Implement Agent Orchestrator adapter for fan-out and multi-task execution:
  - Add `lib/engine/backends/agent-orchestrator-backend.ts` that wraps audited `process-runner` calls to `ao spawn`, `ao status`, and optional `ao send`
  - Add per-project AO config: `{ enabled, configPath?, projectId?, dashboardUrl?, pollIntervalMs? }` stored in project settings with path validation relative to repo
  - For single-task handoff: when task has linked GitHub issue and `ao-ready` label (or policy allows applying it), spawn AO session against issue number and record external session id on the engine job result
  - For fan-out: accept workflow node config `fanOut.maxConcurrency` and a list of ready task/issue ids; enqueue parallel AO spawns up to concurrency limit with dedupe by issue number
  - Poll AO status until terminal state (completed/failed/cancelled) or timeout; map external completion to task transitions (Needs Review / Blocked) and workflow branch labels
  - Do not auto-merge PRs; AO results remain external/untrusted until human review per `[[Security-Policy]]`
  - **Notes (2026-06-16):** `agent-orchestrator-config.ts` validates repo-relative AO yaml paths and resolves per-project settings; `agent-orchestrator-backend.ts` spawns/polls via process-runner `ao` profile with fan-out concurrency pool, `ao-ready` handoff via `ensureAoReadyHandoff`, `poll()` for future sync service, and untrusted result payloads (`branchLabel`, `prUrl`, `externalSessionId`); registered in `external-backend-executor.ts`; tests in `tests/agent-orchestrator-backend.test.ts`.

- [x] Sync Agent Orchestrator and backend outcomes back to the board:
  - Add `lib/engine/engine-sync-service.ts` to reconcile in-flight engine jobs with external status: update task owner/status, append task/feature events, refresh context/handoff files with `[external/untrusted]` summaries where appropriate
  - When AO reports linked PR URL, call existing PR sync helpers from `lib/github/github-prs.ts` to attach PR metadata to tasks
  - Update Kanban cards when backend completes without requiring manual **Sync** clicks beyond existing dashboard polling
  - Handle stuck jobs: if poll exceeds timeout, mark job failed, move task to Blocked with actionable error, and leave AO session running externally (do not kill by default)
  - **Notes (2026-06-16):** `engine-sync-service.ts` polls running jobs with `awaitingExternalSync`; integrated into `LoopScheduler.tick`; single-task AO handoff defers terminal poll to sync; `backend-adapter-registry.ts`; `ENGINE_EXTERNAL_SYNC` event type; PR attach via `syncGitHubPullRequest`; tests in `tests/engine-sync-service.test.ts`.

- [x] Add backend configuration UI and availability indicators:
  - Extend project settings form with default backends dropdowns and Agent Orchestrator section (enabled toggle, config path, project id)
  - Show backend availability chips in Engine panel (`cursor: installed`, `ao: config missing`, etc.) from lightweight availability checks cached for 60s
  - In workflow editor executor config, show backend-specific fields (AO fan-out concurrency, Cursor model optional) and link to `docs/architecture/loop-execution-engine.md`
  - Add task detail **Open AO Dashboard** link when AO dashboard URL is configured
  - **Notes (2026-06-16):** `backend-availability-service.ts` + `GET /api/engine/backends/availability` with 60s cache; project form `engineSettings` fields; Engine panel chips (`data-testid="backend-availability-chips"`); workflow editor model/fan-out fields; task detail `open-ao-dashboard-link`; tests in `backend-availability-service.test.ts`, `loop-engine-api.test.ts`, `workflow-executor-editor.test.ts`.

- [x] Write backend and orchestrator adapter tests:
  - Add `tests/backend-adapters.test.ts` with mocked `process-runner` for Cursor/Claude/Codex success, missing binary, timeout, and redaction
  - Add `tests/agent-orchestrator-backend.test.ts` covering spawn args, fan-out concurrency cap, poll completion mapping, and external PR URL sync
  - Add `tests/engine-sync-service.test.ts` for task status reconciliation and untrusted summary labeling
  - Mock all real CLI invocations in CI — no network or AO daemon required for tests to pass
  - **Notes (2026-06-16):** All three suites use mocked `ProcessRunner` spawners (no real CLI/AO/network). `backend-adapters.test.ts` covers success, `backend_unavailable`, `backend_cli_failed`, `backend_timeout`, stdout redaction, and executor-config fallback; `agent-orchestrator-backend.test.ts` covers spawn args, fan-out cap/dedupe, poll mapping, handoff gates, and poll timeout; `engine-sync-service.test.ts` covers Needs Review/Blocked reconciliation, untrusted summaries, PR URL sync, and no-cancel-on-timeout. 290 tests pass.

- [x] Document backends and run integration verification:
  - Extend `docs/architecture/loop-execution-engine.md` with Agent Backends section covering Cursor/Claude/Codex/AO, fan-out semantics, config paths, and wiki-links to `[[GitHub-Issue-Bridge]]` and `[[Human-Takeover]]`
  - Add `docs/architecture/agent-orchestrator-bridge.md` with YAML front matter describing AO handoff flow, required `gh` auth, `ao-ready` label contract, and non-goals (no auto-merge)
  - Run `npm run lint`, `npm run typecheck`, and `npm test`; fix failures
  - Optional local walkthrough when AO/Cursor/Claude installed: enqueue task-run with each backend on a sample Ready task and confirm board updates; otherwise verify via mocked tests only
  - **Notes (2026-06-16):** Added **Agent Backends (Phase 04)** section to `loop-execution-engine.md` (adapter contract, resolution order, CLI/AO adapters, sync service, project settings, UI availability). New `agent-orchestrator-bridge.md` covers handoff flow, `ao-ready`/`gh` contract, fan-out, sync mapping, and non-goals. README Loop Engine blurb links both docs. Verification: lint/typecheck clean; 290 tests pass (mocked CLI/AO only — no local backend walkthrough on this host).
