PRAGMA foreign_keys = ON;

ALTER TABLE projects ADD COLUMN repo_path TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN is_git_repository TEXT NOT NULL DEFAULT 'false';
ALTER TABLE projects ADD COLUMN current_branch TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN github_remote_url TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN specs_path TEXT NOT NULL DEFAULT 'specs';
ALTER TABLE projects ADD COLUMN tasks_path TEXT NOT NULL DEFAULT 'tasks';
ALTER TABLE projects ADD COLUMN workflows_path TEXT NOT NULL DEFAULT 'workflows';
ALTER TABLE projects ADD COLUMN handoffs_path TEXT NOT NULL DEFAULT 'handoffs';
