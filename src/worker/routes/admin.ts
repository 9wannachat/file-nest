/**
 * Admin Console API. Session-only (requireAdmin rejects API tokens).
 * Sensitive actions need a recent sign-in / re-auth (requireRecentAuth).
 * Admins see aggregates, member metadata and PUBLIC links; never private file
 * names or contents.
 */
import { and, desc, eq, isNull, like, lt, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { apiTokens, auditEvents, files, mfaChallenges, sessions, shareLinks, storageTargets, uploadSessions, users, type User } from "../db/schema.ts";
import type { AppEnv } from "../env.ts";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.ts";
import { escapeLike } from "../lib/names.ts";
import { appOrigin, authOf, requireAdmin, requireRecentAuth } from "../auth/middleware.ts";
import { revokeUserSessions } from "../auth/session.ts";
import { atomicBatch } from "../db/client.ts";
import { auditInsert } from "../services/audit.ts";
import { createPasswordReset, disableTotp } from "../services/authn.ts";
import { createInvitation, listInvitations, revokeInvitation } from "../services/invitations.ts";
import * as members from "../services/members.ts";
import { getSettings, updateSettings } from "../services/settings.ts";
import * as storage from "../services/storage.ts";
import { idParam, jsonBody, now, storageCtx } from "./util.ts";

export const admin = new Hono<AppEnv>();
admin.use("*", requireAdmin);

const recent = (c: Parameters<typeof requireRecentAuth>[0] & { get: (k: "deps") => AppEnv["Variables"]["deps"] }) =>
  requireRecentAuth(c, c.get("deps").now());

// ---------- overview ----------

admin.get("/overview", async (c) => {
  const db = c.get("db");
  const t = now(c);
  const one = async <T>(q: Promise<T | undefined>) => (await q) as T;
  const [u, f, pl, up, ss] = await Promise.all([
    one(
      db
        .select({
          total: sql<number>`count(*)`,
          active: sql<number>`sum(CASE WHEN status = 'active' THEN 1 ELSE 0 END)`,
          invited: sql<number>`sum(CASE WHEN status = 'invited' THEN 1 ELSE 0 END)`,
          disabled: sql<number>`sum(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END)`,
          admins: sql<number>`sum(CASE WHEN role = 'admin' THEN 1 ELSE 0 END)`,
          mfa: sql<number>`sum(CASE WHEN totp_enabled_at IS NOT NULL THEN 1 ELSE 0 END)`,
        })
        .from(users)
        .get(),
    ),
    one(
      db
        .select({ count: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(size), 0)`, trashed: sql<number>`sum(CASE WHEN trashed_at IS NOT NULL THEN 1 ELSE 0 END)` })
        .from(files)
        .get(),
    ),
    one(db.select({ n: sql<number>`count(*)` }).from(shareLinks).where(isNull(shareLinks.revokedAt)).get()),
    one(
      db
        .select({ n: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(declared_size), 0)` })
        .from(uploadSessions)
        .where(and(eq(uploadSessions.state, "completed"), sql`${uploadSessions.completedAt} > ${t - 24 * 3600_000}`))
        .get(),
    ),
    one(db.select({ n: sql<number>`count(DISTINCT user_id)` }).from(sessions).where(sql`${sessions.expiresAt} > ${t}`).get()),
  ]);
  const perStorage = await db
    .select({
      id: storageTargets.id,
      name: storageTargets.name,
      lastCheckOk: storageTargets.lastCheckOk,
      count: sql<number>`(SELECT count(*) FROM files WHERE storage_id = "storage_targets"."id")`,
      bytes: sql<number>`(SELECT coalesce(sum(size), 0) FROM files WHERE storage_id = "storage_targets"."id")`,
    })
    .from(storageTargets);
  const recentEvents = await db.select().from(auditEvents).orderBy(desc(auditEvents.createdAt)).limit(10);
  const cap = await storage.capacitySummary(db, t);
  const near = await db.get<{ n: number; over: number }>(sql`
    SELECT sum(CASE WHEN used >= quota * 0.8 THEN 1 ELSE 0 END) AS n, sum(CASE WHEN used > quota THEN 1 ELSE 0 END) AS over
    FROM (SELECT u.quota_bytes AS quota, (SELECT coalesce(sum(f.size), 0) FROM files f WHERE f.owner_id = u.id) AS used
          FROM users u WHERE u.quota_unlimited = 0 AND u.quota_bytes > 0)`);
  return c.json({
    users: u,
    files: f,
    publicLinks: pl.n,
    uploads24h: up,
    signedInUsers: ss.n,
    storage: perStorage,
    recentEvents,
    capacity: { capBytes: cap.capacityBytes, freeBytes: cap.freeBytes, largestFreeBytes: cap.largestFreeBytes, membersNearQuota: Number(near?.n ?? 0), membersOverQuota: Number(near?.over ?? 0) },
  });
});

