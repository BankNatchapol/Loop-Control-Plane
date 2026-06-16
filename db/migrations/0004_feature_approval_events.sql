PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS feature_events (
  id TEXT PRIMARY KEY NOT NULL,
  feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  message TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS feature_events_feature_id_idx ON feature_events(feature_id);
CREATE INDEX IF NOT EXISTS feature_events_created_at_idx ON feature_events(created_at);
CREATE INDEX IF NOT EXISTS feature_events_feature_created_at_idx ON feature_events(feature_id, created_at);
CREATE INDEX IF NOT EXISTS feature_events_type_idx ON feature_events(type);
