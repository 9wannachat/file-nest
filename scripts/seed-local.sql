-- Local-only storage target that points at scripts/fake-s3.ts (via DEV_S3_ENDPOINT).
-- Credentials come from R2_LOCAL_* in .dev.vars. Idempotent.
INSERT INTO storage_targets (id, name, account_id, bucket, credential_ref, accepting_uploads, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'Local fake R2', '00000000000000000000000000000000', 'filenest-dev', 'LOCAL', 1, 0, 0)
ON CONFLICT (id) DO NOTHING;
UPDATE app_settings SET default_storage_id = '00000000-0000-4000-8000-000000000001'
WHERE id = 1 AND default_storage_id IS NULL;
