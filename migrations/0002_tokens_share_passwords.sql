-- 0002: personal access tokens (for the local MCP server / API clients) and
-- password-protected public share links.

-- Personal access tokens. Only SHA-256(token) is stored; the token is shown once.
-- scopes: space-separated subset of "files:read files:write".
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  token_hash   TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  -- fixed one-minute request window for per-token rate limiting
  window_start INTEGER,
  window_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX api_tokens_hash_uq ON api_tokens (token_hash);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id, revoked_at);

-- Optional password on public links. PBKDF2-SHA256(password, salt).
-- password_version bumps on every set/clear so earlier unlock cookies stop working.
ALTER TABLE share_links ADD COLUMN password_hash TEXT;
ALTER TABLE share_links ADD COLUMN password_salt TEXT;
ALTER TABLE share_links ADD COLUMN password_version INTEGER NOT NULL DEFAULT 0;

-- Wrong-password attempts per (link, client). client_key = SHA-256(link id + client IP),
-- so raw IPs are not stored and one client cannot lock everyone else out.
-- An attempt is reserved atomically BEFORE the password is checked, so parallel
-- requests cannot exceed the budget.
CREATE TABLE share_unlock_attempts (
  link_id         TEXT NOT NULL REFERENCES share_links (id) ON DELETE CASCADE,
  client_key      TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (link_id, client_key)
);
CREATE INDEX share_unlock_attempts_updated_idx ON share_unlock_attempts (updated_at);
