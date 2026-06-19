import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defaultExecutorConfigForNodeType,
  getWorkflowNodeExecutorMapping,
  isWorkflowApprovalGateNode,
  workflowNodeEngineJobBackend,
  workflowNodeExecutorMap,
  workflowNodeTypesWithEngineExecutors,
} from "@/lib/engine/workflow-node-executor-map";
import {
  normalizeWorkflowNodeConfig,
  resolveWorkflowNodeExecutorConfig,
} from "@/lib/engine/workflow-node-config";
import { validateExecutorConfig } from "@/lib/engine/loop-engine-types";
import { workflowNodeTypes } from "@/lib/workflows/workflow-editor";

describe("workflow node executor map", () => {
  it("maps every catalog node type", () => {
    for (const nodeType of workflowNodeTypes) {
      assert.ok(getWorkflowNodeExecutorMapping(nodeType), nodeType);
    }
  });

  it("marks human-controlled nodes as approval gates", () => {
    for (const nodeType of [
      "human-input",
      "human-review",
      "manual-claude-code-edit",
      "merge",
    ] as const) {
      assert.equal(isWorkflowApprovalGateNode(nodeType), true);
      assert.equal(workflowNodeExecutorMap[nodeType].approvalGate, true);
      assert.equal(
        workflowNodeExecutorMap[nodeType].executorModule,
        nodeType === "merge" ? "lib/engine/executors/merge-executor.ts" : null,
      );
    }
  });

  it("assigns engine executor modules to automatable node types", () => {
    const engineNodes = workflowNodeTypesWithEngineExecutors();
    assert.ok(engineNodes.includes("spec-kit-actions"));
    assert.ok(engineNodes.includes("import-tasks"));
    assert.ok(engineNodes.includes("create-github-issues"));
    assert.ok(engineNodes.includes("run-tests"));
    assert.ok(engineNodes.includes("pr-review-agent"));
    assert.ok(engineNodes.includes("merge"));
    assert.ok(!engineNodes.includes("human-input"));
  });

  it("documents direct reuse vs adapter needs for import and GitHub nodes", () => {
    const importMapping = workflowNodeExecutorMap["import-tasks"];
    assert.ok(importMapping.reuseDirectly.some((entry) => entry.includes("SpecKitTaskImporter")));
    assert.ok(importMapping.needsAdapter.length > 0);

    const issueMapping = workflowNodeExecutorMap["create-github-issues"];
    assert.ok(issueMapping.reuseDirectly.some((entry) => entry.includes("createGitHubIssue")));
  });
});

describe("workflow node executor config", () => {
  it("defaults executor config when nested executor is missing", () => {
    const config = resolveWorkflowNodeExecutorConfig({
      type: "spec-kit-actions",
      config: {},
    });

    assert.deepEqual(config, {
      backend: "stub",
      args: ["spec", "plan", "tasks"],
      timeoutMs: 300_000,
    });
  });

  it("accepts cwd and args aliases without breaking legacy command config", () => {
    const validation = validateExecutorConfig({
      backend: "stub",
      args: ["test"],
      cwd: "/tmp/project",
      timeoutMs: 60_000,
    });

    assert.equal(validation.ok, true);
    if (validation.ok) {
      assert.deepEqual(validation.config.args, ["test"]);
      assert.equal(validation.config.workingDirectory, "/tmp/project");
      assert.equal(validation.config.cwd, "/tmp/project");
    }

    const resolved = resolveWorkflowNodeExecutorConfig({
      type: "run-tests",
      config: {
        command: "npm test",
      },
    });

    assert.equal(resolved.command, "npm test");
    assert.deepEqual(resolved.args, ["test"]);
  });

  it("preserves saved workflows with empty config objects", () => {
    const normalized = normalizeWorkflowNodeConfig({}, "human-input");
    assert.deepEqual(normalized, {});

    const importNormalized = normalizeWorkflowNodeConfig({}, "import-tasks");
    assert.ok(importNormalized.executor);
  });

  it("uses per-node defaults from the executor map", () => {
    assert.deepEqual(defaultExecutorConfigForNodeType("agent-orchestrator-implement"), {
      backend: "agent-orchestrator",
      timeoutMs: 1_800_000,
    });
  });

  it("routes built-in workflow executors through the dispatcher backend", () => {
    assert.equal(workflowNodeEngineJobBackend("import-tasks", "cursor"), "stub");
    assert.equal(
      workflowNodeEngineJobBackend("create-github-issues", "claude-code"),
      "stub",
    );
    assert.equal(workflowNodeEngineJobBackend("pr-review-agent", "claude-code"), "stub");
    assert.equal(workflowNodeEngineJobBackend("ai-review", "cursor"), "stub");
    assert.equal(workflowNodeEngineJobBackend("spec-kit-actions", "cursor"), "cursor");
    assert.equal(
      workflowNodeEngineJobBackend(
        "agent-orchestrator-implement",
        "agent-orchestrator",
      ),
      "stub",
    );
  });
});
