/**
 * Invitation links: /invite/<token>. The token is random (256-bit), stored as
 * SHA-256 plus an AES-GCM copy so the admin can copy the link again.
 * A use is claimed atomically (expiry, revocation, max uses) when an account is created.
 */
import { desc, eq, sql } from "drizzle-orm";
import { invitations, invitationUses, userIdentities, users, USER_SECURITY_DEFAULTS, type Invitation, type User } from "../db/schema.ts";
import type { Provider } from "../auth/providers.ts";
import type { Db, Env } from "../env.ts";
import { decryptString, encryptString, randomToken, sha256Hex } from "../lib/crypto.ts";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.ts";
import { auditInsert } from "./audit.ts";
import { normalizeEmail } from "./members.ts";

export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function key(env: Env) {
  if (!env.APP_ENCRYPTION_KEY) throw new HttpError(500, "not_configured", "Server is not configured for invitations");
  return env.APP_ENCRYPTION_KEY;
}

export function invitationState(inv: Invitation, now: number): "active" | "revoked" | "expired" | "used_up" {
  if (inv.revokedAt) return "revoked";
  if (inv.expiresAt <= now) return "expired";
  if (inv.useCount >= inv.maxUses) return "used_up";
  return "active";
}

export async function invitationDto(env: Env, inv: Invitation, origin: string, now: number) {
  return {
    id: inv.id,
    email: inv.email,
    role: inv.role,
    quotaBytes: inv.quotaBytes,
    maxUses: inv.maxUses,
    useCount: inv.useCount,
    note: inv.note,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    revokedAt: inv.revokedAt,
    state: invitationState(inv, now),
    url: invitationState(inv, now) === "active" ? `${origin}/invite/${await decryptString(key(env), inv.tokenEnc, inv.id)}` : null,
  };
}

export async function createInvitation(
  db: Db,
  env: Env,
  actor: User,
  input: { email?: unknown; role?: unknown; quotaBytes?: unknown; maxUses?: unknown; expiresInDays?: unknown; note?: unknown },
  origin: string,
  now: number,
) {
  const email = input.email === undefined || input.email === null || input.email === "" ? null : normalizeEmail(input.email);
  const role = input.role === "admin" ? "admin" : "member";
  const maxUses = input.maxUses === undefined ? 1 : Number(input.maxUses);
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) throw badRequest("invalid_max_uses", "Uses must be 1–1000");
  if (email && maxUses !== 1) throw badRequest("invalid_max_uses", "An email-bound invitation can be used once");
  const days = input.expiresInDays === undefined ? 7 : Number(input.expiresInDays);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw badRequest("invalid_expiry", "Expiry must be 1–90 days");
  let quotaBytes: number | null = null;
  if (input.quotaBytes !== undefined && input.quotaBytes !== null) {
    quotaBytes = Number(input.quotaBytes);
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 0) throw badRequest("invalid_quota");
  }
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 200) || null : null;
  if (email) {
    const exists = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
    if (exists) throw conflict("member_exists", "This email already has an account");
  }
  const token = randomToken(32);
  const id = crypto.randomUUID();
  const inv: Invitation = {
    id,
    tokenHash: await sha256Hex(token),
    tokenEnc: await encryptString(key(env), token, id),
    email,
    role,
    quotaBytes,
    maxUses,
    useCount: 0,
    note,
    createdBy: actor.id,
    createdAt: now,
    expiresAt: now + days * 24 * 3600_000,
    revokedAt: null,
  };
  await db.batch([
    db.insert(invitations).values(inv),
    auditInsert(db, now, actor.id, "invite.create", "invitation", id, { role, maxUses, days, emailBound: !!email }),
  ]);
  return invitationDto(env, inv, origin, now);
}

export async function listInvitations(db: Db, env: Env, origin: string, now: number) {
  const rows = await db.select().from(invitations).orderBy(desc(invitations.createdAt)).limit(200);
  return Promise.all(rows.map((r) => invitationDto(env, r, origin, now)));
}

export async function revokeInvitation(db: Db, actor: User, id: string, now: number) {
  const inv = await db.select().from(invitations).where(eq(invitations.id, id)).get();
  if (!inv) throw notFound();
  if (inv.revokedAt) return;
  await db.batch([
    db.update(invitations).set({ revokedAt: now }).where(eq(invitations.id, id)),
    auditInsert(db, now, actor.id, "invite.revoke", "invitation", id),
  ]);
}

/** Look up an active invitation by token (for the public /invite page and sign-up). */
export async function activeInvitation(db: Db, token: string, now: number): Promise<Invitation | null> {
  if (!INVITE_TOKEN_RE.test(token)) return null;
  const inv = await db.select().from(invitations).where(eq(invitations.tokenHash, await sha256Hex(token))).get();
  return inv && invitationState(inv, now) === "active" ? inv : null;
}

/**
 * Create a member from an invitation, claiming one use atomically.
 * `email` must match an email-bound invitation. Returns the new user.
 */
export async function acceptInvitation(
  db: Db,
  inv: Invitation,
  account: { email: string; name: string | null; identity?: { provider: Provider; subject: string; email: string }; passwordHash?: string; passwordSalt?: string },
  defaultQuota: number,
  now: number,
): Promise<User> {
  if (inv.email && inv.email !== account.email) throw new HttpError(403, "invite_email_mismatch", "This invitation is for a different email address");
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, account.email)).get();
  if (existing) throw conflict("member_exists", "An account with this email already exists. Sign in instead.");
  const claimed = await db.run(sql`
    UPDATE invitations SET use_count = use_count + 1
    WHERE id = ${inv.id} AND revoked_at IS NULL AND expires_at > ${now} AND use_count < max_uses`);
  if (claimed.meta.changes !== 1) throw new HttpError(410, "invite_invalid", "This invitation is no longer valid");
  const user: User = {
    id: crypto.randomUUID(),
    email: account.email,
    googleSub: null,
    name: account.name,
    role: inv.role,
    status: "active",
    quotaBytes: inv.quotaBytes ?? defaultQuota,
    invitedBy: inv.createdBy,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,
    ...USER_SECURITY_DEFAULTS,
    passwordHash: account.passwordHash ?? null,
    passwordSalt: account.passwordSalt ?? null,
    passwordUpdatedAt: account.passwordHash ? now : null,
  };
  try {
    await db.batch([
      db.insert(users).values(user),
      db.insert(invitationUses).values({ invitationId: inv.id, userId: user.id, usedAt: now }),
      ...(account.identity
        ? [db.insert(userIdentities).values({ ...account.identity, userId: user.id, createdAt: now })]
        : []),
      auditInsert(db, now, user.id, "invite.accept", "invitation", inv.id, { method: account.identity?.provider ?? "password" }),
    ] as unknown as [ReturnType<typeof auditInsert>]);
  } catch (e) {
    // Give the use back if the account could not be created (e.g. concurrent same-email sign-up).
    await db.run(sql`UPDATE invitations SET use_count = use_count - 1 WHERE id = ${inv.id} AND use_count > 0`);
    if (String(e).includes("UNIQUE")) throw conflict("member_exists", "An account with this email already exists. Sign in instead.");
    throw e;
  }
  return user;
}

