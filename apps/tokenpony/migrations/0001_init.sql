-- users are keyed by AuthGravity user id; balance is in tokens
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  balance_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE apps (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL, -- JSON array
  owner_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE auth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES apps(client_id),
  user_id TEXT NOT NULL REFERENCES users(id),
  budget INTEGER NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES apps(client_id),
  user_id TEXT NOT NULL REFERENCES users(id),
  budget_total INTEGER NOT NULL,
  budget_used INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- active | revoked
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  grant_id TEXT REFERENCES grants(id),
  api_key_id TEXT REFERENCES api_keys(id),
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  stripe_session_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  tokens INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_api_keys_user ON api_keys(user_id);
CREATE INDEX idx_grants_user ON grants(user_id);
CREATE INDEX idx_usage_user ON usage_events(user_id, created_at);
