-- pvlab-assistant memory system schema
-- Run with: wrangler d1 execute pvlab-db --file=./schema.sql

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',   -- 'free' | 'pro'
  plan_expires_at INTEGER              -- ms epoch; NULL = no expiry
);

-- Daily message counters for usage limits. key = 'u:<userId>' | 'ip:<ip>' | 'imp:<userId>'
CREATE TABLE IF NOT EXISTS usage_counts (
  key TEXT NOT NULL,
  day TEXT NOT NULL,                   -- UTC day, YYYY-MM-DD
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS user_memory (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  category TEXT NOT NULL,       -- 'subject' | 'style' | 'goal' | 'general' | 'imported'
  fact_text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'chat',  -- 'chat' | 'import'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Chat history, now per-user instead of localStorage-only
CREATE TABLE IF NOT EXISTS chat_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,           -- 'user' | 'assistant'
  content TEXT NOT NULL,
  module TEXT,                  -- which tab: pv | machines | power_electronics | matlab | autocad | thesis
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_memory_user ON user_memory(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_history_user ON chat_history(user_id, created_at);
