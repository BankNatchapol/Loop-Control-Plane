import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { seedWorkflows } from "@/lib/loopboard";
import {
  createCatalogWorkflowNode,
  normalizeWorkflowEdge,
  validateWorkflowDefinition,
  workflowNodeWarnings,
} from "@/lib/workflows/workflow-editor";

describe("workflow editor validation", () => {
  it("accepts the seeded feature development workflow graph", () => {
    const workflow = seedWorkflows[0]!;

    assert.deepEqual(
      validateWorkflowDefinition({
        nodes: workflow.nodes,
        edges: workflow.edges,
      }),
      [],
    );
  });

  it("reports duplicate ids, disconnected nodes, invalid references, and unsafe settings", () => {
    const workflowId = "workflow-validation";
    const timestamp = "2026-06-16T00:00:00.000Z";
    const humanInput = {
      ...createCatalogWorkflowNode({
        type: "human-input",
        workflowId,
        index: 0,
      }),
      id: "node-human-input",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const unsafeAuto = {
      ...createCatalogWorkflowNode({
        type: "run-tests",
        workflowId,
        index: 1,
      }),
      id: "node-run-tests",
      riskPolicy: "critical" as const,
      requireApproval: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const disconnected = {
      ...createCatalogWorkflowNode({
        type: "merge",
        workflowId,
        index: 2,
      }),
      id: "node-merge",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const edge = {
      ...normalizeWorkflowEdge({
        workflowId,
        sourceNodeId: humanInput.id,
        targetNodeId: "node-missing",
      }),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const issueCodes = validateWorkflowDefinition({
      nodes: [humanInput, unsafeAuto, disconnected, { ...disconnected }],
      edges: [edge, { ...edge }],
    }).map((issue) => issue.code);

    assert.ok(issueCodes.includes("duplicate-node-id"));
    assert.ok(issueCodes.includes("duplicate-edge-id"));
    assert.ok(issueCodes.includes("invalid-edge-reference"));
    assert.ok(issueCodes.includes("disconnected-graph"));
    assert.ok(issueCodes.includes("unsafe-node-settings"));
  });

  it("warns when workflow nodes can run local shell commands", () => {
    const node = createCatalogWorkflowNode({
      type: "run-tests",
      workflowId: "workflow-shell-warning",
      index: 0,
    });

    assert.match(workflowNodeWarnings(node)[0] ?? "", /shell commands/);
  });
});
