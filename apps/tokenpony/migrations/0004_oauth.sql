-- TPX v0.2: plain OAuth 2.1. Grants are represented by rotating refresh
-- tokens plus short-lived access tokens; PAR requests are stored briefly.
ALTER TABLE apps ADD COLUMN token_endpoint_auth_method TEXT NOT NULL DEFAULT 'client_secret_basic';

CREATE TABLE par_requests (
  request_uri TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  params TEXT NOT NULL, -- JSON of validated authorization request parameters
  expires_at TEXT NOT NULL
);

ALTER TABLE auth_codes ADD COLUMN code_challenge TEXT;
ALTER TABLE auth_codes ADD COLUMN models TEXT; -- JSON array or NULL
ALTER TABLE auth_codes ADD COLUMN grant_id TEXT; -- set once exchanged, for reuse revocation

ALTER TABLE grants ADD COLUMN models TEXT; -- JSON array or NULL

CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants(id),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active', -- active | rotated | revoked
  dpop_jkt TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants(id),
  token_hash TEXT NOT NULL UNIQUE,
  dpop_jkt TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_refresh_grant ON refresh_tokens(grant_id);
CREATE INDEX idx_access_grant ON access_tokens(grant_id);
