UPDATE workflow_edges
SET dashed = 1
WHERE id IN (
  'edge-node-spec-kit-clarify-to-node-spec-kit-actions',
  'edge-node-ai-review-to-node-manual-claude-code-edit',
  'edge-node-manual-claude-code-edit-to-node-run-tests'
);
