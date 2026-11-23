import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users } from "../../src/worker/db/schema.ts";
import { runCleanup } from "../../src/worker/services/cleanup.ts";
import { ACCOUNT_A, db, login, makeTarget, makeUser, resetDb, setup, uploadFile, type Login } from "./helpers.ts";

let t: ReturnType<typeof setup>;
let admin: Login;
let bob: Login;

beforeEach(async () => {
  await resetDb();
  t = setup();
  await makeTarget({ name: "A", accountId: ACCOUNT_A, bucket: "bucket-a", ref: "A", isDefault: true });
  admin = await login(await makeUser({ role: "admin" }));
  bob = await login(await makeUser({ name: "Bob" }));
});

const call = (as: Login, method: string, path: string, body?: unknown) => t.call(path, { method, as, body: body === undefined ? undefined : t.json(body) });

describe("access control", () => {
  it("members and API tokens cannot use the console", async () => {
    for (const p of ["/api/admin/overview", "/api/admin/settings", "/api/admin/invitations", "/api/admin/public-links", "/api/admin/members"]) {
      expect((await call(bob, "GET", p)).status, p).toBe(403);
    }
    const tok = (await (await call(admin, "POST", "/api/tokens", { name: "x" })).json()) as { token: string };
    expect((await t.call("/api/admin/overview", { headers: { Authorization: `Bearer ${tok.token}` } })).status).toBe(403);
  });

  it("sensitive actions require a recent sign-in", async () => {
    const stale = await login(admin.user, Date.now() - 20 * 60_000);
    for (const [m, p, b] of [
      ["POST", `/api/admin/members/${bob.user.id}/ban`, { reason: "x" }],
      ["PATCH", `/api/admin/members/${bob.user.id}`, { role: "admin" }],
      ["POST", `/api/admin/members/${bob.user.id}/reset-2fa`, undefined],
      ["POST", `/api/admin/members/${bob.user.id}/password-reset`, undefined],
      ["PUT", "/api/admin/settings", { mfaPolicy: "all" }],
      ["PUT", "/api/admin/storage-default", { storageId: crypto.randomUUID() }],
    ] as [string, string, unknown][]) {
      const r = await call(stale, m, p, b);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("reauth_required");
    }
    // Quota change is not sensitive.
    expect((await call(stale, "PATCH", `/api/admin/members/${bob.user.id}`, { quotaBytes: 1024 })).status).toBe(200);
  });
});

describe("overview and member detail", () => {
  it("shows aggregates and member metadata without private file names", async () => {
    await uploadFile(t, bob, "bobs-private-diary.txt", "secret", { mime: "text/plain" });
    const ov = (await (await call(admin, "GET", "/api/admin/overview")).json()) as { users: { total: number }; files: { count: number; bytes: number } };
    expect(ov.users.total).toBe(2);
    expect(ov.files).toMatchObject({ count: 1, bytes: 6 });
    const detailRes = await call(admin, "GET", `/api/admin/members/${bob.user.id}`);
    const detail = (await detailRes.json()) as { member: { usedBytes: number; fileCount: number } };
    expect(detail.member).toMatchObject({ usedBytes: 6, fileCount: 1 });
    const text = JSON.stringify(detail) + JSON.stringify(ov);
    expect(text).not.toContain("bobs-private-diary");
    const list = (await (await call(admin, "GET", "/api/admin/members?q=bob")).json()) as { members: { name: string }[] };
    expect(list.members.map((m) => m.name)).toEqual(["Bob"]);
  });
});

