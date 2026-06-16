PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  repository TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  spec_kit_root TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  source TEXT NOT NULL,
  spec_path TEXT NOT NULL,
  plan_path TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS features_project_id_idx ON features(project_id);
CREATE INDEX IF NOT EXISTS features_status_idx ON features(status);
CREATE INDEX IF NOT EXISTS features_project_status_idx ON features(project_id, status);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT NOT NULL,
  mode TEXT NOT NULL,
  risk TEXT NOT NULL,
  source TEXT NOT NULL,
  labels TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels)),
  acceptance_criteria TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(acceptance_criteria)),
  dependencies TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dependencies)),
  branch TEXT NOT NULL,
  worktree TEXT NOT NULL,
  github TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(github)),
  handoff TEXT NOT NULL DEFAULT '{"available":false,"contextPaths":[]}' CHECK (json_valid(handoff)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_project_id_idx ON tasks(project_id);
CREATE INDEX IF NOT EXISTS tasks_feature_id_idx ON tasks(feature_id);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_owner_idx ON tasks(owner);
CREATE INDEX IF NOT EXISTS tasks_project_status_idx ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS tasks_feature_status_idx ON tasks(feature_id, status);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  message TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  from_owner TEXT,
  to_owner TEXT,
  payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS task_events_task_id_idx ON task_events(task_id);
CREATE INDEX IF NOT EXISTS task_events_created_at_idx ON task_events(created_at);
CREATE INDEX IF NOT EXISTS task_events_task_created_at_idx ON task_events(task_id, created_at);
CREATE INDEX IF NOT EXISTS task_events_type_idx ON task_events(type);
