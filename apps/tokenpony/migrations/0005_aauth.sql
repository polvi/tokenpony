-- TPX-A (AAuth-Budget) resource + access server. See SPEC.md and the seam
-- contract at ~/Code/ologico/india/mgmt/contracts/aauth-seams.md.

-- Provider Ed25519 signing key, KEK-wrapped (private half unusable from a D1 export alone).
CREATE TABLE aauth_keys (
  kid TEXT PRIMARY KEY,            -- RFC 7638 thumbprint
  public_jwk TEXT NOT NULL,
  private_wrapped TEXT NOT NULL,   -- base64url(iv || AES-256-GCM(KEK, pkcs8))
  kek_id TEXT NOT NULL,            -- 'dev' or sha256-prefix of AAUTH_KEK
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);

-- Mission-keyed meter. One row per approved budgeted mission at this provider.
CREATE TABLE aauth_missions (
  id TEXT PRIMARY KEY,
  approver TEXT NOT NULL, s256 TEXT NOT NULL,     -- mission reference
  budget_json TEXT NOT NULL,                      -- bound budget value (first token wins)
  resource TEXT NOT NULL,                         -- budget.resource == our resource origin
  currency TEXT NOT NULL,                         -- 'USD'
  models TEXT,                                    -- JSON array or NULL
  budget_total INTEGER NOT NULL,                  -- credits (amount * 1_000_000)
  budget_used INTEGER NOT NULL DEFAULT 0,         -- committed debits
  reserved INTEGER NOT NULL DEFAULT 0,            -- outstanding reservations
  agent_iss TEXT NOT NULL, agent_sub TEXT NOT NULL,
  user_id TEXT,                                   -- funding account; NULL until claimed
  status TEXT NOT NULL DEFAULT 'active',          -- active|revoked|completed
  created_at INTEGER NOT NULL,
  UNIQUE(approver, s256)
);
CREATE INDEX idx_aauth_missions_user ON aauth_missions(user_id);

-- Issued auth tokens, hashed, linked to a mission for revocation + reservation attribution.
CREATE TABLE aauth_tokens (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES aauth_missions(id),
  jti TEXT NOT NULL UNIQUE,
  cnf_jkt TEXT NOT NULL,                          -- agent key thumbprint bound in cnf
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX idx_aauth_tokens_mission ON aauth_tokens(mission_id);

-- RFC 9421 replay guard (seam contract section 1): sha256(signature bytes) within the created window.
CREATE TABLE aauth_replay (
  sig_hash TEXT PRIMARY KEY,     -- sha256 hex of the signature bytes
  expires_at INTEGER NOT NULL    -- created + 300s; swept by the hourly cron
);

-- Single-use jti guard for PS budget attestations (relay replay protection).
CREATE TABLE aauth_attestations (
  jti TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
