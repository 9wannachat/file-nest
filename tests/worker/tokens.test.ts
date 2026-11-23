import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { apiTokens, auditEvents } from "../../src/worker/db/schema.ts";
import { TOKEN_RATE_PER_MINUTE } from "../../src/worker/services/tokens.ts";
import { ACCOUNT_A, browserPut, db, login, makeTarget, makeUser, resetDb, setup, uploadFile, type Login } from "./helpers.ts";

let t: ReturnType<typeof setup>;
let alice: Login;

beforeEach(async () => {
  await resetDb();
  t = setup();
  await makeTarget({ name: "A", accountId: ACCOUNT_A, bucket: "bucket-a", ref: "A", isDefault: true });
  alice = await login(await makeUser());
});

async function mint(as: Login, body: Record<string, unknown> = { name: "mcp" }) {
  const r = await t.call("/api/tokens", { method: "POST", as, body: t.json(body) });
  return { status: r.status, body: (await r.json()) as { token: string; info: { id: string; scopes: string[] } } };
}
const bearer = (token: string, path: string, init: RequestInit = {}) =>
  t.call(path, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });

describe("personal access tokens", () => {
  it("shown once, stored hashed, listed without the secret, audited", async () => {
    const { status, body } = await mint(alice);
    expect(status).toBe(201);
    expect(body.token).toMatch(/^fnpat_[A-Za-z0-9_-]{43}$/);
    const row = (await db().select().from(apiTokens).where(eq(apiTokens.id, body.info.id)).get())!;
    expect(row.tokenHash).not.toContain(body.token);
    const list = await (await t.call("/api/tokens", { as: alice })).text();
    expect(list).not.toContain(body.token);
    const audit = await db().select().from(auditEvents);
    expect(audit.map((a) => a.action)).toContain("token.create");
    expect(JSON.stringify(audit)).not.toContain(body.token);
  });

  it("acts as its owner on allowlisted endpoints without CSRF/Origin", async () => {
    const { body } = await mint(alice);
    const f = await uploadFile(t, alice, "a.txt", "hello", { mime: "text/plain" });
    const me = (await (await bearer(body.token, "/api/me")).json()) as { user: { id: string }; csrfToken: null; auth: string };
    expect(me).toMatchObject({ user: { id: alice.user.id }, csrfToken: null, auth: "token" });
    expect((await bearer(body.token, "/api/folders/root")).status).toBe(200);
    expect(await (await bearer(body.token, `/api/files/${f.file.id}/download`)).text()).toBe("hello");
    const ranged = await bearer(body.token, `/api/files/${f.file.id}/download`, { headers: { Range: "bytes=1-2" } });
    expect(ranged.status).toBe(206);
    expect((await bearer(body.token, "/api/folders", { method: "POST", body: t.json({ name: "via-token" }), headers: { "Content-Type": "application/json" } })).status).toBe(201);
  });

  it("upload + finalize via token", async () => {
    const { body } = await mint(alice);
    const r = await bearer(body.token, "/api/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: t.json({ name: "cut.mp4", size: 3, mime: "application/octet-stream" }),
    });
    expect(r.status).toBe(201);
    const c = (await r.json()) as { uploadId: string; putUrl: string; putHeaders: Record<string, string> };
    await browserPut(t.s3, c.putUrl, c.putHeaders, "abc");
    expect((await bearer(body.token, `/api/uploads/${c.uploadId}/finalize`, { method: "POST" })).status).toBe(200);
  });

  it("never reaches sharing, trash, rename, admin or token management", async () => {
    const admin = await login(await makeUser({ role: "admin" }));
    const { body } = await mint(admin);
    const f = await uploadFile(t, admin, "x.txt", "x", { mime: "text/plain" });
    for (const [m, p] of [
      ["GET", `/api/files/${f.file.id}/sharing`],
      ["POST", `/api/files/${f.file.id}/sharing/link`],
      ["POST", `/api/files/${f.file.id}/trash`],
      ["DELETE", `/api/files/${f.file.id}`],
      ["PATCH", `/api/files/${f.file.id}`],
      ["GET", "/api/admin/members"],
      ["PUT", "/api/admin/storage-default"],
      ["GET", "/api/tokens"],
      ["POST", "/api/tokens"],
      ["GET", "/api/trash"],
    ]) {
      const r = await bearer(body.token, p!, { method: m, headers: { "Content-Type": "application/json" }, body: m === "GET" ? undefined : "{}" });
      expect(r.status, `${m} ${p}`).toBe(403);
    }
  });

  it("respects authorization: cannot read another member's private file", async () => {
    const bob = await login(await makeUser());
    const f = await uploadFile(t, bob, "bob.txt", "b", { mime: "text/plain" });
    const { body } = await mint(alice);
    expect((await bearer(body.token, `/api/files/${f.file.id}/download`)).status).toBe(404);
    expect((await bearer(body.token, `/api/files/${f.file.id}/download`, { method: "HEAD" })).status).toBe(404);
  });

  it("read-only scope cannot write", async () => {
    const { body } = await mint(alice, { name: "ro", scopes: ["files:read"] });
    expect((await bearer(body.token, "/api/folders/root")).status).toBe(200);
    const r = await bearer(body.token, "/api/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: t.json({ name: "x" }) });
    expect(r.status).toBe(403);
  });

  it("revoked, expired, disabled-owner and malformed tokens are rejected", async () => {
    const a = await mint(alice);
    await t.call(`/api/tokens/${a.body.info.id}`, { method: "DELETE", as: alice });
    expect((await bearer(a.body.token, "/api/me")).status).toBe(401);

    const b = await mint(alice, { name: "short", expiresInDays: 1 });
    t.clock.t += 2 * 24 * 3600_000;
    expect((await bearer(b.body.token, "/api/me")).status).toBe(401);
    t.clock.t = Date.now();

    const c = await mint(alice, { name: "c" });
    const admin = await login(await makeUser({ role: "admin" }));
    await t.call(`/api/admin/members/${alice.user.id}`, { method: "PATCH", as: admin, body: t.json({ status: "disabled" }) });
    expect((await bearer(c.body.token, "/api/me")).status).toBe(401);

    expect((await bearer("fnpat_short", "/api/me")).status).toBe(401);
    expect((await t.call("/api/me", { headers: { Authorization: "Basic abc" } })).status).toBe(401);
  });

  it("cookie + bearer together is rejected", async () => {
    const { body } = await mint(alice);
    const r = await t.call("/api/me", { headers: { Cookie: alice.cookie, Authorization: `Bearer ${body.token}` } });
    expect(r.status).toBe(400);
  });

  it("validates input and rate limits per token", async () => {
    expect((await mint(alice, { name: "" })).status).toBe(400);
    expect((await mint(alice, { name: "x", scopes: ["admin"] })).status).toBe(400);
    expect((await mint(alice, { name: "x", expiresInDays: 999 })).status).toBe(400);
    const { body } = await mint(alice);
    await db().update(apiTokens).set({ windowStart: t.clock.t, windowCount: TOKEN_RATE_PER_MINUTE }).where(eq(apiTokens.id, body.info.id));
    expect((await bearer(body.token, "/api/me")).status).toBe(429);
    t.clock.t += 61_000;
    expect((await bearer(body.token, "/api/me")).status).toBe(200);
  });
});
