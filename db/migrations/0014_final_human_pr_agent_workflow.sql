PRAGMA foreign_keys = ON;

-- Upgrade only persisted copies of the legacy Feature Development Loop.
-- Custom workflows are ignored unless they have the exact old post-AO shape:
-- AO -> Run Tests -> AI Review -> Open PR -> Merge, with AI/test edit loops.

CREATE TEMP TABLE _legacy_feature_workflows (
  workflow_id TEXT PRIMARY KEY NOT NULL
);

INSERT INTO _legacy_feature_workflows (workflow_id)
SELECT workflows.id
FROM workflows
WHERE workflows.name = 'Feature Development Loop'
  AND (SELECT COUNT(*) FROM workflow_nodes WHERE workflow_id = workflows.id) = 12
  AND EXISTS (
    SELECT 1 FROM workflow_nodes
    WHERE workflow_id = workflows.id AND type = 'agent-orchestrator-implement'
  )
  AND EXISTS (
    SELECT 1 FROM workflow_nodes
    WHERE workflow_id = workflows.id AND type = 'run-tests'
  )
  AND EXISTS (
    SELECT 1 FROM workflow_nodes
    WHERE workflow_id = workflows.id AND type = 'ai-review'
  )
  AND EXISTS (
    SELECT 1 FROM workflow_nodes
    WHERE workflow_id = workflows.id AND type = 'manual-claude-code-edit'
  )
  AND EXISTS (
    SELECT 1 FROM workflow_nodes
    WHERE workflow_id = workflows.id AND type = 'open-pr'
  )
  AND EXISTS (
    SELECT 1 FROM workflow_nodes
    WHERE workflow_id = workflows.id AND type = 'merge'
  )
  AND NOT EXISTS (
    SELECT 1 FROM workflow_nodes
    WHERE workflow_id = workflows.id AND type = 'pr-review-agent'
  )
  AND EXISTS (
    SELECT 1
    FROM workflow_edges edge
    JOIN workflow_nodes source ON source.id = edge.source_node_id
    JOIN workflow_nodes target ON target.id = edge.target_node_id
    WHERE edge.workflow_id = workflows.id
      AND source.type = 'agent-orchestrator-implement'
      AND target.type = 'run-tests'
  )
  AND EXISTS (
    SELECT 1
    FROM workflow_edges edge
    JOIN workflow_nodes source ON source.id = edge.source_node_id
    JOIN workflow_nodes target ON target.id = edge.target_node_id
    WHERE edge.workflow_id = workflows.id
      AND source.type = 'run-tests'
      AND target.type = 'ai-review'
  )
  AND EXISTS (
    SELECT 1
    FROM workflow_edges edge
    JOIN workflow_nodes source ON source.id = edge.source_node_id
    JOIN workflow_nodes target ON target.id = edge.target_node_id
    WHERE edge.workflow_id = workflows.id
      AND source.type = 'ai-review'
      AND target.type = 'open-pr'
  );

UPDATE workflow_nodes
SET position = '{"x":1820,"y":120}',
    input_artifacts = '[
      {"name":"implementation-branch","path":"git://{repository}/{branch}","required":false},
      {"name":"test-report","path":"loopboard://runs/{run}/test-report","required":false},
      {"name":"review-comments","path":"loopboard://runs/{run}/review-comments","required":false}
    ]',
    output_artifacts = '[
      {"name":"manual-patch","path":"git://{repository}/{branch}","required":true}
    ]',
    updated_at = CURRENT_TIMESTAMP
WHERE type = 'manual-claude-code-edit'
  AND workflow_id IN (SELECT workflow_id FROM _legacy_feature_workflows);

UPDATE workflow_nodes
SET position = '{"x":2080,"y":120}',
    mode = 'auto',
    input_artifacts = '[
      {"name":"manual-patch","path":"git://{repository}/{branch}","required":false},
      {"name":"implementation-branch","path":"git://{repository}/{branch}","required":false}
    ]',
    require_approval = 'true',
    risk_policy = 'low',
    updated_at = CURRENT_TIMESTAMP
WHERE type = 'run-tests'
  AND workflow_id IN (SELECT workflow_id FROM _legacy_feature_workflows);

