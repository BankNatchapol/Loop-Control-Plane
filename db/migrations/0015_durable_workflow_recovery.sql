CREATE TABLE workflow_runs_recovery (
  id TEXT PRIMARY KEY NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  feature_id TEXT REFERENCES features(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'paused', 'interrupted', 'completed', 'failed', 'cancelled')
  ),
  current_node_id TEXT,
  workflow_version TEXT NOT NULL DEFAULT '1',
  workflow_snapshot TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(workflow_snapshot)),
  interruption TEXT CHECK (interruption IS NULL OR json_valid(interruption)),
  input_artifacts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(input_artifacts)),
  output_artifacts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(output_artifacts)),
  execution_logs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(execution_logs)),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO workflow_runs_recovery (
  id, workflow_id, project_id, feature_id, status, current_node_id,
  workflow_version, workflow_snapshot, interruption, input_artifacts,
  output_artifacts, execution_logs, started_at, completed_at, created_at, updated_at
)
SELECT
  id, workflow_id, project_id, feature_id, status, current_node_id,
  '1', '{}', NULL, input_artifacts, output_artifacts, execution_logs,
  started_at, completed_at, created_at, updated_at
FROM workflow_runs;

CREATE TABLE workflow_run_steps_recovery (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES workflow_runs_recovery(id) ON DELETE CASCADE,
  workflow_node_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'interrupted', 'waiting-approval', 'completed', 'failed', 'skipped')
  ),
  attempt TEXT NOT NULL,
  checkpoint TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(checkpoint)),
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

INSERT INTO workflow_run_steps_recovery (
  id, run_id, workflow_node_id, status, attempt, checkpoint,
  input_artifacts, output_artifacts, execution_logs, error, require_approval,
  approved_at, started_at, completed_at, created_at, updated_at
)
SELECT
  id, run_id, workflow_node_id, status, attempt, '{}',
  input_artifacts, output_artifacts, execution_logs, error, require_approval,
  approved_at, started_at, completed_at, created_at, updated_at
FROM workflow_run_steps;

CREATE TABLE engine_jobs_recovery (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('demo-ping', 'task-run', 'workflow-step')),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'interrupted', 'completed', 'failed', 'cancelled')
  ),
  backend TEXT NOT NULL CHECK (
    backend IN ('stub', 'cursor', 'claude-code', 'codex', 'agent-orchestrator')
  ),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  workflow_run_id TEXT REFERENCES workflow_runs_recovery(id) ON DELETE SET NULL,
  workflow_node_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  execution_logs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(execution_logs)),
  error TEXT,
  attempt TEXT NOT NULL,
  max_attempts TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO engine_jobs_recovery
SELECT * FROM engine_jobs;

DROP TABLE engine_jobs;
DROP TABLE workflow_run_steps;
DROP TABLE workflow_runs;

ALTER TABLE workflow_runs_recovery RENAME TO workflow_runs;
ALTER TABLE workflow_run_steps_recovery RENAME TO workflow_run_steps;
ALTER TABLE engine_jobs_recovery RENAME TO engine_jobs;

CREATE INDEX workflow_runs_workflow_id_idx ON workflow_runs(workflow_id);
CREATE INDEX workflow_runs_project_id_idx ON workflow_runs(project_id);
CREATE INDEX workflow_runs_feature_id_idx ON workflow_runs(feature_id);
CREATE INDEX workflow_runs_project_status_idx ON workflow_runs(project_id, status);
CREATE INDEX workflow_runs_feature_status_idx ON workflow_runs(feature_id, status);

CREATE INDEX workflow_run_steps_run_id_idx ON workflow_run_steps(run_id);
CREATE INDEX workflow_run_steps_node_id_idx ON workflow_run_steps(workflow_node_id);
CREATE INDEX workflow_run_steps_run_status_idx ON workflow_run_steps(run_id, status);

CREATE INDEX engine_jobs_status_idx ON engine_jobs(status);
CREATE INDEX engine_jobs_status_queued_at_idx ON engine_jobs(status, queued_at);
CREATE INDEX engine_jobs_project_id_idx ON engine_jobs(project_id);
CREATE INDEX engine_jobs_project_status_idx ON engine_jobs(project_id, status);