// ---------- members ----------

function memberRow(r: { u: User; usedBytes: number; fileCount: number; sessionCount: number }) {
  return {
    ...members.memberDto(r.u),
    hasPassword: !!r.u.passwordHash,
    googleLinked: !!r.u.googleSub && !r.u.googleSub.startsWith("dev:"),
    mfaEnabled: !!r.u.totpEnabledAt,
    bannedReason: r.u.bannedReason,
    bannedUntil: r.u.bannedUntil,
    usedBytes: Number(r.usedBytes),
    fileCount: Number(r.fileCount),
    sessionCount: Number(r.sessionCount),
  };
}

const memberSelect = (db: AppEnv["Variables"]["db"], t: number) =>
  db
    .select({
      u: users,
      usedBytes: sql<number>`(SELECT coalesce(sum(size), 0) FROM files f WHERE f.owner_id = "users"."id")`,
      fileCount: sql<number>`(SELECT count(*) FROM files f WHERE f.owner_id = "users"."id")`,
      sessionCount: sql<number>`(SELECT count(*) FROM sessions s WHERE s.user_id = "users"."id" AND s.expires_at > ${t})`,
    })
    .from(users);

admin.get("/members", async (c) => {
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const status = c.req.query("status");
  const role = c.req.query("role");
  const term = `%${escapeLike(q)}%`;
  const rows = await memberSelect(c.get("db"), now(c))
    .where(
      and(
        q ? or(sql`${users.email} LIKE ${term} ESCAPE '\\'`, sql`lower(coalesce(${users.name}, '')) LIKE ${term} ESCAPE '\\'`) : undefined,
        status === "active" || status === "invited" || status === "disabled" ? eq(users.status, status) : undefined,
        role === "admin" || role === "member" ? eq(users.role, role) : undefined,
      ),
    )
    .orderBy(users.email)
    .limit(500);
  return c.json({ members: rows.map(memberRow) });
});

admin.post("/members", async (c) => {
  const b = await jsonBody(c);
  if (b.role === "admin") recent(c);
  return c.json(await members.inviteMember(c.get("db"), authOf(c).user, b, c.get("config"), now(c)), 201);
});

async function target(c: Parameters<typeof idParam>[0]) {
  const u = await c.get("db").select().from(users).where(eq(users.id, idParam(c))).get();
  if (!u) throw notFound();
  return u;
}

