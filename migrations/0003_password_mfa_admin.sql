-- 0003: email/password sign-in, TOTP two-factor auth, invitation links,
-- admin-issued password resets, bans and runtime system settings.

-- Password + 2FA + ban state on members.
ALTER TABLE users ADD COLUMN password_hash TEXT;            -- "pbkdf2_sha256$<iter>$<hash>" with salt below
ALTER TABLE users ADD COLUMN password_salt TEXT;
ALTER TABLE users ADD COLUMN password_updated_at INTEGER;
ALTER TABLE users ADD COLUMN totp_secret_enc TEXT;          -- AES-GCM(base32 secret), set once 2FA is confirmed
ALTER TABLE users ADD COLUMN totp_pending_enc TEXT;         -- secret during enrollment, before confirmation
ALTER TABLE users ADD COLUMN totp_enabled_at INTEGER;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;        -- last accepted 30 s step (replay protection)
ALTER TABLE users ADD COLUMN banned_reason TEXT;
ALTER TABLE users ADD COLUMN banned_until INTEGER;          -- NULL = until lifted
ALTER TABLE users ADD COLUMN banned_by TEXT REFERENCES users (id) ON DELETE SET NULL;

-- Sessions: when the user last proved who they are (step-up for sensitive
-- actions), whether 2FA enrollment is still required, and a device hint.
ALTER TABLE sessions ADD COLUMN reauth_at INTEGER;
ALTER TABLE sessions ADD COLUMN needs_mfa_setup INTEGER NOT NULL DEFAULT 0 CHECK (needs_mfa_setup IN (0, 1));
ALTER TABLE sessions ADD COLUMN auth_method TEXT;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;

-- Google sign-in started from an invitation link.
ALTER TABLE oauth_states ADD COLUMN invitation_id TEXT;

-- Second step of sign-in when the member has 2FA. Short lived, hashed token in a cookie.
CREATE TABLE mfa_challenges (
  id          TEXT PRIMARY KEY NOT NULL,
  token_hash  TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  auth_method TEXT NOT NULL,
  return_to   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX mfa_challenges_token_uq ON mfa_challenges (token_hash);
CREATE INDEX mfa_challenges_expires_idx ON mfa_challenges (expires_at);

-- One-time recovery codes (SHA-256 of the code).
CREATE TABLE recovery_codes (
  id         TEXT PRIMARY KEY NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE UNIQUE INDEX recovery_codes_hash_uq ON recovery_codes (user_id, code_hash);

-- Admin-issued, single-use password reset links.
CREATE TABLE password_resets (
  id         TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE UNIQUE INDEX password_resets_token_uq ON password_resets (token_hash);

-- Invitation links. token_enc lets the admin copy the link again.
CREATE TABLE invitations (
  id          TEXT PRIMARY KEY NOT NULL,
  token_hash  TEXT NOT NULL,
  token_enc   TEXT NOT NULL,
  email       TEXT,                                          -- NULL = anyone with the link
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  quota_bytes INTEGER CHECK (quota_bytes IS NULL OR quota_bytes >= 0),
  max_uses    INTEGER NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 1000),
  use_count   INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  created_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE UNIQUE INDEX invitations_token_uq ON invitations (token_hash);

CREATE TABLE invitation_uses (
  invitation_id TEXT NOT NULL REFERENCES invitations (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  used_at       INTEGER NOT NULL,
  PRIMARY KEY (invitation_id, user_id)
);

-- Generic attempt budgets (password login per account / per client, 2FA codes).
-- Keys are hashes; raw emails/IPs are not stored.
CREATE TABLE auth_attempts (
  scope           TEXT NOT NULL,
  key             TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE INDEX auth_attempts_updated_idx ON auth_attempts (updated_at);

-- Runtime settings editable in the Admin Console (JSON values).
CREATE TABLE system_settings (
  key        TEXT PRIMARY KEY NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users (id) ON DELETE SET NULL
);
