-- Local-only storage target that points at scripts/fake-s3.ts (via DEV_S3_ENDPOINT).
-- Credentials come from R2_LOCAL_* in .dev.vars. Idempotent.
INSERT INTO storage_targets (id, name, account_id, bucket, credential_ref, accepting_uploads, capacity_bytes, priority, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'Local fake R2', '00000000000000000000000000000000', 'filenest-dev', 'LOCAL', 1, NULL, 1, 0, 0)
ON CONFLICT (id) DO NOTHING;
-- Local development: 2FA optional so dev-login works without an authenticator.
-- (Production default is "admins": Admins must enroll at their next sign-in.)
INSERT INTO system_settings (key, value, updated_at) VALUES ('mfaPolicy', '"optional"', 0)
ON CONFLICT (key) DO NOTHING;
