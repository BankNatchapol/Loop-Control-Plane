PRAGMA foreign_keys = ON;

ALTER TABLE projects ADD COLUMN github_repository TEXT NOT NULL DEFAULT '';
