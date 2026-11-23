-- 0004: storage limits.
-- Unlimited per-member quota is a flag (not a NULL quota) so the users table
-- does not have to be rebuilt: rebuilding would fire ON DELETE CASCADE/RESTRICT
-- on every table that references users.
ALTER TABLE users ADD COLUMN quota_unlimited INTEGER NOT NULL DEFAULT 0 CHECK (quota_unlimited IN (0, 1));

-- Fast per-owner usage sums (quota checks, usage page).
CREATE INDEX IF NOT EXISTS files_owner_size_idx ON files (owner_id, size);
