---
type: reference
title: Workflow Editor Runner
created: 2026-06-14
tags:
  - workflow
  - react-flow
  - runner
  - loopboard
related:
  - '[[GitHub-Issue-Bridge]]'
  - '[[Spec-Kit-Importer]]'
  - '[[Risk-Policy]]'
  - '[[Security-Policy]]'
---

# Workflow Editor Runner

The Workflow Editor Runner adds a visual LoopBoard workflow surface without replacing the Kanban board. It lets a project save graph-shaped workflow definitions, import or export those definitions through the configured workflow folder, and execute runs one node at a time with explicit pauses for human-controlled work.

It connects Spec Kit planning from [[Spec-Kit-Importer]], issue handoff from [[GitHub-Issue-Bridge]], conservative automation gates from [[Risk-Policy]], and trusted-input boundaries from [[Security-Policy]].

## Data Model

Workflow definitions are project-scoped. A run always targets the workflow's project and can optionally target a feature so workflow events can appear in feature and task history.

- `Workflow`: name, description, version, project, graph nodes, graph edges, and free-form config.
- `WorkflowNode`: type, display name, mode, canvas position, input artifacts, output artifacts, approval requirement, retry count, risk policy, config, and current state.
- `WorkflowEdge`: source node, target node, label, and optional condition config.
- `WorkflowRun`: workflow, project, optional feature, status, current node, input and output artifacts, execution logs, timestamps, and steps.
- `WorkflowRunStep`: node execution status, attempt count, input and output artifacts, logs, approval metadata, error text, and timestamps.

Artifacts are named path references, not embedded blobs. They can point to Spec Kit files, LoopBoard resources, Git branches, GitHub URLs, or generated run outputs.

## Node Types

The editor catalog supports these MVP node types:

- `human-input`: captures the feature brief or PRD input from a person.
- `spec-kit-actions`: represents Spec Kit generation of spec, plan, and tasks artifacts.
- `human-review`: pauses for review of generated Spec Kit artifacts.
- `import-tasks`: imports approved Spec Kit tasks into LoopBoard task cards.
- `create-github-issues`: creates or links GitHub issues for imported tasks.
- `agent-orchestrator-implement`: hands ready work to Agent Orchestrator implementation.
- `run-tests`: records deterministic test execution intent and report artifacts.
- `ai-review`: records AI review output and branches toward approval or manual changes.
- `manual-claude-code-edit`: captures a human-directed Claude Code edit loop.
- `open-pr`: records pull request creation or linking.
- `merge`: pauses for human-controlled merge approval.

These types are intentionally descriptive workflow steps. The runner does not yet execute arbitrary shell commands, invoke Spec Kit directly, mutate GitHub issues outside existing bridge behavior, or run Agent Orchestrator jobs.

## Modes

Nodes use four execution modes:

- `auto`: the runner may complete the node deterministically without human approval when the node settings are safe.
- `human`: the runner pauses and waits for explicit human approval before producing outputs.
- `semi`: the runner pauses like a human step because it represents automation that still requires operator confirmation.
- `disabled`: the runner skips the node and records a skipped step.

Risk policies are `low`, `medium`, `high`, `critical`, and `manual-only`. Human and semi-auto nodes must require approval. Auto nodes cannot run without approval when configured as `critical` or `manual-only`.

## Editor Behavior

The React Flow editor is embedded in the project dashboard as a focused tool surface. Users can add catalog nodes, drag nodes, connect nodes with edges, remove edges, edit node settings in the side panel, and save definitions per project.

The editor validates definitions before persistence. Blocking validation covers empty graphs, duplicate node IDs, duplicate edge IDs, invalid node modes, invalid risk policies, missing edge endpoints, disconnected nodes, and unsafe mode or risk combinations.

Workflow files can be exported as JSON into the project's configured workflow directory. Imports are path-constrained to that same directory, validate the graph before saving, and report structured overwrite conflicts before replacing an existing workflow.

## Runner Behavior

Starting a run creates a `running` workflow run at the first node with no inbound edge, or the first node when the graph has no clear root. The runner then advances only through explicit actions:

- Start Run creates the run and records a run-start log.
- Run Next Step evaluates the current node.
- Approve Human Step completes a waiting approval step and advances to the next node.
- Skip Disabled Step skips only disabled nodes.
- Fail Step marks the current node and run as failed.
- Resume restarts a paused run only after no current step is still waiting for approval.

For auto nodes, the MVP runner records deterministic metadata logs, resolves output artifact placeholders such as `{run}` and `{feature}`, and advances to the next edge target. For human, semi-auto, or approval-required nodes, it records a waiting step and changes the run status to `paused`. For disabled nodes, it records a `skipped` step and advances.

The current traversal uses the first outgoing edge from a node. Conditional edge labels document branch intent, but full condition evaluation is a future automation boundary.

## Pause Semantics

A paused run is not runnable until the waiting step is approved. Run Next Step rejects attempts to bypass a pending approval. Resume is reserved for paused runs that no longer have an approval wait at the current node.

Approval creates output artifact records from the approved node, appends approval logs, completes the waiting step, and then advances the run. Merge, manual edit, human review, and semi-auto integration points therefore remain operator-controlled even when they sit inside an otherwise automated graph.

## Context Links And Events

Feature-targeted runs append feature events when the run starts and when steps complete. Completed steps can append task events when their artifacts or node type materially relate to imported tasks, created GitHub issues, or pull requests.

This gives LoopBoard a local audit trail independent of external GitHub history and keeps the dashboard's latest run status tied to the project context.

## Security And Automation Boundaries

Workflow logs redact token, secret, password, authorization, bearer-token, and API-key shaped values before persistence. External content remains untrusted unless a human copies it into trusted LoopBoard data.

The MVP runner is deliberately deterministic. It records intent, approval state, artifact references, and local events, but it does not automatically execute unreviewed commands, merge pull requests, apply generated patches, or treat GitHub comments and CI output as instructions.

Future automation should keep these boundaries:

- Gate high-impact and manual-only work behind explicit approval.
- Execute external tools through narrow, audited service methods instead of node config strings.
- Store artifact references and summaries, not secrets or large opaque outputs.
- Preserve idempotent imports, issue creation, and event creation where retries are possible.
- Add condition evaluation only with visible branch criteria and test coverage for unsafe branches.
