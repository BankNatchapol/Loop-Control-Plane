import { randomUUID } from "node:crypto";

import type { CreateWorkflowInput } from "@/lib/db/loopboard-repository";
import { seedWorkflows } from "@/lib/loopboard";

export const createDefaultFeatureWorkflowInput = (
  projectId: string,
): CreateWorkflowInput => {
  const template = seedWorkflows[0];
  if (!template) {
    throw new Error("The default feature workflow template is unavailable.");
  }

  const workflowId = `workflow-${randomUUID()}`;
  const nodeIds = new Map(
    template.nodes.map((node) => [node.id, `workflow-node-${randomUUID()}`]),
  );

  const config = { ...template.config };
  delete config.defaultFeatureId;

  return {
    id: workflowId,
    projectId,
    name: template.name,
    description: template.description,
    version: template.version,
    nodes: template.nodes.map((node) => ({
        id: nodeIds.get(node.id) ?? `workflow-node-${randomUUID()}`,
        workflowId,
        type: node.type,
        name: node.name,
        mode: node.mode,
        position: node.position,
        inputArtifacts: node.inputArtifacts,
        outputArtifacts: node.outputArtifacts,
        requireApproval: node.requireApproval,
        maxRetries: node.maxRetries,
        riskPolicy: node.riskPolicy,
        config: node.config,
        currentState: node.currentState,
      })),
    edges: template.edges.map((edge) => ({
        id: `workflow-edge-${randomUUID()}`,
        workflowId,
        sourceNodeId: nodeIds.get(edge.sourceNodeId) ?? edge.sourceNodeId,
        targetNodeId: nodeIds.get(edge.targetNodeId) ?? edge.targetNodeId,
        label: edge.label,
        dashed: edge.dashed,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        condition: edge.condition,
      })),
    config,
  };
};
