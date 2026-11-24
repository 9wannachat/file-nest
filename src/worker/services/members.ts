import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import { USER_SECURITY_DEFAULTS, userIdentities, users, type IdentityProvider, type User } from "../db/schema.ts";
import type { AppConfig, Db } from "../env.ts";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.ts";
import { escapeLike } from "../lib/names.ts";
import { revokeUserSessions } from "../auth/session.ts";
import { auditInsert } from "./audit.ts";
import { getSettings } from "./settings.ts";
import { isProvider, type ExternalIdentity, type Provider } from "../auth/providers.ts";
import { atomicBatch } from "../db/client.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== "string") throw badRequest("invalid_email");
  const e = raw.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw badRequest("invalid_email", "Invalid email");
  return e;
}

/** SQL: does `users` (the outer row) have any way to sign in? Used to pick active vs invited. */
export const HAS_SIGN_IN_SQL = sql.raw(
  `("users"."password_hash" IS NOT NULL OR EXISTS (SELECT 1 FROM user_identities WHERE user_identities.user_id = "users"."id"))`,
);

export async function hasSignInMethod(db: Db, u: User): Promise<boolean> {
  if (u.passwordHash) return true;
  return !!(await db.select({ p: userIdentities.provider }).from(userIdentities).where(eq(userIdentities.userId, u.id)).limit(1).get());
}

/** Linked external providers (dev-login identities are not shown). */
export async function identitiesOf(db: Db, userId: string): Promise<Provider[]> {
  const rows = await db.select({ p: userIdentities.provider }).from(userIdentities).where(eq(userIdentities.userId, userId)).all();
  return rows.map((r) => r.p).filter(isProvider).sort();
}

/** A timed ban whose end has passed is lifted lazily (and by the cleanup cron). */
export async function liftExpiredBan(db: Db, u: User, now: number): Promise<User> {
  if (u.status !== "disabled" || !u.bannedUntil || u.bannedUntil > now) return u;
  const status = (await hasSignInMethod(db, u)) ? "active" : "invited";
  await db.update(users).set({ status, bannedReason: null, bannedUntil: null, bannedBy: null, updatedAt: now }).where(eq(users.id, u.id));
  return { ...u, status, bannedReason: null, bannedUntil: null, bannedBy: null };
}

export type LoginOutcome = { ok: true; user: User } | { ok: false; reason: "not_invited" | "disabled" | "account_mismatch" | "link_required" };
export type LoginIdentity = Omit<ExternalIdentity, "provider"> & { provider: IdentityProvider };

/**
 * Map a verified external identity to a member.
 * - Known (provider, subject) => that member.
 * - Else, only if the provider verified the email: a member with that email who
 *   has no identity for this provider yet => link it (allowlist / password user).
 * - Else bootstrap: BOOTSTRAP_ADMIN_EMAIL (verified) becomes Admin only while no Admin exists.
 * Unverified emails (Microsoft) never attach to an existing account: use an
 * email-bound invitation or "Connect" from the account page instead.
 */
