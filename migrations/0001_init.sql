-- Migration 0001: Initial schema for openclaw-memcare D1
-- Run via: wrangler d1 execute openclaw-memcare --file=migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS health_daily (
  date         TEXT    PRIMARY KEY,   -- YYYY-MM-DD
  payload_json TEXT    NOT NULL,
  updated_at   INTEGER NOT NULL       -- Unix ms
);

CREATE INDEX IF NOT EXISTS idx_health_daily_date ON health_daily(date);