UPDATE workflow_nodes
SET position = '{"x":2340,"y":120}',
    input_artifacts = '[
      {"name":"manual-patch","path":"git://{repository}/{branch}","required":false},
      {"name":"implementation-branch","path":"git://{repository}/{branch}","required":false}
    ]',
    updated_at = CURRENT_TIMESTAMP
WHERE type = 'open-pr'
  AND workflow_id IN (SELECT workflow_id FROM _legacy_feature_workflows);

UPDATE workflow_nodes
SET position = '{"x":2860,"y":120}',
    updated_at = CURRENT_TIMESTAMP
WHERE type = 'merge'
  AND workflow_id IN (SELECT workflow_id FROM _legacy_feature_workflows);

INSERT INTO workflow_nodes (
  id, workflow_id, type, name, mode, position, input_artifacts,
  output_artifacts, require_approval, max_retries, risk_policy, config,
  current_state, created_at, updated_at
)
SELECT
  'node-pr-review-agent-' || lower(hex(randomblob(12))),
  legacy.workflow_id,
  'pr-review-agent',
  'PR Agent',
  'auto',
  '{"x":2600,"y":120}',
  '[{"name":"pull-request","path":"https://github.com/{repository}/pulls","required":true}]',
  '[{"name":"review-comments","path":"loopboard://runs/{run}/review-comments","required":true}]',
  'false',
  '1',
  'medium',
  '{}',
  'idle',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM _legacy_feature_workflows legacy;

DELETE FROM workflow_edges
WHERE workflow_id IN (SELECT workflow_id FROM _legacy_feature_workflows)
  AND (
    source_node_id IN (
      SELECT id FROM workflow_nodes
      WHERE workflow_id = workflow_edges.workflow_id
        AND type IN (
          'agent-orchestrator-implement',
          'run-tests',
          'ai-review',
          'manual-claude-code-edit',
          'open-pr',
          'pr-review-agent'
        )
    )
    OR target_node_id IN (
      SELECT id FROM workflow_nodes
      WHERE workflow_id = workflow_edges.workflow_id
        AND type IN (
          'run-tests',
          'ai-review',
          'manual-claude-code-edit',
          'open-pr',
          'pr-review-agent',
          'merge'
        )
    )
  );

INSERT INTO workflow_edges (
  id, workflow_id, source_node_id, target_node_id, label, dashed,
  source_handle, target_handle, condition, created_at, updated_at
)
SELECT
  'edge-final-flow-' || lower(hex(randomblob(12))),
  legacy.workflow_id,
  source.id,
  target.id,
  edge.label,
  edge.dashed,
  edge.source_handle,
  edge.target_handle,
  '{}',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM _legacy_feature_workflows legacy
JOIN (
  SELECT
    'agent-orchestrator-implement' AS source_type,
    'manual-claude-code-edit' AS target_type,
    'next' AS label,
    0 AS dashed,
    'right' AS source_handle,
    'left' AS target_handle
  UNION ALL SELECT
    'manual-claude-code-edit', 'run-tests', 'next', 0, 'right', 'left'
  UNION ALL SELECT
    'run-tests', 'open-pr', 'passed', 0, 'right', 'left'
  UNION ALL SELECT
    'run-tests', 'manual-claude-code-edit', 'failed', 1, 'bottom', 'bottom'
  UNION ALL SELECT
    'open-pr', 'pr-review-agent', 'next', 0, 'right', 'left'
  UNION ALL SELECT
    'pr-review-agent', 'merge', 'approved', 0, 'right', 'left'
  UNION ALL SELECT
    'pr-review-agent', 'manual-claude-code-edit', 'needs changes', 1, 'bottom', 'bottom'
) edge
JOIN workflow_nodes source
  ON source.workflow_id = legacy.workflow_id
 AND source.type = edge.source_type
JOIN workflow_nodes target
  ON target.workflow_id = legacy.workflow_id
 AND target.type = edge.target_type;

DELETE FROM workflow_nodes
WHERE type = 'ai-review'
  AND workflow_id IN (SELECT workflow_id FROM _legacy_feature_workflows);

UPDATE workflows
SET description =
      'Feature workflow from Spec Kit through AO task review loops, integrated human editing, tests, final PR-Agent review, and human-approved squash merge.',
    version = '2',
    updated_at = CURRENT_TIMESTAMP
WHERE id IN (SELECT workflow_id FROM _legacy_feature_workflows);

DROP TABLE _legacy_feature_workflows;
