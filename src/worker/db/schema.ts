/**
 * Typed mirror of migrations/*.sql for Drizzle queries.
 * The SQL migrations are the source of truth; keep this file in sync
 * (tests/worker/schema.test.ts fails when columns drift).
 */
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  googleSub: text("google_sub"),
  name: text("name"),
  role: text("role", { enum: ["admin", "member"] }).notNull(),
  status: text("status", { enum: ["invited", "active", "disabled"] }).notNull(),
  quotaBytes: integer("quota_bytes").notNull(),
  invitedBy: text("invited_by"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  lastLoginAt: integer("last_login_at"),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  csrfToken: text("csrf_token").notNull(),
  userId: text("user_id").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
});

export const oauthStates = sqliteTable("oauth_states", {
  stateHash: text("state_hash").primaryKey(),
  codeVerifier: text("code_verifier").notNull(),
  nonce: text("nonce").notNull(),
  returnTo: text("return_to").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const storageTargets = sqliteTable("storage_targets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  accountId: text("account_id").notNull(),
  bucket: text("bucket").notNull(),
  credentialRef: text("credential_ref").notNull(),
  acceptingUploads: integer("accepting_uploads", { mode: "boolean" }).notNull(),
  lastCheckAt: integer("last_check_at"),
  lastCheckOk: integer("last_check_ok", { mode: "boolean" }),
  lastCheckMessage: text("last_check_message"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey(),
  defaultStorageId: text("default_storage_id"),
  updatedAt: integer("updated_at").notNull(),
  updatedBy: text("updated_by"),
});

export const folders = sqliteTable("folders", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  parentId: text("parent_id"),
  name: text("name").notNull(),
  trashedAt: integer("trashed_at"),
  trashRootId: text("trash_root_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const files = sqliteTable("files", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  folderId: text("folder_id"),
  name: text("name").notNull(),
  size: integer("size").notNull(),
  mimeDeclared: text("mime_declared"),
  contentType: text("content_type").notNull(),
  inlineOk: integer("inline_ok", { mode: "boolean" }).notNull(),
  storageId: text("storage_id").notNull(),
  objectKey: text("object_key").notNull(),
  etag: text("etag").notNull(),
  uploadSessionId: text("upload_session_id").notNull(),
  trashedAt: integer("trashed_at"),
  trashRootId: text("trash_root_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const fileShares = sqliteTable(
  "file_shares",
  {
    fileId: text("file_id").notNull(),
    userId: text("user_id").notNull(),
    grantedBy: text("granted_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.fileId, t.userId] })],
);

export const shareLinks = sqliteTable("share_links", {
  id: text("id").primaryKey(),
  fileId: text("file_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  tokenEnc: text("token_enc").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
  revokedAt: integer("revoked_at"),
  revokedBy: text("revoked_by"),
  passwordHash: text("password_hash"),
  passwordSalt: text("password_salt"),
  passwordVersion: integer("password_version").notNull(),
});

export const shareUnlockAttempts = sqliteTable(
  "share_unlock_attempts",
  {
    linkId: text("link_id").notNull(),
    clientKey: text("client_key").notNull(),
    failedAttempts: integer("failed_attempts").notNull(),
    lockedUntil: integer("locked_until"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.linkId, t.clientKey] })],
);

export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  scopes: text("scopes").notNull(),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at"),
  windowStart: integer("window_start"),
  windowCount: integer("window_count").notNull(),
});
export type ApiToken = typeof apiTokens.$inferSelect;

export type UploadState = "pending" | "finalizing" | "completed" | "failed" | "expired" | "aborted";

export const uploadSessions = sqliteTable("upload_sessions", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  folderId: text("folder_id"),
  fileId: text("file_id").notNull(),
  name: text("name").notNull(),
  declaredSize: integer("declared_size").notNull(),
  declaredMime: text("declared_mime"),
  storageId: text("storage_id").notNull(),
  stagingKey: text("staging_key").notNull(),
  finalKey: text("final_key").notNull(),
  state: text("state", { enum: ["pending", "finalizing", "completed", "failed", "expired", "aborted"] }).notNull(),
  leaseUntil: integer("lease_until"),
  errorCode: text("error_code"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  completedAt: integer("completed_at"),
});

export const objectDeletions = sqliteTable("object_deletions", {
  id: text("id").primaryKey(),
  storageId: text("storage_id").notNull(),
  objectKey: text("object_key").notNull(),
  reason: text("reason").notNull(),
  notBefore: integer("not_before").notNull(),
  attempts: integer("attempts").notNull(),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
});

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  actorUserId: text("actor_user_id"),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  metadata: text("metadata"),
  createdAt: integer("created_at").notNull(),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type StorageTarget = typeof storageTargets.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type UploadSession = typeof uploadSessions.$inferSelect;
