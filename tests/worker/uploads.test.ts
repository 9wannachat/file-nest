import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { files, uploadSessions } from "../../src/worker/db/schema.ts";
import { R2Bucket } from "../../src/worker/storage/s3.ts";
import { ACCOUNT_A, ACCOUNT_B, browserPut, db, enc, HOST_A, HOST_B, login, makeTarget, makeUser, resetDb, setup, testEnv, uploadFile, type Login } from "./helpers.ts";
import { loadConfig } from "../../src/worker/env.ts";
import { LEASE_MS } from "../../src/worker/services/uploads.ts";
import { runCleanup } from "../../src/worker/services/cleanup.ts";

let t: ReturnType<typeof setup>;
let alice: Login;
let targetA: string;

beforeEach(async () => {
  await resetDb();
  t = setup();
  targetA = await makeTarget({ name: "A", accountId: ACCOUNT_A, bucket: "bucket-a", ref: "A", isDefault: true });
  alice = await login(await makeUser());
});

async function create(as: Login, body: Record<string, unknown>) {
  const r = await t.call("/api/uploads", { method: "POST", as, body: t.json({ mime: "text/plain", ...body }) });
  return { status: r.status, body: (await r.json()) as { uploadId: string; putUrl: string; putHeaders: Record<string, string>; error?: { code: string } } };
}
const finalize = (as: Login, id: string) => t.call(`/api/uploads/${id}/finalize`, { method: "POST", as });