describe("ban / unban", () => {
  it("ban kills sessions, tokens and public links; unban restores", async () => {
    const tok = (await (await call(bob, "POST", "/api/tokens", { name: "t" })).json()) as { token: string };
    const { file } = await uploadFile(t, bob, "pub.txt", "x", { mime: "text/plain" });
    const link = (await (await call(bob, "POST", `/api/files/${file.id}/sharing/link`)).json()) as { publicLink: { url: string } };
    const path = new URL(link.publicLink.url).pathname;

    expect((await call(admin, "POST", `/api/admin/members/${bob.user.id}/ban`, { reason: "" })).status).toBe(400);
    expect((await call(admin, "POST", `/api/admin/members/${admin.user.id}/ban`, { reason: "self" })).status).toBe(409);
    expect((await call(admin, "POST", `/api/admin/members/${bob.user.id}/ban`, { reason: "abuse", days: 1 })).status).toBe(200);

    expect((await call(bob, "GET", "/api/me")).status).toBe(401);
    expect((await t.call("/api/me", { headers: { Authorization: `Bearer ${tok.token}` } })).status).toBe(401);
    expect((await t.call(path)).status).toBe(404);
    const row = (await db().select().from(users).where(eq(users.id, bob.user.id)).get())!;
    expect(row).toMatchObject({ status: "disabled", bannedReason: "abuse" });

    // Timed ban is lifted by the cleanup job.
    t.clock.t += 2 * 24 * 3600_000;
    await runCleanup({ ...t.ctx, deps: { ...t.ctx.deps, now: () => t.clock.t } });
    expect((await db().select().from(users).where(eq(users.id, bob.user.id)).get())!.status).toBe("active");
    t.clock.t = Date.now();

    await call(admin, "POST", `/api/admin/members/${bob.user.id}/ban`, { reason: "again" });
    expect((await call(admin, "POST", `/api/admin/members/${bob.user.id}/unban`)).status).toBe(200);
    expect((await t.call(path)).status).toBe(200);
  });

  it("revoke sessions / tokens individually", async () => {
    const tok = (await (await call(bob, "POST", "/api/tokens", { name: "t" })).json()) as { token: string };
    await call(admin, "POST", `/api/admin/members/${bob.user.id}/revoke-tokens`);
    expect((await t.call("/api/me", { headers: { Authorization: `Bearer ${tok.token}` } })).status).toBe(401);
    expect((await call(bob, "GET", "/api/me")).status).toBe(200);
    await call(admin, "POST", `/api/admin/members/${bob.user.id}/revoke-sessions`);
    expect((await call(bob, "GET", "/api/me")).status).toBe(401);
  });
});

describe("settings", () => {
  it("validates and takes effect", async () => {
    expect((await call(admin, "PUT", "/api/admin/settings", { googleEnabled: false, passwordEnabled: false })).status).toBe(400);
    expect((await call(admin, "PUT", "/api/admin/settings", { maxUploadBytes: 999_999_999_999 })).status).toBe(400); // above deploy cap
    expect((await call(admin, "PUT", "/api/admin/settings", { unknownKey: 1 })).status).toBe(400);
    expect((await call(admin, "PUT", "/api/admin/settings", { maxUploadBytes: 5 })).status).toBe(200);
    const up = await call(bob, "POST", "/api/uploads", { name: "a.txt", size: 6, mime: "text/plain" });
    expect(up.status).toBe(413);
    expect(((await (await call(bob, "GET", "/api/me")).json()) as { limits: { maxUploadBytes: number } }).limits.maxUploadBytes).toBe(5);
  });

  it("public link policy: off, or password required", async () => {
    const { file } = await uploadFile(t, bob, "p.txt", "x", { mime: "text/plain" });
    const link = (await (await call(bob, "POST", `/api/files/${file.id}/sharing/link`)).json()) as { publicLink: { url: string } };
    const path = new URL(link.publicLink.url).pathname;
    await call(admin, "PUT", "/api/admin/settings", { publicLinksRequirePassword: true });
    expect((await t.call(path)).status).toBe(404);
    await call(bob, "PUT", `/api/files/${file.id}/sharing/link/password`, { password: "link-password-1" });
    expect((await t.call(path)).status).toBe(401); // now just locked behind the password
    await call(admin, "PUT", "/api/admin/settings", { publicLinksEnabled: false });
    expect((await t.call(path)).status).toBe(404);
    expect((await call(bob, "POST", `/api/files/${file.id}/sharing/link`)).status).toBe(403);
  });
});

