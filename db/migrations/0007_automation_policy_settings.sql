PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO app_settings (key, value, updated_at)
VALUES (
  'automation',
  '{"globalAutoRunEnabled":false}',
  '2026-06-14T00:00:00.000Z'
);

ALTER TABLE projects ADD COLUMN automation_policy TEXT NOT NULL DEFAULT '{"allowLowRiskAutoIssueCreation":true,"allowLowRiskAutoAoReadyLabeling":true,"mediumRiskRequiresReview":true,"highRiskManualOnly":true}' CHECK (json_valid(automation_policy));
