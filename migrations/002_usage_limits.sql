-- Migration 002: daily usage limits + paid plans
-- Run ONCE in the Cloudflare D1 console of an EXISTING database (pvlab-db).
-- (Fresh installs get all of this from schema.sql instead — don't run both.)
-- Running the two ALTER statements a second time errors with "duplicate column name" — harmless, just skip them.

ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN plan_expires_at INTEGER;

CREATE TABLE IF NOT EXISTS usage_counts (
  key TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);