describe("public link moderation and audit export", () => {
  it("admin can list and revoke public links; CSV neutralises formulas", async () => {
    const { file } = await uploadFile(t, bob, "=HYPERLINK(evil).txt", "x", { mime: "text/plain" });
    const link = (await (await call(bob, "POST", `/api/files/${file.id}/sharing/link`)).json()) as { publicLink: { url: string } };
    const list = (await (await call(admin, "GET", "/api/admin/public-links")).json()) as { links: { id: string; fileName: string }[] };
    expect(list.links).toHaveLength(1);
    expect((await call(admin, "DELETE", `/api/admin/public-links/${list.links[0]!.id}`)).status).toBe(200);
    expect((await t.call(new URL(link.publicLink.url).pathname)).status).toBe(404);

    await call(admin, "POST", `/api/admin/members/${bob.user.id}/ban`, { reason: "=cmd|' /C calc'!A0" });
    const csv = await (await call(admin, "GET", "/api/admin/audit.csv")).text();
    expect(csv.split("\n")[0]).toBe("time,actor,action,resource_type,resource_id,metadata");
    expect(csv).toContain("share.link_admin_revoke");
    expect(csv).not.toMatch(/(^|,)"=/m);
    const filtered = (await (await call(admin, "GET", "/api/admin/audit?action=member.")).json()) as { events: { action: string }[] };
    expect(filtered.events.every((e) => e.action.startsWith("member."))).toBe(true);
  });
});

describe("security-audit regressions", () => {
  it("re-auth also guards admin pre-listing, unban, status changes, 2FA enrollment; invitation links hidden when stale", async () => {
    const stale = await login(admin.user, Date.now() - 20 * 60_000);
    const fresh = admin;
    await call(fresh, "POST", "/api/admin/invitations", { maxUses: 2 });
    await call(fresh, "POST", `/api/admin/members/${bob.user.id}/ban`, { reason: "x" });
    for (const [m, p, b] of [
      ["POST", "/api/admin/members", { email: "new-admin@example.test", role: "admin" }],
      ["POST", `/api/admin/members/${bob.user.id}/unban`, undefined],
      ["PATCH", `/api/admin/members/${bob.user.id}`, { status: "active" }],
      ["POST", "/api/account/2fa/setup", undefined],
    ] as [string, string, unknown][]) {
      expect(((await (await call(stale, m, p, b)).json()) as { error?: { code: string } }).error?.code, `${m} ${p}`).toBe("reauth_required");
    }
    const hidden = (await (await call(stale, "GET", "/api/admin/invitations")).json()) as { invitations: { url: string | null }[]; revealed: boolean };
    expect(hidden.revealed).toBe(false);
    expect(hidden.invitations.every((i) => i.url === null)).toBe(true);
    const shown = (await (await call(fresh, "GET", "/api/admin/invitations")).json()) as { invitations: { url: string | null }[] };
    expect(shown.invitations[0]!.url).toMatch(/\/invite\//);
  });

  it("reset links are refused for Google-only and 2FA members", async () => {
    // bob is Google-only (no password)
    const r = await call(admin, "POST", `/api/admin/members/${bob.user.id}/password-reset`);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("no_password");
    const withMfa = await makeUser({ passwordHash: "pbkdf2_sha256$20000$x", passwordSalt: "x", totpEnabledAt: Date.now(), totpSecretEnc: "x" });
    const r2 = await call(admin, "POST", `/api/admin/members/${withMfa.id}/password-reset`);
    expect(((await r2.json()) as { error: { code: string } }).error.code).toBe("mfa_enabled");
  });

  it("2FA policy blocks API tokens of members who have not enrolled", async () => {
    const tok = (await (await call(bob, "POST", "/api/tokens", { name: "t" })).json()) as { token: string };
    expect((await t.call("/api/me", { headers: { Authorization: `Bearer ${tok.token}` } })).status).toBe(200);
    await call(admin, "PUT", "/api/admin/settings", { mfaPolicy: "all" });
    const r = await t.call("/api/me", { headers: { Authorization: `Bearer ${tok.token}` } });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("mfa_setup_required");
  });

  it("ban revokes API tokens for good (they stay revoked after unban)", async () => {
    const tok = (await (await call(bob, "POST", "/api/tokens", { name: "t" })).json()) as { token: string };
    await call(admin, "POST", `/api/admin/members/${bob.user.id}/ban`, { reason: "x" });
    await call(admin, "POST", `/api/admin/members/${bob.user.id}/unban`);
    expect((await t.call("/api/me", { headers: { Authorization: `Bearer ${tok.token}` } })).status).toBe(401);
  });

  it("two admins banning each other at once never leaves zero active admins", async () => {
    const other = await login(await makeUser({ role: "admin" }));
    await Promise.all([
      call(admin, "POST", `/api/admin/members/${other.user.id}/ban`, { reason: "a" }),
      call(other, "POST", `/api/admin/members/${admin.user.id}/ban`, { reason: "b" }),
    ]);
    const active = (await db().select().from(users)).filter((u) => u.role === "admin" && u.status === "active");
    expect(active.length).toBeGreaterThanOrEqual(1);
  });

  it("cannot switch off every working sign-in method", async () => {
    const { updateSettings } = await import("../../src/worker/services/settings.ts");
    await expect(updateSettings(t.ctx.db, t.ctx.config, admin.user.id, { passwordEnabled: false }, Date.now(), false)).rejects.toThrow(/working sign-in/);
  });
});