describe("create upload session", () => {
  it("presigns PUT for the staging key only, with short expiry", async () => {
    const { status, body } = await create(alice, { name: "a.txt", size: 3 });
    expect(status).toBe(201);
    const u = new URL(body.putUrl);
    expect(u.host).toBe(HOST_A);
    expect(u.pathname).toMatch(/^\/bucket-a\/staging\//);
    expect(Number(u.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(900);
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toContain("content-type");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
    expect(body.putHeaders).not.toHaveProperty("Content-Length"); // browsers set it themselves
    const s = await db().select().from(uploadSessions).where(eq(uploadSessions.id, body.uploadId)).get();
    expect(s?.finalKey).toMatch(/^files\//);
    expect(body.putUrl).not.toContain(s!.finalKey);
  });

  it("enforces max size, quota and rate limit", async () => {
    expect((await create(alice, { name: "big", size: 10485761 })).status).toBe(413);
    const small = await login(await makeUser({ quotaBytes: 10 }));
    expect((await create(small, { name: "a", size: 6 })).status).toBe(201);
    const over = await create(small, { name: "b", size: 6 }); // reserved 6 + 6 > 10
    expect(over.status).toBe(413);
    expect(over.body.error?.code).toBe("quota_exceeded");
    for (let i = 0; i < 49; i++) await create(alice, { name: `r${i}`, size: 0 });
    expect((await create(alice, { name: "r50", size: 0 })).status).toBe(201);
    expect((await create(alice, { name: "r51", size: 0 })).status).toBe(429);
  });

  it("rejects client-chosen bucket/key and bad names", async () => {
    const { body } = await create(alice, { name: "a.txt", size: 1, bucket: "other", key: "files/evil", storageId: "x" });
    const s = await db().select().from(uploadSessions).where(eq(uploadSessions.id, body.uploadId)).get();
    expect(s?.storageId).toBe(targetA);
    expect(s?.stagingKey).toMatch(/^staging\/[0-9a-f-]{36}$/);
    expect((await create(alice, { name: "../x", size: 1 })).status).toBe(400);
  });

  it("503 when no storage accepts uploads", async () => {
    await testEnv.DB.prepare("UPDATE storage_targets SET accepting_uploads = 0").run();
    expect((await create(alice, { name: "a", size: 1 })).status).toBe(503);
  });
});

describe("finalize", () => {
  it("happy path: file appears only after finalize", async () => {
    const { body } = await create(alice, { name: "hello.txt", size: 5 });
    await browserPut(t.s3, body.putUrl, body.putHeaders, "hello");
    const before = (await (await t.call("/api/folders/root", { as: alice })).json()) as { files: unknown[] };
    expect(before.files).toHaveLength(0);
    const r = await finalize(alice, body.uploadId);
    expect(r.status).toBe(200);
    const { file } = (await r.json()) as { file: { id: string; inline: boolean; contentType: string } };
    expect(file.inline).toBe(true);
    expect(file.contentType).toBe("text/plain; charset=utf-8");
    const dl = await t.call(`/api/files/${file.id}/download`, { as: alice });
    expect(await dl.text()).toBe("hello");
  });

  it("incomplete upload cannot finalize (missing or short)", async () => {
    const { body } = await create(alice, { name: "x.txt", size: 10 });
    const r1 = await finalize(alice, body.uploadId);
    expect(r1.status).toBe(409);
    expect(((await r1.json()) as { error: { code: string } }).error.code).toBe("upload_incomplete");
    await browserPut(t.s3, body.putUrl, body.putHeaders, "short");
    const r2 = await finalize(alice, body.uploadId);
    expect(r2.status).toBe(422);
    expect((await db().select().from(files)).length).toBe(0);
  });

  it("non-owner cannot finalize", async () => {
    const { body } = await create(alice, { name: "x.txt", size: 2 });
    await browserPut(t.s3, body.putUrl, body.putHeaders, "hi");
    const mallory = await login(await makeUser());
    expect((await finalize(mallory, body.uploadId)).status).toBe(404);
    expect((await finalize(alice, body.uploadId)).status).toBe(200);
  });

  it("repeated and concurrent finalize create exactly one file", async () => {
    const { body } = await create(alice, { name: "c.txt", size: 2 });
    await browserPut(t.s3, body.putUrl, body.putHeaders, "ok");
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => finalize(alice, body.uploadId)));
    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 200 || s === 202)).toBe(true);
    expect(statuses).toContain(200);
    expect((await finalize(alice, body.uploadId)).status).toBe(200);
    expect((await db().select().from(files)).length).toBe(1);
  });

  it("re-writing staging after finalize does not change the published file", async () => {
    const { body } = await create(alice, { name: "p.txt", size: 8 });
    await browserPut(t.s3, body.putUrl, body.putHeaders, "original");
    const { file } = (await (await finalize(alice, body.uploadId)).json()) as { file: { id: string } };
    const again = await browserPut(t.s3, body.putUrl, body.putHeaders, "TAMPERED");
    expect(again.ok).toBe(true); // URL still valid; staging overwritten
    expect((await finalize(alice, body.uploadId)).status).toBe(200);
    expect(await (await t.call(`/api/files/${file.id}/download`, { as: alice })).text()).toBe("original");
  });

  it("copy is guarded by the source ETag", async () => {
    const { body } = await create(alice, { name: "g.txt", size: 2 });
    await browserPut(t.s3, body.putUrl, body.putHeaders, "v1");
    const s = (await db().select().from(uploadSessions).where(eq(uploadSessions.id, body.uploadId)).get())!;
    const bucket = new R2Bucket({ accountId: ACCOUNT_A, bucket: "bucket-a", credentialRef: "A" }, testEnv, loadConfig(testEnv), t.s3.fetch);
    const head = (await bucket.head(s.stagingKey))!;
    await browserPut(t.s3, body.putUrl, body.putHeaders, "v2"); // overwritten between check and copy
    expect(await bucket.copyIfMatch(s.stagingKey, s.finalKey, head.etag)).toBe("precondition_failed");
    expect(await bucket.head(s.finalKey)).toBeNull();
  });

  it("recovers when R2 copy succeeded but D1 write did not", async () => {
    const { body } = await create(alice, { name: "r.txt", size: 2 });
    await browserPut(t.s3, body.putUrl, body.putHeaders, "ok");
    const s = (await db().select().from(uploadSessions).where(eq(uploadSessions.id, body.uploadId)).get())!;
    const bucket = new R2Bucket({ accountId: ACCOUNT_A, bucket: "bucket-a", credentialRef: "A" }, testEnv, loadConfig(testEnv), t.s3.fetch);
    const head = (await bucket.head(s.stagingKey))!;
    await bucket.copyIfMatch(s.stagingKey, s.finalKey, head.etag); // first attempt copied...
    // ...then crashed holding a lease.
    await db().update(uploadSessions).set({ state: "finalizing", leaseUntil: t.clock.t + LEASE_MS }).where(eq(uploadSessions.id, s.id));
    expect((await finalize(alice, s.id)).status).toBe(202); // lease still held
    t.clock.t += LEASE_MS + 1000;
    const copiesBefore = t.s3.requests.filter((r) => r.method === "PUT" && !r.presigned).length;
    const r = await finalize(alice, s.id);
    expect(r.status).toBe(200);
    expect(t.s3.requests.filter((r) => r.method === "PUT" && !r.presigned).length).toBe(copiesBefore); // no second copy
    expect((await db().select().from(files)).length).toBe(1);
  });

  it("fencing: if cleanup expires the session mid-copy, no file row is created and nothing live is deleted", async () => {
    let fired = false;
    t = setup({
      beforeS3: async (req) => {
        if (fired || req.method !== "PUT" || !req.headers.get("x-amz-copy-source")) return;
        fired = true;
        // Simulate a copy that outlives the lease and the session window, with cleanup running meanwhile.
        t.clock.t += 3 * 3600_000;
        await runCleanup({ ...t.ctx, deps: { ...t.ctx.deps, now: () => t.clock.t } });
      },
    });
    const { body } = await create(alice, { name: "slow.txt", size: 4 });
    await browserPut(t.s3, body.putUrl, body.putHeaders, "slow");
    const r = await finalize(alice, body.uploadId);
    expect([409, 410]).toContain(r.status);
    expect(await db().select().from(files)).toHaveLength(0);
    const s = (await db().select().from(uploadSessions).where(eq(uploadSessions.id, body.uploadId)).get())!;
    expect(s.state).toBe("expired");
  });

  it("HTML disguised as PNG is stored as non-inline octet-stream", async () => {
    const { file } = await uploadFile(t, alice, "cat.png", "<html><script>alert(1)</script></html>", { mime: "image/png" });
    expect(file.inline).toBe(false);
    expect(file.contentType).toBe("application/octet-stream");
  });

  it("name collisions get a suffix", async () => {
    await uploadFile(t, alice, "dup.txt", "1", { mime: "text/plain" });
    const { file } = await uploadFile(t, alice, "dup.txt", "2", { mime: "text/plain" });
    expect(file.name).toBe("dup (2).txt");
  });
});

