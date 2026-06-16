PRAGMA foreign_keys = ON;

ALTER TABLE features ADD COLUMN artifact_folder_path TEXT NOT NULL DEFAULT '';
ALTER TABLE features ADD COLUMN prd_path TEXT NOT NULL DEFAULT '';
ALTER TABLE features ADD COLUMN tasks_path TEXT NOT NULL DEFAULT '';
ALTER TABLE features ADD COLUMN decisions_path TEXT NOT NULL DEFAULT '';
ALTER TABLE features ADD COLUMN artifacts TEXT NOT NULL DEFAULT '{"prd":{"name":"prd","fileName":"PRD.md","path":"","exists":false,"approved":false},"spec":{"name":"spec","fileName":"spec.md","path":"","exists":false,"approved":false},"plan":{"name":"plan","fileName":"plan.md","path":"","exists":false,"approved":false},"tasks":{"name":"tasks","fileName":"tasks.md","path":"","exists":false,"approved":false},"decisions":{"name":"decisions","fileName":"decisions.md","path":"","exists":false,"approved":false}}' CHECK (json_valid(artifacts));

UPDATE features
SET
  artifact_folder_path = CASE
    WHEN spec_path != '' THEN substr(spec_path, 1, length(spec_path) - length('/spec.md'))
    WHEN plan_path != '' THEN substr(plan_path, 1, length(plan_path) - length('/plan.md'))
    ELSE ''
  END,
  prd_path = CASE
    WHEN spec_path != '' THEN substr(spec_path, 1, length(spec_path) - length('/spec.md')) || '/PRD.md'
    ELSE ''
  END,
  tasks_path = CASE
    WHEN spec_path != '' THEN substr(spec_path, 1, length(spec_path) - length('/spec.md')) || '/tasks.md'
    ELSE ''
  END,
  decisions_path = CASE
    WHEN spec_path != '' THEN substr(spec_path, 1, length(spec_path) - length('/spec.md')) || '/decisions.md'
    ELSE ''
  END,
  status = CASE status
    WHEN 'draft' THEN 'prd-draft'
    WHEN 'approved' THEN 'spec-approved'
    WHEN 'in-progress' THEN 'in-execution'
    WHEN 'shipped' THEN 'done'
    ELSE status
  END;

UPDATE features
SET artifacts = json_object(
  'prd', json_object('name', 'prd', 'fileName', 'PRD.md', 'path', prd_path, 'exists', json('false'), 'approved', json('false')),
  'spec', json_object('name', 'spec', 'fileName', 'spec.md', 'path', spec_path, 'exists', json('false'), 'approved', status IN ('spec-approved', 'plan-review', 'plan-approved', 'tasks-ready', 'in-execution', 'done')),
  'plan', json_object('name', 'plan', 'fileName', 'plan.md', 'path', plan_path, 'exists', json('false'), 'approved', status IN ('plan-approved', 'tasks-ready', 'in-execution', 'done')),
  'tasks', json_object('name', 'tasks', 'fileName', 'tasks.md', 'path', tasks_path, 'exists', json('false'), 'approved', status IN ('tasks-ready', 'in-execution', 'done')),
  'decisions', json_object('name', 'decisions', 'fileName', 'decisions.md', 'path', decisions_path, 'exists', json('false'), 'approved', json('false'))
);
