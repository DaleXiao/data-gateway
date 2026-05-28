-- SPEC-267 §3.2 — Important Topics snapshot table (full-table replace per ingest)
CREATE TABLE IF NOT EXISTS important_topics (
  id          TEXT    PRIMARY KEY,        -- lancedb memory id
  text        TEXT    NOT NULL,
  importance  REAL    NOT NULL,
  category    TEXT,                       -- preference/fact/decision/entity/reflection/other
  scope       TEXT,
  ts          INTEGER NOT NULL,           -- original memory timestamp (ms)
  snapshot_at INTEGER NOT NULL            -- ingest time (ms), used for staleness check
);

CREATE INDEX IF NOT EXISTS idx_important_topics_imp ON important_topics(importance DESC);
CREATE INDEX IF NOT EXISTS idx_important_topics_snapshot ON important_topics(snapshot_at);
