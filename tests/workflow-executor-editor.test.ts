import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { withExecutorConfig } from "@/lib/engine/loop-engine-types";
import { createCatalogWorkflowNode } from "@/lib/workflows/workflow-editor";
import {
  AO_AGENT_PLUGIN_OPTIONS,
  aoAgentPluginLabel,
  applyExecutorEditorPatch,
  extractEngineJobIdFromWorkflowStep,
  formatExecutorArgs,
  isAutomatableWorkflowNodeType,
  parseExecutorArgs,
  readExecutorEditorState,
  workflowExecutorBackendLabel,
  workflowExecutorBackendOptions,
  workflowNodeExecutorPolicyWarnings,
  workflowNodeExecutorRuntimeHint,
} from "@/lib/workflows/workflow-executor-editor";

describe("workflow executor editor helpers", () => {
  it("uses human-readable AO agent labels", () => {
    assert.equal(aoAgentPluginLabel("cursor"), "Cursor");
    assert.equal(aoAgentPluginLabel("codex"), "Codex");
    assert.equal(aoAgentPluginLabel(undefined), "Claude Code");
  });

  it("only offers built-in transport for deterministic workflow nodes", () => {
    assert.deepEqual(workflowExecutorBackendOptions("import-tasks"), ["stub"]);
    assert.deepEqual(workflowExecutorBackendOptions("run-tests"), ["stub"]);
    assert.deepEqual(workflowExecutorBackendOptions("spec-kit-actions"), [
      "cursor",
      "claude-code",
      "codex",
    ]);
    assert.deepEqual(
      workflowExecutorBackendOptions("agent-orchestrator-implement"),
      ["agent-orchestrator"],
    );
  });

  it("uses CLI-compatible default agent model names", () => {
    assert.deepEqual(
      Object.fromEntries(
        AO_AGENT_PLUGIN_OPTIONS.map(({ value, defaultModel }) => [
          value,
          defaultModel,
        ]),
      ),
      {
        "claude-code": "claude-sonnet-4-6",
        codex: "gpt-5.5",
        cursor: "composer-2.5",
      },
    );
  });

  it("reads and applies executor editor fields for automatable nodes", () => {
    const node = createCatalogWorkflowNode({
      type: "spec-kit-actions",
      workflowId: "workflow-editor",
      index: 0,
    });

    assert.equal(isAutomatableWorkflowNodeType(node.type), true);
    assert.equal(readExecutorEditorState(node).backend, "stub");
    assert.match(readExecutorEditorState(node).argsText, /spec/u);
    assert.equal(readExecutorEditorState(node).model, "");
    assert.equal(readExecutorEditorState(node).fanOutMaxConcurrency, "");

    const nextConfig = applyExecutorEditorPatch(node, {
      backend: "cursor",
      argsText: "spec, plan",
      timeoutMs: "120000",
      model: "composer-2.5-fast",
    });

    const updated = { ...node, config: nextConfig };
    const state = readExecutorEditorState(updated);

    assert.equal(state.backend, "cursor");
    assert.equal(state.argsText, "spec, plan");
    assert.equal(state.timeoutMs, "120000");
    assert.equal(state.model, "composer-2.5-fast");
  });

  it("labels and explains built-in executor paths", () => {
    const node = createCatalogWorkflowNode({
      type: "spec-kit-actions",
      workflowId: "workflow-editor-labels",
      index: 0,
    });
    const state = readExecutorEditorState(node);

    assert.equal(
      workflowExecutorBackendLabel("stub", node.type),
      "stub (unsupported)",
    );
    assert.equal(workflowExecutorBackendLabel("stub"), "stub (built-in)");
    assert.match(
      workflowNodeExecutorRuntimeHint(node, state) ?? "",
      /agent backend/u,
    );

    const codexState = readExecutorEditorState({
      ...node,
      config: applyExecutorEditorPatch(node, { backend: "codex", model: "gpt-5" }),
    });

    assert.match(
      workflowNodeExecutorRuntimeHint(node, codexState) ?? "",
      /new engine jobs/u,
    );
  });

  it("reads and applies Agent Orchestrator fan-out settings", () => {
    const node = createCatalogWorkflowNode({
      type: "spec-kit-actions",
      workflowId: "workflow-ao-fanout",
      index: 0,
    });

    const nextConfig = applyExecutorEditorPatch(node, {
      backend: "agent-orchestrator",
      fanOutMaxConcurrency: "2",
      fanOutIssueIdsText: "101, 102",
    });
    const state = readExecutorEditorState({ ...node, config: nextConfig });

    assert.equal(state.backend, "agent-orchestrator");
    assert.equal(state.fanOutMaxConcurrency, "2");
    assert.equal(state.fanOutIssueIdsText, "101, 102");
  });

  it("parses comma-separated executor args", () => {
    assert.deepEqual(parseExecutorArgs("spec, plan , tasks"), [
      "spec",
      "plan",
      "tasks",
    ]);
    assert.equal(formatExecutorArgs(["npm", "test"]), "npm, test");
  });

  it("warns when shell-capable nodes run in auto mode without approval", () => {
    const node = createCatalogWorkflowNode({
      type: "run-tests",
      workflowId: "workflow-shell-policy",
      index: 0,
    });

    const warnings = workflowNodeExecutorPolicyWarnings({
      ...node,
      mode: "auto",
      requireApproval: false,
    });

    assert.match(warnings[0] ?? "", /shell commands/);
    assert.match(warnings[0] ?? "", /Auto mode without approval/);
  });

  it("extracts engine job ids from workflow step logs", () => {
    const jobId = extractEngineJobIdFromWorkflowStep({
      id: "step-1",
      runId: "run-1",
      workflowNodeId: "node-1",
      status: "running",
      attempt: 1,
      inputArtifacts: [],
      outputArtifacts: [],
      executionLogs: [
        {
          timestamp: "2026-06-16T00:00:00.000Z",
          level: "info",
          message: "Queued engine job engine-job-123.",
          metadata: { engineJobId: "engine-job-123" },
        },
      ],
      requireApproval: false,
      startedAt: "2026-06-16T00:00:00.000Z",
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:00.000Z",
    });

    assert.equal(jobId, "engine-job-123");
  });

  it("preserves unrelated config keys when updating executor settings", () => {
    const node = createCatalogWorkflowNode({
      type: "import-tasks",
      workflowId: "workflow-import",
      index: 0,
    });
    const config = withExecutorConfig(
      { featureRoot: "specs" },
      readExecutorEditorState(node).backend === "stub"
        ? { backend: "stub", timeoutMs: 120_000 }
        : { backend: "stub" },
    );

    const updated = applyExecutorEditorPatch(
      { type: node.type, config },
      { backend: "codex" },
    );

    assert.equal(updated.featureRoot, "specs");
    assert.equal(
      (updated.executor as { backend?: string } | undefined)?.backend,
      "codex",
    );
  });
});