admin.get("/members/:id", async (c) => {
  const db = c.get("db");
  const t = now(c);
  const u = await target(c);
  const row = (await memberSelect(db, t).where(eq(users.id, u.id)).get())!;
  const sess = await db
    .select({ id: sessions.id, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, authMethod: sessions.authMethod, userAgent: sessions.userAgent })
    .from(sessions)
    .where(and(eq(sessions.userId, u.id), sql`${sessions.expiresAt} > ${t}`))
    .orderBy(desc(sessions.lastSeenAt))
    .limit(50);
  const toks = await db
    .select({ id: apiTokens.id, name: apiTokens.name, scopes: apiTokens.scopes, createdAt: apiTokens.createdAt, lastUsedAt: apiTokens.lastUsedAt, expiresAt: apiTokens.expiresAt, revokedAt: apiTokens.revokedAt })
    .from(apiTokens)
    .where(eq(apiTokens.userId, u.id))
    .orderBy(desc(apiTokens.createdAt));
  const links = await db
    .select({ id: shareLinks.id, fileName: files.name, createdAt: shareLinks.createdAt, passwordProtected: sql<number>`${shareLinks.passwordHash} IS NOT NULL` })
    .from(shareLinks)
    .innerJoin(files, eq(files.id, shareLinks.fileId))
    .where(and(eq(files.ownerId, u.id), isNull(shareLinks.revokedAt)));
  const activity = await db
    .select()
    .from(auditEvents)
    .where(or(eq(auditEvents.actorUserId, u.id), and(eq(auditEvents.resourceType, "user"), eq(auditEvents.resourceId, u.id))))
    .orderBy(desc(auditEvents.createdAt))
    .limit(30);
  return c.json({
    member: memberRow(row),
    sessions: sess,
    tokens: toks.map((x) => ({ ...x, scopes: x.scopes.split(" ") })),
    publicLinks: links.map((l) => ({ ...l, passwordProtected: !!l.passwordProtected })),
    activity,
  });
});

admin.patch("/members/:id", async (c) => {
  const b = await jsonBody(c);
  // Role/status changes and granting unlimited storage need a recent sign-in.
  if (b.role !== undefined || b.status !== undefined || b.quotaBytes === null) recent(c);
  return c.json(await members.updateMember(c.get("db"), authOf(c).user, idParam(c), b, now(c)));
});

async function assertNotLastAdminOrSelf(c: Parameters<typeof idParam>[0], u: User, actor: User) {
  if (u.id === actor.id) throw new HttpError(409, "self_action", "You cannot do this to your own account");
  if (u.role === "admin" && u.status === "active") {
    const others = await c
      .get("db")
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.status, "active"), ne(users.id, u.id)))
      .get();
    if (!others?.n) throw conflict("last_admin", "At least one active Admin is required");
  }
}

admin.post("/members/:id/ban", async (c) => {
  recent(c);
  const db = c.get("db");
  const t = now(c);
  const actor = authOf(c).user;
  const u = await target(c);
  await assertNotLastAdminOrSelf(c, u, actor);
  const b = await jsonBody(c);
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 300) : "";
  if (!reason) throw badRequest("invalid_reason", "A reason is required");
  let until: number | null = null;
  if (b.days !== undefined && b.days !== null) {
    const d = Number(b.days);
    if (!Number.isInteger(d) || d < 1 || d > 3650) throw badRequest("invalid_days", "Days must be 1–3650");
    until = t + d * 24 * 3600_000;
  }
  // Guarded in the same statement: never leave the system without an active admin.
  const res = await db.run(sql`UPDATE users SET status = 'disabled', banned_reason = ${reason}, banned_until = ${until}, banned_by = ${actor.id}, updated_at = ${t}
    WHERE id = ${u.id} AND (role <> 'admin' OR EXISTS (SELECT 1 FROM users o WHERE o.role = 'admin' AND o.status = 'active' AND o.id <> ${u.id}))`);
  if (res.meta.changes !== 1) throw conflict("last_admin", "At least one active Admin is required");
  await db.batch([
    db.delete(sessions).where(eq(sessions.userId, u.id)),
    db.delete(mfaChallenges).where(eq(mfaChallenges.userId, u.id)),
    db.update(apiTokens).set({ revokedAt: t }).where(and(eq(apiTokens.userId, u.id), isNull(apiTokens.revokedAt))),
    auditInsert(db, t, actor.id, "member.ban", "user", u.id, { until, reasonLength: reason.length }),
  ]);
  return c.json({ ok: true });
});

admin.post("/members/:id/unban", async (c) => {
  recent(c);
  const db = c.get("db");
  const t = now(c);
  const actor = authOf(c).user;
  const u = await target(c);
  const status = u.googleSub || u.passwordHash ? "active" : "invited";
  await db.batch([
    db.update(users).set({ status, bannedReason: null, bannedUntil: null, bannedBy: null, updatedAt: t }).where(eq(users.id, u.id)),
    auditInsert(db, t, actor.id, "member.unban", "user", u.id),
  ]);
  return c.json({ ok: true });
});

