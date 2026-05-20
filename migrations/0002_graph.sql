-- Migration 0002: graph snapshot store for openclaw-graph D1
-- Run via: wrangler d1 execute openclaw-graph --file=migrations/0002_graph.sql --remote

CREATE TABLE IF NOT EXISTS graph_snapshots (
  snapshot_id  TEXT    PRIMARY KEY,   -- "latest" or version hash
  payload_json TEXT    NOT NULL,
  node_count   INTEGER NOT NULL,
  edge_count   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL       -- Unix ms
);

CREATE INDEX IF NOT EXISTS idx_graph_snapshots_updated_at ON graph_snapshots(updated_at);
