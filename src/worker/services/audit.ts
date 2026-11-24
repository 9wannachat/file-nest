import { auditEvents } from "../db/schema.ts";
import type { Db } from "../env.ts";

export type AuditAction =
  | "member.invite"
  | "member.update"
  | "member.bootstrap_admin"
  | "account.identity_link"
  | "account.identity_unlink"
  | "share.member_grant"
  | "share.member_revoke"
  | "share.link_create"
  | "share.link_revoke"
  | "share.link_password_set"
  | "share.link_password_clear"
  | "token.create"
  | "token.revoke"
  | "settings.update"
  | "auth.password_change"
  | "auth.password_reset"
  | "auth.mfa_enable"
  | "auth.mfa_disable"
  | "auth.recovery_codes_regenerate"
  | "member.ban"
  | "member.unban"
  | "member.sessions_revoke"
  | "member.tokens_revoke"
  | "member.mfa_reset"
  | "member.password_reset_link"
  | "invite.create"
  | "invite.revoke"
  | "invite.accept"
  | "share.link_admin_revoke"
  | "storage.create"
  | "storage.update"
  | "storage.delete"
  | "storage.default_switch"
  | "storage.reorder";

/** Build an audit insert (use inside db.batch for atomicity). Metadata must not contain secrets. */
export function auditInsert(
  db: Db,
  now: number,
  actorUserId: string | null,
  action: AuditAction,
  resourceType: string,
  resourceId: string,
  metadata?: Record<string, string | number | boolean | null>,
) {
  return db.insert(auditEvents).values({
    id: crypto.randomUUID(),
    actorUserId,
    action,
    resourceType,
    resourceId,
    metadata: metadata ? JSON.stringify(metadata) : null,
    createdAt: now,
  });
}
