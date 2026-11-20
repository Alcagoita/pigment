-- Numbers only. No prompt text, no answers, no code, no IP addresses.
CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  session TEXT NOT NULL,
  person TEXT NOT NULL,
  ticket TEXT NOT NULL,
  usd REAL NOT NULL,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  active_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS prompts_ticket ON prompts (ticket);

CREATE TABLE IF NOT EXISTS sessions (
  session TEXT PRIMARY KEY,
  person TEXT NOT NULL,
  ticket TEXT NOT NULL,
  usd REAL NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_last_at ON sessions (last_at);
