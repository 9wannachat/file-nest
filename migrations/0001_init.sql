-- FileNest initial schema.
-- Hand-written SQL; src/worker/db/schema.ts mirrors it for typed queries and
-- tests/worker/schema.test.ts checks the two stay in sync.
-- All timestamps are Unix epoch milliseconds (INTEGER).

-- Members. Allowlist == rows in this table. status=invited until first login.
CREATE TABLE users (
  id            TEXT PRIMARY KEY NOT NULL,
  email         TEXT NOT NULL,              -- lowercase, verified Google email
  google_sub    TEXT,                       -- bound on first successful login
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status        TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  quota_bytes   INTEGER NOT NULL CHECK (quota_bytes >= 0),
  invited_by    TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE UNIQUE INDEX users_email_uq ON users (email);
CREATE UNIQUE INDEX users_google_sub_uq ON users (google_sub) WHERE google_sub IS NOT NULL;

-- Server-side sessions. Only the SHA-256 of the cookie token is stored.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY NOT NULL,
  token_hash   TEXT NOT NULL,
  csrf_token   TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX sessions_token_hash_uq ON sessions (token_hash);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Pending OIDC logins (state, nonce, PKCE verifier). Single use, short lived.
CREATE TABLE oauth_states (
  state_hash    TEXT PRIMARY KEY NOT NULL,
  code_verifier TEXT NOT NULL,
  nonce         TEXT NOT NULL,
  return_to     TEXT NOT NULL,
  expires_at    INTEGER NOT NULL
);

-- R2 destinations (possibly in different Cloudflare accounts).
-- credential_ref names Worker Secrets R2_<REF>_ACCESS_KEY_ID / R2_<REF>_SECRET_ACCESS_KEY.
CREATE TABLE storage_targets (
  id                 TEXT PRIMARY KEY NOT NULL,
  name               TEXT NOT NULL,
  account_id         TEXT NOT NULL CHECK (length(account_id) = 32 AND account_id NOT GLOB '*[^0-9a-f]*'),
  bucket             TEXT NOT NULL CHECK (length(bucket) BETWEEN 3 AND 63 AND bucket NOT GLOB '*[^a-z0-9-]*'),
  credential_ref     TEXT NOT NULL CHECK (length(credential_ref) BETWEEN 1 AND 32 AND credential_ref NOT GLOB '*[^A-Z0-9_]*'),
  accepting_uploads  INTEGER NOT NULL DEFAULT 1 CHECK (accepting_uploads IN (0, 1)),
  last_check_at      INTEGER,
  last_check_ok      INTEGER CHECK (last_check_ok IN (0, 1)),
  last_check_message TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX storage_targets_name_uq ON storage_targets (name);
CREATE UNIQUE INDEX storage_targets_bucket_uq ON storage_targets (account_id, bucket);

-- Single-row settings. default_storage_id picks where NEW upload sessions go.
CREATE TABLE app_settings (
  id                 INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  default_storage_id TEXT REFERENCES storage_targets (id) ON DELETE RESTRICT,
  updated_at         INTEGER NOT NULL,
  updated_by         TEXT REFERENCES users (id) ON DELETE SET NULL
);
INSERT INTO app_settings (id, default_storage_id, updated_at) VALUES (1, NULL, 0);

-- Folders: adjacency list. Trashing a folder marks the whole subtree with the
-- same trash_root_id so restore/purge can act on exactly that set.
CREATE TABLE folders (
  id            TEXT PRIMARY KEY NOT NULL,
  owner_id      TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  parent_id     TEXT REFERENCES folders (id),               -- NO ACTION: checked at statement end, so a subtree can be deleted at once
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  trashed_at    INTEGER,
  trash_root_id TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX folders_active_name_uq ON folders (owner_id, coalesce(parent_id, ''), name) WHERE trashed_at IS NULL;
CREATE INDEX folders_parent_idx ON folders (owner_id, parent_id, trashed_at);
CREATE INDEX folders_trash_root_idx ON folders (trash_root_id) WHERE trash_root_id IS NOT NULL;

-- Files that finished upload. A row exists only after the final object is in R2.
CREATE TABLE files (
  id                TEXT PRIMARY KEY NOT NULL,
  owner_id          TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  folder_id         TEXT REFERENCES folders (id),
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  size              INTEGER NOT NULL CHECK (size >= 0),
  mime_declared     TEXT,
  content_type      TEXT NOT NULL,                      -- type served to browsers
  inline_ok         INTEGER NOT NULL DEFAULT 0 CHECK (inline_ok IN (0, 1)),
  storage_id        TEXT NOT NULL REFERENCES storage_targets (id) ON DELETE RESTRICT,
  object_key        TEXT NOT NULL,
  etag              TEXT NOT NULL,
  upload_session_id TEXT NOT NULL,
  trashed_at        INTEGER,
  trash_root_id     TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX files_object_uq ON files (storage_id, object_key);
CREATE UNIQUE INDEX files_upload_session_uq ON files (upload_session_id);
CREATE UNIQUE INDEX files_active_name_uq ON files (owner_id, coalesce(folder_id, ''), name) WHERE trashed_at IS NULL;
CREATE INDEX files_folder_idx ON files (owner_id, folder_id, trashed_at);
CREATE INDEX files_trash_root_idx ON files (trash_root_id) WHERE trash_root_id IS NOT NULL;

-- Private sharing with specific members (read + download only).
CREATE TABLE file_shares (
  file_id    TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  granted_by TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (file_id, user_id)
);
CREATE INDEX file_shares_user_idx ON file_shares (user_id);

-- Public "anyone with the link" tokens. token_hash = SHA-256(token) for lookup;
-- token_enc = AES-GCM(token) so the owner can copy the link again.
CREATE TABLE share_links (
  id         TEXT PRIMARY KEY NOT NULL,
  file_id    TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  token_enc  TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT REFERENCES users (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX share_links_token_uq ON share_links (token_hash);
CREATE UNIQUE INDEX share_links_active_uq ON share_links (file_id) WHERE revoked_at IS NULL;

-- Upload sessions. storage_id, staging_key and final_key are fixed server-side
-- at creation; switching the default storage never changes an existing session.
CREATE TABLE upload_sessions (
  id            TEXT PRIMARY KEY NOT NULL,
  owner_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  folder_id     TEXT REFERENCES folders (id) ON DELETE SET NULL,
  file_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  declared_size INTEGER NOT NULL CHECK (declared_size >= 0),
  declared_mime TEXT,
  storage_id    TEXT NOT NULL REFERENCES storage_targets (id) ON DELETE RESTRICT,
  staging_key   TEXT NOT NULL,
  final_key     TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'finalizing', 'completed', 'failed', 'expired', 'aborted')),
  lease_until   INTEGER,
  error_code    TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  completed_at  INTEGER
);
CREATE UNIQUE INDEX upload_sessions_staging_uq ON upload_sessions (storage_id, staging_key);
CREATE UNIQUE INDEX upload_sessions_final_uq ON upload_sessions (storage_id, final_key);
CREATE UNIQUE INDEX upload_sessions_file_uq ON upload_sessions (file_id);
CREATE INDEX upload_sessions_owner_idx ON upload_sessions (owner_id, state, created_at);
CREATE INDEX upload_sessions_state_idx ON upload_sessions (state, expires_at);

-- Deferred R2 deletions (staging cleanup, orphans, purged files).
-- The worker re-checks that nothing references the key before deleting it.
CREATE TABLE object_deletions (
  id         TEXT PRIMARY KEY NOT NULL,
  storage_id TEXT NOT NULL REFERENCES storage_targets (id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL,
  reason     TEXT NOT NULL,
  not_before INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX object_deletions_key_uq ON object_deletions (storage_id, object_key);
CREATE INDEX object_deletions_due_idx ON object_deletions (not_before);

-- Audit trail: sharing, membership changes, storage changes. No secrets/tokens.
CREATE TABLE audit_events (
  id            TEXT PRIMARY KEY NOT NULL,
  actor_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  metadata      TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX audit_events_created_idx ON audit_events (created_at);
CREATE INDEX audit_events_resource_idx ON audit_events (resource_type, resource_id);
