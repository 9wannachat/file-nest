-- 0005: per-target capacity and placement order. Total capacity = sum of the
-- targets' capacities; new uploads go to the first target (by priority) that
-- accepts uploads, passed its last health check and has room for the file.
ALTER TABLE storage_targets ADD COLUMN capacity_bytes INTEGER CHECK (capacity_bytes IS NULL OR capacity_bytes >= 0); -- NULL = unlimited
ALTER TABLE storage_targets ADD COLUMN priority INTEGER NOT NULL DEFAULT 100;

-- Keep today's behaviour: the old default first, the rest by creation order.
-- Existing targets stay unlimited until an Admin sets a capacity.
UPDATE storage_targets SET priority = 1 + (
  SELECT count(*) FROM storage_targets t2
  WHERE t2.created_at < storage_targets.created_at OR (t2.created_at = storage_targets.created_at AND t2.id < storage_targets.id)
);
UPDATE storage_targets SET priority = 0 WHERE id = (SELECT default_storage_id FROM app_settings WHERE id = 1);
-- The pointer is no longer used; clear it so the old default can be deleted (FK RESTRICT).
UPDATE app_settings SET default_storage_id = NULL WHERE id = 1;

-- app_settings.default_storage_id is no longer used (kept to avoid a table rebuild).
-- The system-wide cap setting is replaced by the sum of target capacities.
DELETE FROM system_settings WHERE key = 'storageCapBytes';

CREATE INDEX IF NOT EXISTS files_storage_size_idx ON files (storage_id, size);
CREATE INDEX IF NOT EXISTS upload_sessions_storage_state_idx ON upload_sessions (storage_id, state, expires_at);
