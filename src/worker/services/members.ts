import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import { users, type User } from "../db/schema.ts";
import type { AppConfig, Db } from "../env.ts";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.ts";
import { escapeLike } from "../lib/names.ts";
import { revokeUserSessions } from "../auth/session.ts";
import { auditInsert } from "./audit.ts";
import type { GoogleIdentity } from "../auth/oidc.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== "string") throw badRequest("invalid_email");
  const e = raw.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw badRequest("invalid_email", "Invalid email");
  return e;
}

export type LoginOutcome = { ok: true; user: User } | { ok: false; reason: "not_invited" | "disabled" | "account_mismatch" };

/**
 * Map a verified Google identity to a member.
 * - Known google_sub => that member.
 * - Else invited row with the same verified email => bind sub.
 * - Else bootstrap: BOOTSTRAP_ADMIN_EMAIL becomes Admin only while no Admin exists.
 */
export async function resolveLogin(
  db: Db,
  id: GoogleIdentity,
  config: AppConfig,
  bootstrapEmail: string | undefined,
  now: number,
): Promise<LoginOutcome> {
  const bySub = await db.select().from(users).where(eq(users.googleSub, id.sub)).get();
  if (bySub) {
    if (bySub.status === "disabled") return { ok: false, reason: "disabled" };
    let email = id.email;
    try {
      await db
        .update(users)
        .set({ lastLoginAt: now, status: "active", email, name: id.name ?? bySub.name, updatedAt: now })
        .where(eq(users.id, bySub.id));
    } catch {
      // The new Google email is already on another row (e.g. an invite): keep the old one.
      email = bySub.email;
      await db.update(users).set({ lastLoginAt: now, status: "active", updatedAt: now }).where(eq(users.id, bySub.id));
    }
    return { ok: true, user: { ...bySub, status: "active", lastLoginAt: now, email } };
  }

  const byEmail = await db.select().from(users).where(eq(users.email, id.email)).get();
  if (byEmail) {
    if (byEmail.googleSub && byEmail.googleSub !== id.sub) return { ok: false, reason: "account_mismatch" };
    if (byEmail.status === "disabled") return { ok: false, reason: "disabled" };
    await db
      .update(users)
      .set({ googleSub: id.sub, status: "active", lastLoginAt: now, name: id.name ?? byEmail.name, updatedAt: now })
      .where(eq(users.id, byEmail.id));
    return { ok: true, user: { ...byEmail, googleSub: id.sub, status: "active", lastLoginAt: now } };
  }

  const boot = bootstrapEmail?.trim().toLowerCase();
  if (boot && boot === id.email) {
    const admin = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1).get();
    if (!admin) {
      const user: User = {
        id: crypto.randomUUID(),
        email: id.email,
        googleSub: id.sub,
        name: id.name,
        role: "admin",
        status: "active",
        quotaBytes: config.defaultQuotaBytes,
        invitedBy: null,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
      };
      // Conditional insert: only if there is still no admin (guards concurrent bootstrap).
      const res = await db.run(sql`
        INSERT INTO users (id, email, google_sub, name, role, status, quota_bytes, created_at, updated_at, last_login_at)
        SELECT ${user.id}, ${user.email}, ${user.googleSub}, ${user.name}, 'admin', 'active', ${user.quotaBytes}, ${now}, ${now}, ${now}
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`);
      if (res.meta.changes === 1) {
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
  const quotaBytes = input.quotaBytes === undefined ? config.defaultQuotaBytes : parseQuota(input.quotaBytes);
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
    next.status = patch.status === "active" && !target.googleSub ? "invited" : patch.status;
  }
  if (patch.quotaBytes !== undefined) next.quotaBytes = parseQuota(patch.quotaBytes);

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

  await db.batch([
    db.update(users).set({ ...next, updatedAt: now }).where(eq(users.id, id)),
    auditInsert(db, now, actor.id, "member.update", "user", id, {
      role: next.role ?? null,
      status: next.status ?? null,
      quotaBytes: next.quotaBytes ?? null,
    }),
  ]);
  if (next.status === "disabled") await revokeUserSessions(db, id);
  const updated = await db.select().from(users).where(eq(users.id, id)).get();
  return memberDto(updated!);
}