export async function resolveLogin(
  db: Db,
  id: LoginIdentity,
  config: AppConfig,
  bootstrapEmail: string | undefined,
  now: number,
): Promise<LoginOutcome> {
  const linked = await db
    .select({ u: users })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId))
    .where(and(eq(userIdentities.provider, id.provider), eq(userIdentities.subject, id.subject)))
    .get();
  if (linked) {
    const bySub = await liftExpiredBan(db, linked.u, now);
    if (bySub.status === "disabled") return { ok: false, reason: "disabled" };
    // The member's email (also their password-login name) is never rewritten by a
    // provider: only the identity row keeps the provider's latest address.
    const base = { lastLoginAt: now, status: "active" as const, name: id.name ?? bySub.name, updatedAt: now };
    await db.batch([
      db.update(users).set(base).where(eq(users.id, bySub.id)),
      db
        .update(userIdentities)
        .set({ email: id.email || null })
        .where(and(eq(userIdentities.provider, id.provider), eq(userIdentities.subject, id.subject))),
    ]);
    return { ok: true, user: { ...bySub, ...base } };
  }
  if (!id.emailVerified || !id.email) return { ok: false, reason: "not_invited" };

  let byEmail = await db.select().from(users).where(eq(users.email, id.email)).get();
  if (byEmail) byEmail = await liftExpiredBan(db, byEmail, now);
  if (byEmail) {
    const same = await db
      .select({ s: userIdentities.subject })
      .from(userIdentities)
      .where(and(eq(userIdentities.userId, byEmail.id), eq(userIdentities.provider, id.provider)))
      .get();
    if (same) return { ok: false, reason: "account_mismatch" };
    if (byEmail.status === "disabled") return { ok: false, reason: "disabled" };
    // Attach by email only to a member who cannot sign in yet (allowlist row). An
    // account that already has a password or provider never proved it owns this
    // email to us, so a verified email must not join it silently: the member
    // connects the provider from Settings instead.
    if (await hasSignInMethod(db, byEmail)) return { ok: false, reason: "link_required" };
    try {
      await db.batch([
        db.insert(userIdentities).values({ provider: id.provider, subject: id.subject, userId: byEmail.id, email: id.email, createdAt: now }),
        db.update(users).set({ status: "active", lastLoginAt: now, name: id.name ?? byEmail.name, updatedAt: now }).where(eq(users.id, byEmail.id)),
      ]);
    } catch {
      return { ok: false, reason: "account_mismatch" }; // concurrent link of the same provider
    }
    return { ok: true, user: { ...byEmail, status: "active", lastLoginAt: now, name: id.name ?? byEmail.name } };
  }

  const boot = bootstrapEmail?.trim().toLowerCase();
  if (boot && boot === id.email) {
    const admin = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1).get();
    if (!admin) {
      const user: User = {
        id: crypto.randomUUID(),
        email: id.email,
        googleSub: null,
        name: id.name,
        role: "admin",
        status: "active",
        quotaBytes: config.defaultQuotaBytes,
        invitedBy: null,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
        ...USER_SECURITY_DEFAULTS,
      };
      // Conditional insert: only if there is still no admin (guards concurrent bootstrap).
      const [res] = await atomicBatch(db.$client, [
        sql`
        INSERT INTO users (id, email, name, role, status, quota_bytes, created_at, updated_at, last_login_at)
        SELECT ${user.id}, ${user.email}, ${user.name}, 'admin', 'active', ${user.quotaBytes}, ${now}, ${now}, ${now}
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`,
        sql`
        INSERT INTO user_identities (provider, subject, user_id, email, created_at)
        SELECT ${id.provider}, ${id.subject}, ${user.id}, ${id.email}, ${now}
        WHERE EXISTS (SELECT 1 FROM users WHERE id = ${user.id})`,
      ]);
      if (res?.meta.changes === 1) {
        await auditInsert(db, now, user.id, "member.bootstrap_admin", "user", user.id);
        return { ok: true, user };
      }
    }
  }
  return { ok: false, reason: "not_invited" };
}