admin.post("/members/:id/revoke-sessions", async (c) => {
  const db = c.get("db");
  const t = now(c);
  const u = await target(c);
  await revokeUserSessions(db, u.id);
  await auditInsert(db, t, authOf(c).user.id, "member.sessions_revoke", "user", u.id);
  return c.json({ ok: true });
});

admin.post("/members/:id/revoke-tokens", async (c) => {
  const db = c.get("db");
  const t = now(c);
  const u = await target(c);
  await db.batch([
    db.update(apiTokens).set({ revokedAt: t }).where(and(eq(apiTokens.userId, u.id), isNull(apiTokens.revokedAt))),
    auditInsert(db, t, authOf(c).user.id, "member.tokens_revoke", "user", u.id),
  ]);
  return c.json({ ok: true });
});

admin.post("/members/:id/reset-2fa", async (c) => {
  recent(c);
  const t = now(c);
  const actor = authOf(c).user;
  const u = await target(c);
  if (u.id === actor.id) throw new HttpError(409, "self_action", "Use your own Settings to change 2FA");
  await disableTotp(c.get("db"), u.id, actor.id, t, "member.mfa_reset");
  await revokeUserSessions(c.get("db"), u.id);
  return c.json({ ok: true });
});

admin.post("/members/:id/password-reset", async (c) => {
  recent(c);
  const u = await target(c);
  if (u.status === "disabled") throw new HttpError(409, "member_disabled", "Unban the member first");
  // Limit what an Admin can do with someone else's credentials:
  if (!u.passwordHash) throw new HttpError(409, "no_password", "This member signs in with Google; there is no password to reset");
  if (u.totpEnabledAt) throw new HttpError(409, "mfa_enabled", "This member uses 2FA; they can still sign in with their authenticator and change it themselves");
  return c.json(await createPasswordReset(c.get("db"), u, authOf(c).user.id, appOrigin(c), now(c)), 201);
});

// ---------- storage usage ----------

admin.get("/usage", async (c) => {
  const filter = c.req.query("filter");
  const rows = await c.get("db").all<{
    id: string;
    email: string;
    name: string | null;
    status: string;
    quotaBytes: number;
    quotaUnlimited: number;
    usedBytes: number;
    trashedBytes: number;
    fileCount: number;
  }>(sql`
    SELECT u.id, u.email, u.name, u.status, u.quota_bytes AS quotaBytes, u.quota_unlimited AS quotaUnlimited,
      coalesce(sum(f.size), 0) AS usedBytes,
      coalesce(sum(CASE WHEN f.trashed_at IS NOT NULL THEN f.size ELSE 0 END), 0) AS trashedBytes,
      count(f.id) AS fileCount
    FROM users u LEFT JOIN files f ON f.owner_id = u.id
    GROUP BY u.id
    ORDER BY usedBytes DESC
    LIMIT 1000`);
  const list = rows
    .map((r) => {
      const unlimited = r.quotaUnlimited === 1;
      const pct = unlimited || r.quotaBytes <= 0 ? null : Math.round((r.usedBytes / r.quotaBytes) * 1000) / 10;
      return { ...r, quotaUnlimited: unlimited, percent: pct };
    })
    .filter((r) => (filter === "near" ? (r.percent ?? 0) >= 80 : filter === "over" ? (r.percent ?? 0) > 100 : true));
  const cap = await storage.capacitySummary(c.get("db"), now(c));
  return c.json({ members: list, totalBytes: cap.usedBytes, capBytes: cap.capacityBytes });
});

