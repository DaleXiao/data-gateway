-- Migration 0003: important_topics snapshot table (SPEC-267)
-- Run via: wrangler d1 execute openclaw-memcare --file=migrations/0003_important_topics.sql --remote

CREATE TABLE IF NOT EXISTS important_topics (
  id          TEXT    PRIMARY KEY,        -- lancedb memory id
  text        TEXT    NOT NULL,
  importance  REAL    NOT NULL,
  category    TEXT,                       -- preference/fact/decision/entity/reflection/other
  scope       TEXT,
  ts          INTEGER NOT NULL,           -- 原 memory timestamp ms
  snapshot_at INTEGER NOT NULL            -- ingest 时间 ms,用于检测过期
);

CREATE INDEX IF NOT EXISTS idx_important_topics_imp ON important_topics(importance DESC);
CREATE INDEX IF NOT EXISTS idx_important_topics_snapshot ON important_topics(snapshot_at);