describe("dynamic R2 default", () => {
  it("A then switch to B: both files in one Drive, each from its own target; open sessions stay pinned", async () => {
    const admin = await login(await makeUser({ role: "admin" }));
    const targetB = await makeTarget({ name: "B", accountId: ACCOUNT_B, bucket: "bucket-b", ref: "B" });
    const fa = await uploadFile(t, alice, "on-a.txt", "AAA", { mime: "text/plain" });
    const pending = await create(alice, { name: "mid.txt", size: 3 }); // session opened on A

    const sw = await t.call("/api/admin/storage-default", { method: "PUT", as: admin, body: t.json({ storageId: targetB }) });
    expect(sw.status).toBe(200);

    expect(new URL(pending.body.putUrl).host).toBe(HOST_A);
    await browserPut(t.s3, pending.body.putUrl, pending.body.putHeaders, "MID");
    const fm = ((await (await finalize(alice, pending.body.uploadId)).json()) as { file: { id: string } }).file;

    const fb = await uploadFile(t, alice, "on-b.txt", "BBB", { mime: "text/plain" });
    expect(new URL(fb.putUrl).host).toBe(HOST_B);

    const rows = await db().select().from(files);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.storageId]));
    expect(byId[fa.file.id]).toBe(targetA);
    expect(byId[fm.id]).toBe(targetA);
    expect(byId[fb.file.id]).toBe(targetB);

    const list = (await (await t.call("/api/folders/root", { as: alice })).json()) as { files: { name: string }[] };
    expect(list.files.map((f) => f.name).sort()).toEqual(["mid.txt", "on-a.txt", "on-b.txt"]);

    t.s3.requests.length = 0;
    expect(await (await t.call(`/api/files/${fa.file.id}/download`, { as: alice })).text()).toBe("AAA");
    expect(t.s3.requests.at(-1)?.host).toBe(HOST_A);
    expect(t.s3.requests.at(-1)?.accessKeyId).toBe("test-a-key");
    expect(await (await t.call(`/api/files/${fb.file.id}/download`, { as: alice })).text()).toBe("BBB");
    expect(t.s3.requests.at(-1)?.host).toBe(HOST_B);
    expect(t.s3.requests.at(-1)?.accessKeyId).toBe("test-b-key");
  });
});

export { enc };
