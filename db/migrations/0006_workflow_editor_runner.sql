PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  version TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS workflows_project_id_idx ON workflows(project_id);
CREATE INDEX IF NOT EXISTS workflows_project_updated_at_idx ON workflows(project_id, updated_at);

CREATE TABLE IF NOT EXISTS workflow_nodes (
  id TEXT PRIMARY KEY NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'human', 'semi', 'disabled')),
  position TEXT NOT NULL DEFAULT '{"x":0,"y":0}' CHECK (json_valid(position)),
  input_artifacts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(input_artifacts)),
  output_artifacts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(output_artifacts)),
  require_approval TEXT NOT NULL CHECK (require_approval IN ('true', 'false')),
  max_retries TEXT NOT NULL,
  risk_policy TEXT NOT NULL CHECK (risk_policy IN ('low', 'medium', 'high', 'critical', 'manual-only')),
  config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
  current_state TEXT NOT NULL CHECK (current_state IN ('idle', 'ready', 'running', 'paused', 'completed', 'failed', 'skipped')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS workflow_nodes_workflow_id_idx ON workflow_nodes(workflow_id);
CREATE INDEX IF NOT EXISTS workflow_nodes_workflow_mode_idx ON workflow_nodes(workflow_id, mode);
CREATE INDEX IF NOT EXISTS workflow_nodes_workflow_state_idx ON workflow_nodes(workflow_id, current_state);

CREATE TABLE IF NOT EXISTS workflow_edges (
  id TEXT PRIMARY KEY NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  label TEXT NOT NULL,
  condition TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(condition)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_node_id) REFERENCES workflow_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (target_node_id) REFERENCES workflow_nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS workflow_edges_workflow_id_idx ON workflow_edges(workflow_id);
CREATE INDEX IF NOT EXISTS workflow_edges_source_node_idx ON workflow_edges(workflow_id, source_node_id);
CREATE INDEX IF NOT EXISTS workflow_edges_target_node_idx ON workflow_edges(workflow_id, target_node_id);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  feature_id TEXT REFERENCES features(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  current_node_id TEXT REFERENCES workflow_nodes(id) ON DELETE SET NULL,
  input_artifacts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(input_artifacts)),
  output_artifacts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(output_artifacts)),
  execution_logs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(execution_logs)),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS workflow_runs_workflow_id_idx ON workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS workflow_runs_project_id_idx ON workflow_runs(project_id);
CREATE INDEX IF NOT EXISTS workflow_runs_feature_id_idx ON workflow_runs(feature_id);
CREATE INDEX IF NOT EXISTS workflow_runs_project_status_idx ON workflow_runs(project_id, status);

CREATE TABLE IF NOT EXISTS workflow_run_steps (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workflow_node_id TEXT NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting-approval', 'completed', 'failed', 'skipped')),
  attempt TEXT NOT NULL,
  input_artifacts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(input_artifacts)),
  output_artifacts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(output_artifacts)),
  execution_logs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(execution_logs)),
  error TEXT,
  require_approval TEXT NOT NULL CHECK (require_approval IN ('true', 'false')),
  approved_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS workflow_run_steps_run_id_idx ON workflow_run_steps(run_id);
CREATE INDEX IF NOT EXISTS workflow_run_steps_node_id_idx ON workflow_run_steps(workflow_node_id);
CREATE INDEX IF NOT EXISTS workflow_run_steps_run_status_idx ON workflow_run_steps(run_id, status);
