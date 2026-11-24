-- 0007: large files as R2 multipart uploads, resumable across page reloads.
-- Multipart sessions upload parts straight to final_key (the client only ever
-- gets per-part presigned PUTs); finalize lists the parts from R2 and completes
-- with those ETags. staging_key stays reserved but unused for these sessions.
ALTER TABLE upload_sessions ADD COLUMN multipart_id TEXT;
ALTER TABLE upload_sessions ADD COLUMN part_size INTEGER CHECK (part_size IS NULL OR part_size > 0);
ALTER TABLE upload_sessions ADD COLUMN part_count INTEGER CHECK (part_count IS NULL OR part_count BETWEEN 1 AND 10000);
-- SHA-256 hex of (first MiB || last MiB) of the local file: a resume must present
-- the same file, so parts from different files are never mixed.
ALTER TABLE upload_sessions ADD COLUMN fingerprint TEXT CHECK (fingerprint IS NULL OR length(fingerprint) = 64);
-- When a session was aborted/expired/failed. A closed multipart session keeps its
-- quota/capacity reservation until every part URL it handed out has expired, so
-- parts uploaded after an abort can never exceed a quota or a target's capacity.
ALTER TABLE upload_sessions ADD COLUMN closed_at INTEGER;
CREATE INDEX upload_sessions_resumable_idx ON upload_sessions (owner_id, state, multipart_id);

-- Incomplete multipart uploads to abort in R2 (frees stored parts).
CREATE TABLE multipart_aborts (
  multipart_id TEXT NOT NULL,
  storage_id   TEXT NOT NULL,
  object_key   TEXT NOT NULL,
  not_before   INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (storage_id, multipart_id)
);
CREATE INDEX multipart_aborts_due_idx ON multipart_aborts (not_before);