/** Set the same quota (bytes, or null = unlimited) for up to 100 members, atomically. */
admin.post("/members/bulk-quota", async (c) => {
  recent(c);
  const b = await jsonBody(c);
  const ids = b.userIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every((x) => typeof x === "string" && /^[0-9a-f-]{36}$/.test(x))) {
    throw badRequest("invalid_members", "Select 1–100 members");
  }
  if (!("quotaBytes" in b) || !(b.quotaBytes === null || (typeof b.quotaBytes === "number" && Number.isSafeInteger(b.quotaBytes) && b.quotaBytes >= 0))) {
    throw badRequest("invalid_quota", "quotaBytes must be a non-negative integer or null (unlimited)");
  }
  const actor = authOf(c).user;
  const t = now(c);
  const idsJson = JSON.stringify([...new Set(ids as string[])]);
  const unlimited = b.quotaBytes === null ? 1 : 0;
  const bytes = b.quotaBytes === null ? null : (b.quotaBytes as number);
  const meta = JSON.stringify({ bulk: true, newQuota: unlimited ? "unlimited" : bytes });
  // One atomic batch; ids travel as ONE JSON parameter (no 100-parameter limit, fixed D1 call count).
  const [, upd] = await atomicBatch(c.get("db").$client, [
    sql`INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, metadata, created_at)
        SELECT lower(hex(randomblob(16))), ${actor.id}, 'member.update', 'user', u.id,
               json_set(${meta}, '$.previousQuota', CASE WHEN u.quota_unlimited = 1 THEN 'unlimited' ELSE u.quota_bytes END), ${t}
        FROM users u WHERE u.id IN (SELECT value FROM json_each(${idsJson}))`,
    sql`UPDATE users SET quota_unlimited = ${unlimited}, quota_bytes = coalesce(${bytes}, quota_bytes), updated_at = ${t}
        WHERE id IN (SELECT value FROM json_each(${idsJson}))`,
  ]);
  return c.json({ updated: upd?.meta.changes ?? 0 });
});

// ---------- invitations ----------

admin.get("/invitations", async (c) => {
  // Links are bearer secrets: only reveal them to a recently re-authenticated session.
  let reveal = true;
  try {
    recent(c);
  } catch {
    reveal = false;
  }
  const list = await listInvitations(c.get("db"), c.env, appOrigin(c), now(c));
  return c.json({ invitations: list.map((i) => (reveal ? i : { ...i, url: null, urlHidden: i.state === "active" })), revealed: reveal });
});
/** Step-up only: the UI calls this before showing invitation links. */
admin.post("/invitations/reveal", (c) => {
  recent(c);
  return c.json({ ok: true });
});
admin.post("/invitations", async (c) => {
  const b = await jsonBody(c);
  if (b.role === "admin") recent(c);
  return c.json(await createInvitation(c.get("db"), c.env, authOf(c).user, b, appOrigin(c), now(c)), 201);
});
admin.delete("/invitations/:id", async (c) => {
  await revokeInvitation(c.get("db"), authOf(c).user, idParam(c), now(c));
  return c.json({ ok: true });
});

// ---------- public links (moderation) ----------

admin.get("/public-links", async (c) => {
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const rows = await c
    .get("db")
    .select({
      id: shareLinks.id,
      fileId: files.id,
      fileName: files.name,
      size: files.size,
      ownerEmail: users.email,
      createdAt: shareLinks.createdAt,
      passwordProtected: sql<number>`${shareLinks.passwordHash} IS NOT NULL`,
    })
    .from(shareLinks)
    .innerJoin(files, eq(files.id, shareLinks.fileId))
    .innerJoin(users, eq(users.id, files.ownerId))
    .where(and(isNull(shareLinks.revokedAt), q ? like(sql`lower(${files.name})`, `%${escapeLike(q)}%`) : undefined))
    .orderBy(desc(shareLinks.createdAt))
    .limit(500);
  return c.json({ links: rows.map((r) => ({ ...r, passwordProtected: !!r.passwordProtected })) });
});

admin.delete("/public-links/:id", async (c) => {
  const db = c.get("db");
  const t = now(c);
  const actor = authOf(c).user;
  const link = await db.select().from(shareLinks).where(eq(shareLinks.id, idParam(c))).get();
  if (!link) throw notFound();
  if (!link.revokedAt) {
    await db.batch([
      db.update(shareLinks).set({ revokedAt: t, revokedBy: actor.id }).where(eq(shareLinks.id, link.id)),
      auditInsert(db, t, actor.id, "share.link_admin_revoke", "file", link.fileId, { linkId: link.id }),
    ]);
  }
  return c.json({ ok: true });
});

