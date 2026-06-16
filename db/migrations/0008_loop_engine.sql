PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS engine_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('demo-ping', 'task-run', 'workflow-step')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  backend TEXT NOT NULL CHECK (backend IN ('stub', 'cursor', 'claude-code', 'codex', 'agent-orchestrator')),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
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

CREATE INDEX IF NOT EXISTS engine_jobs_status_idx ON engine_jobs(status);
CREATE INDEX IF NOT EXISTS engine_jobs_status_queued_at_idx ON engine_jobs(status, queued_at);
CREATE INDEX IF NOT EXISTS engine_jobs_project_id_idx ON engine_jobs(project_id);
CREATE INDEX IF NOT EXISTS engine_jobs_project_status_idx ON engine_jobs(project_id, status);

CREATE TABLE IF NOT EXISTS engine_scheduler_state (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'default'),
  status TEXT NOT NULL CHECK (status IN ('stopped', 'running', 'paused')),
  last_tick_at TEXT,
  tick_count TEXT NOT NULL,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO engine_scheduler_state (
  id, status, last_tick_at, tick_count, last_error, updated_at
)
VALUES (
  'default',
  'stopped',
  NULL,
  '0',
  NULL,
  '2026-06-16T00:00:00.000Z'
);
