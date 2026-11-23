import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_A, ACCOUNT_B, login, makeTarget, makeUser, resetDb, setup, uploadFile, db, type Login } from "./helpers.ts";
import { auditEvents, objectDeletions, uploadSessions, files } from "../../src/worker/db/schema.ts";
import { runCleanup } from "../../src/worker/services/cleanup.ts";
import { LEASE_MS } from "../../src/worker/services/uploads.ts";
import { eq } from "drizzle-orm";

let t: ReturnType<typeof setup>;
let admin: Login;

beforeEach(async () => {
  await resetDb();
  t = setup();
  admin = await login(await makeUser({ role: "admin" }));
});

const post = (p: string, b: unknown, method = "POST") => t.call(p, { method, as: admin, body: t.json(b) });

describe("storage targets", () => {
  it("first target becomes default; health check passes against fake R2", async () => {
    const r = await post("/api/admin/storage", { name: "Main", accountId: ACCOUNT_A, bucket: "bucket-a", credentialRef: "a" });
    expect(r.status).toBe(201);
    const created = (await r.json()) as { id: string; credentialsPresent: boolean; credentialRef: string };
    expect(created.credentialRef).toBe("A");
    expect(created.credentialsPresent).toBe(true);
    const list = (await (await t.call("/api/admin/storage", { as: admin })).json()) as { defaultStorageId: string; targets: { isDefault: boolean }[] };
    expect(list.defaultStorageId).toBe(created.id);
    const check = (await (await post(`/api/admin/storage/${created.id}/check`, {})).json()) as { ok: boolean; cors: boolean };
    expect(check).toMatchObject({ ok: true, cors: true });
    // Secrets never appear in admin payloads.
    expect(JSON.stringify(list)).not.toMatch(/test-a-(key|secret)/);
  });

  it("rejects arbitrary endpoints / invalid config", async () => {
    for (const bad of [
      { name: "x", accountId: "evil.com/", bucket: "b-1", credentialRef: "A" },
      { name: "x", accountId: ACCOUNT_A, bucket: "Bad_Bucket", credentialRef: "A" },
      { name: "x", accountId: ACCOUNT_A, bucket: "ok-bucket", credentialRef: "a-b" },
    ]) {
      expect((await post("/api/admin/storage", bad)).status).toBe(400);
    }
  });

  it("missing credentials -> health check reports it without secrets", async () => {
    const id = (await (await post("/api/admin/storage", { name: "C", accountId: ACCOUNT_B, bucket: "bucket-c", credentialRef: "NOPE" })).json()) as { id: string };
    const check = (await (await post(`/api/admin/storage/${id.id}/check`, {})).json()) as { ok: boolean; message: string };
    expect(check.ok).toBe(false);
    expect(check.message).toContain("R2_NOPE_");
  });

  it("in-use target: bucket/account immutable, cannot delete; paused target still serves reads", async () => {
    const a = await makeTarget({ name: "A", accountId: ACCOUNT_A, bucket: "bucket-a", ref: "A", isDefault: true });
    const b = await makeTarget({ name: "B", accountId: ACCOUNT_B, bucket: "bucket-b", ref: "B" });
    const m = await login(await makeUser());
    const { file } = await uploadFile(t, m, "x.txt", "data", { mime: "text/plain" });
    expect((await post(`/api/admin/storage/${a}`, { bucket: "other-bucket" }, "PATCH")).status).toBe(409);
    expect((await post(`/api/admin/storage/${a}`, { acceptingUploads: false }, "PATCH")).status).toBe(409); // is default
    expect((await post("/api/admin/storage-default", { storageId: b }, "PUT")).status).toBe(200);
    expect((await post(`/api/admin/storage/${a}`, { acceptingUploads: false }, "PATCH")).status).toBe(200);
    expect((await t.call(`/api/admin/storage/${a}`, { method: "DELETE", as: admin })).status).toBe(409);
    expect(await (await t.call(`/api/files/${file.id}/download`, { as: m })).text()).toBe("data");
    expect((await post("/api/admin/storage-default", { storageId: a }, "PUT")).status).toBe(409); // not accepting
    const ev = await db().select().from(auditEvents).where(eq(auditEvents.action, "storage.default_switch"));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.actorUserId).toBe(admin.user.id);
    expect(ev[0]!.resourceId).toBe(b);
  });
});

describe("members", () => {
  it("invite, cannot remove last admin, audit", async () => {
    const inv = await post("/api/admin/members", { email: "New@Example.test" });
    expect(inv.status).toBe(201);
    expect(((await inv.json()) as { email: string; status: string })).toMatchObject({ email: "new@example.test", status: "invited" });
    expect((await post("/api/admin/members", { email: "new@example.test" })).status).toBe(409);
    expect((await post(`/api/admin/members/${admin.user.id}`, { role: "member" }, "PATCH")).status).toBe(409);
    const actions = (await db().select().from(auditEvents)).map((e) => e.action);
    expect(actions).toContain("member.invite");
  });
});

describe("cleanup job", () => {
  it("expires stale sessions, deletes unreferenced objects, never deletes live ones", async () => {
    await makeTarget({ name: "A", accountId: ACCOUNT_A, bucket: "bucket-a", ref: "A", isDefault: true });
    const m = await login(await makeUser());
    const { file } = await uploadFile(t, m, "keep.txt", "keep", { mime: "text/plain" });
    const live = (await db().select().from(files).where(eq(files.id, file.id)).get())!;
    // Stale session with an uploaded staging object.
    const r = await t.call("/api/uploads", { method: "POST", as: m, body: t.json({ name: "stale.txt", size: 2, mime: "text/plain" }) });
    const c = (await r.json()) as { uploadId: string; putUrl: string; putHeaders: Record<string, string> };
    await t.s3.fetch(c.putUrl, { method: "PUT", headers: c.putHeaders, body: "zz" });
    // A malicious/buggy queue entry pointing at a live key.
    await db().insert(objectDeletions).values({ id: crypto.randomUUID(), storageId: live.storageId, objectKey: live.objectKey, reason: "test", notBefore: 0, attempts: 0, createdAt: 0 });

    t.clock.t += 3 * 3600_000;
    await runCleanup({ ...t.ctx, deps: { ...t.ctx.deps, now: () => t.clock.t } });
    t.clock.t += LEASE_MS + 2 * 60_000; // final-key deletes wait out any finalizer lease
    await runCleanup({ ...t.ctx, deps: { ...t.ctx.deps, now: () => t.clock.t } });

    const s = (await db().select().from(uploadSessions).where(eq(uploadSessions.id, c.uploadId)).get())!;
    expect(s.state).toBe("expired");
    const keys = await t.s3.store.keys();
    expect(keys.some((k) => k.endsWith(s.stagingKey))).toBe(false);
    expect(keys.some((k) => k.endsWith(live.objectKey))).toBe(true);
    expect(await (await t.call(`/api/files/${file.id}/download`, { as: await login(m.user, t.clock.t) })).text()).toBe("keep");
    expect(await db().select().from(objectDeletions)).toHaveLength(0);
  });
});