export function memberDto(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    quotaBytes: u.quotaBytes,
    quotaUnlimited: u.quotaUnlimited,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

export async function listMembers(db: Db) {
  const rows = await db.select().from(users).orderBy(asc(users.email));
  return rows.map(memberDto);
}

/** Lightweight directory for the share dialog: active members only. */
export async function lookupMembers(db: Db, q: string, excludeId: string) {
  const term = `%${escapeLike(q.trim().toLowerCase())}%`;
  return db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(
      and(
        eq(users.status, "active"),
        ne(users.id, excludeId),
        q.trim() ? or(sql`${users.email} LIKE ${term} ESCAPE '\\'`, sql`lower(${users.name}) LIKE ${term} ESCAPE '\\'`) : undefined,
      ),
    )
    .orderBy(asc(users.email))
    .limit(20);
}

export async function inviteMember(
  db: Db,
  actor: User,
  input: { email?: unknown; role?: unknown; quotaBytes?: unknown },
  config: AppConfig,
  now: number,
) {
  const email = normalizeEmail(input.email);
  const role = input.role === "admin" ? "admin" : "member";
  const quotaBytes = input.quotaBytes === undefined ? (await getSettings(db, config)).defaultQuotaBytes : parseQuota(input.quotaBytes);
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
  if (existing) throw conflict("member_exists", "This email is already on the list");
  const user: User = {
    id: crypto.randomUUID(),
    email,
    googleSub: null,
    name: null,
    role,
    status: "invited",
    quotaBytes,
    invitedBy: actor.id,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    ...USER_SECURITY_DEFAULTS,
  };
  await db.batch([
    db.insert(users).values(user),
    auditInsert(db, now, actor.id, "member.invite", "user", user.id, { role }),
  ]);
  return memberDto(user);
}

function parseQuota(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw badRequest("invalid_quota");
  return n;
}

export async function updateMember(
  db: Db,
  actor: User,
  id: string,
  patch: { role?: unknown; status?: unknown; quotaBytes?: unknown },
  now: number,
) {
  const target = await db.select().from(users).where(eq(users.id, id)).get();
  if (!target) throw notFound();
  const next: Partial<User> = {};
  if (patch.role !== undefined) {
    if (patch.role !== "admin" && patch.role !== "member") throw badRequest("invalid_role");
    next.role = patch.role;
  }
  if (patch.status !== undefined) {
    if (patch.status !== "active" && patch.status !== "disabled") throw badRequest("invalid_status");
    // Re-enabling someone who never signed in returns them to "invited".
    next.status = patch.status === "active" && !(await hasSignInMethod(db, target)) ? "invited" : patch.status;
  }
  if (patch.quotaBytes !== undefined) {
    // null = unlimited (the stored byte value is kept for when the flag is removed)
    if (patch.quotaBytes === null) next.quotaUnlimited = true;
    else {
      next.quotaBytes = parseQuota(patch.quotaBytes);
      next.quotaUnlimited = false;
    }
  }

  const losingAdmin =
    target.role === "admin" && target.status === "active" && (next.role === "member" || next.status === "disabled");
  if (losingAdmin) {
    const others = await db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.status, "active"), ne(users.id, id)))
      .get();
    if (!others || others.n === 0) throw conflict("last_admin", "At least one active Admin is required");
  }
  if (id === actor.id && next.status === "disabled") throw new HttpError(409, "self_disable", "You cannot disable yourself");

  const [upd] = await db.batch([
    db
      .update(users)
      .set({ ...next, updatedAt: now })
      .where(
        and(
          eq(users.id, id),
          // Re-checked atomically: concurrent demotions cannot remove the last admin.
          losingAdmin
            ? sql`EXISTS (SELECT 1 FROM users o WHERE o.role = 'admin' AND o.status = 'active' AND o.id <> ${id})`
            : undefined,
        ),
      ),
    auditInsert(db, now, actor.id, "member.update", "user", id, {
      role: next.role ?? null,
      status: next.status ?? null,
      quotaBytes: next.quotaBytes ?? null,
      ...(patch.quotaBytes !== undefined
        ? { previousQuota: target.quotaUnlimited ? "unlimited" : target.quotaBytes, newQuota: next.quotaUnlimited ? "unlimited" : (next.quotaBytes ?? null) }
        : {}),
    }),
  ]);
  if ((upd as unknown as { meta: { changes: number } }).meta.changes !== 1) throw conflict("last_admin", "At least one active Admin is required");
  if (next.status === "disabled") await revokeUserSessions(db, id);
  const updated = await db.select().from(users).where(eq(users.id, id)).get();
  return memberDto(updated!);
}