// ---------- settings ----------

admin.get("/settings", async (c) => {
  const config = c.get("config");
  return c.json({ settings: await getSettings(c.get("db"), config), limits: { maxUploadBytes: config.maxUploadBytes } });
});
admin.put("/settings", async (c) => {
  recent(c);
  const b = await jsonBody(c);
  const googleConfigured = !!c.env.GOOGLE_CLIENT_ID && !!c.env.GOOGLE_CLIENT_SECRET;
  return c.json({ settings: await updateSettings(c.get("db"), c.get("config"), authOf(c).user.id, b, now(c), googleConfigured) });
});

// ---------- storage ----------

admin.get("/storage", async (c) => {
  const ctx = storageCtx(c);
  const summary = await storage.capacitySummary(ctx.db, now(c));
  return c.json({ targets: await storage.listTargets(ctx), defaultStorageId: summary.nextTargetId, summary });
});
/** Placement order: body { ids: [...every target id, first = filled first] }. */
admin.put("/storage-order", async (c) => {
  recent(c);
  const b = await jsonBody(c);
  return c.json(await storage.reorderTargets(storageCtx(c), authOf(c).user, b.ids));
});
admin.post("/storage", async (c) => {
  recent(c);
  const b = await jsonBody(c);
  return c.json(await storage.createTarget(storageCtx(c), authOf(c).user, b), 201);
});
admin.patch("/storage/:id", async (c) => {
  recent(c);
  const b = await jsonBody(c);
  return c.json(await storage.updateTarget(storageCtx(c), authOf(c).user, idParam(c), b));
});
admin.delete("/storage/:id", async (c) => {
  recent(c);
  await storage.deleteTarget(storageCtx(c), authOf(c).user, idParam(c));
  return c.json({ ok: true });
});
admin.post("/storage/:id/check", async (c) => c.json(await storage.checkTarget(storageCtx(c), idParam(c), appOrigin(c))));
admin.put("/storage-default", async (c) => {
  recent(c);
  const b = await jsonBody(c);
  return c.json(await storage.setDefaultTarget(storageCtx(c), authOf(c).user, b.storageId));
});

// ---------- audit ----------

function auditWhere(c: Parameters<typeof idParam>[0]) {
  const before = Number(c.req.query("before"));
  const action = c.req.query("action");
  const actor = c.req.query("actor");
  return and(
    Number.isSafeInteger(before) && before > 0 ? lt(auditEvents.createdAt, before) : undefined,
    action && /^[a-z_.]{1,60}$/.test(action) ? like(auditEvents.action, `${escapeLike(action)}%`) : undefined,
    actor && /^[0-9a-f-]{36}$/.test(actor) ? eq(auditEvents.actorUserId, actor) : undefined,
  );
}

admin.get("/audit", async (c) => {
  const rows = await c
    .get("db")
    .select({ e: auditEvents, actorEmail: users.email })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(auditWhere(c))
    .orderBy(desc(auditEvents.createdAt))
    .limit(100);
  return c.json({ events: rows.map((r) => ({ ...r.e, actorEmail: r.actorEmail })) });
});

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Neutralise spreadsheet formulas and quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

admin.get("/audit.csv", async (c) => {
  const rows = await c
    .get("db")
    .select({ e: auditEvents, actorEmail: users.email })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(auditWhere(c))
    .orderBy(desc(auditEvents.createdAt))
    .limit(5000);
  const lines = [
    ["time", "actor", "action", "resource_type", "resource_id", "metadata"].join(","),
    ...rows.map((r) => [new Date(r.e.createdAt).toISOString(), r.actorEmail, r.e.action, r.e.resourceType, r.e.resourceId, r.e.metadata].map(csvCell).join(",")),
  ];
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="filenest-audit.csv"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
