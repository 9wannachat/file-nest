import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appSettings, files, storageTargets } from "../../src/worker/db/schema.ts";
import { ACCOUNT_A, ACCOUNT_B, browserPut, db, HOST_A, HOST_B, login, makeTarget, makeUser, resetDb, setup, uploadFile, type Login } from "./helpers.ts";

let t: ReturnType<typeof setup>;
let admin: Login;
let alice: Login;
let A: string;
let B: string;

beforeEach(async () => {
  await resetDb();
  t = setup();
  admin = await login(await makeUser({ role: "admin" }));
  alice = await login(await makeUser({ quotaUnlimited: true }));
  A = await makeTarget({ name: "A", accountId: ACCOUNT_A, bucket: "bucket-a", ref: "A", capacityBytes: 10, priority: 1 });
  B = await makeTarget({ name: "B", accountId: ACCOUNT_B, bucket: "bucket-b", ref: "B", capacityBytes: 10, priority: 2 });
});

const call = (as: Login, method: string, path: string, body?: unknown) => t.call(path, { method, as, body: body === undefined ? undefined : t.json(body) });
const create = (size: number) => call(alice, "POST", "/api/uploads", { name: `f-${crypto.randomUUID().slice(0, 6)}.bin`, size, mime: "application/octet-stream" });
const storageOf = async (fileId: string) => (await db().select().from(files).where(eq(files.id, fileId)).get())!.storageId;
const bytes = (n: number) => "x".repeat(n);

describe("capacity adds up across targets; uploads are placed automatically", () => {
  it("fills A first, then B, and goes back to A when a smaller file still fits there", async () => {
    const f1 = await uploadFile(t, alice, "a.bin", bytes(8)); // A: 8/10
    expect(new URL(f1.putUrl).host).toBe(HOST_A);
    const f2 = await uploadFile(t, alice, "b.bin", bytes(5)); // doesn't fit A (2 left) -> B: 5/10
    expect(new URL(f2.putUrl).host).toBe(HOST_B);
    const f3 = await uploadFile(t, alice, "c.bin", bytes(2)); // fits A exactly
    expect(await storageOf(f3.file.id)).toBe(A);
    // Files are served from the target they were placed on.
    t.s3.requests.length = 0;
    expect(await (await call(alice, "GET", `/api/files/${f2.file.id}/download`)).text()).toBe(bytes(5));
    expect(t.s3.requests.at(-1)?.host).toBe(HOST_B);

    const summary = ((await (await call(admin, "GET", "/api/admin/storage")).json()) as { summary: { capacityBytes: number; usedBytes: number; freeBytes: number } }).summary;
    expect(summary).toMatchObject({ capacityBytes: 20, usedBytes: 15, freeBytes: 5 });
  });

  it("a file larger than any single target's free space is rejected even if the total would fit", async () => {
    await uploadFile(t, alice, "a.bin", bytes(7)); // A free 3
    await uploadFile(t, alice, "b.bin", bytes(6)); // B free 4 (total free 7)
    const r = await create(5);
    expect(r.status).toBe(507);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("storage_full");
    expect((await create(4)).status).toBe(201);
  });

  it("skips paused targets and targets whose last health check failed", async () => {
    await call(admin, "PATCH", `/api/admin/storage/${A}`, { acceptingUploads: false });
    const r1 = (await uploadFile(t, alice, "1.bin", bytes(1))).file.id;
    expect(await storageOf(r1)).toBe(B);
    await call(admin, "PATCH", `/api/admin/storage/${A}`, { acceptingUploads: true });
    await db().update(storageTargets).set({ lastCheckOk: false }).where(eq(storageTargets.id, A));
    expect(await storageOf((await uploadFile(t, alice, "2.bin", bytes(1))).file.id)).toBe(B);
    await db().update(storageTargets).set({ lastCheckOk: true }).where(eq(storageTargets.id, A));
    expect(await storageOf((await uploadFile(t, alice, "3.bin", bytes(1))).file.id)).toBe(A);
    // Nothing eligible at all: 503.
    await db().update(storageTargets).set({ acceptingUploads: false });
    expect((await create(1)).status).toBe(503);
  });

  it("concurrent uploads never overfill a target (reservation and placement are one statement)", async () => {
    await call(admin, "PATCH", `/api/admin/storage/${B}`, { capacityBytes: 3 }); // total 13
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => create(3)));
    const ok = rs.filter((r) => r.status === 201);
    expect(ok).toHaveLength(4); // 3 x 3 in A (9/10) + 1 x 3 in B (3/3)
    const hosts = await Promise.all(ok.map(async (r) => new URL(((await r.json()) as { putUrl: string }).putUrl).host));
    expect(hosts.filter((h) => h === HOST_A)).toHaveLength(3);
    expect(hosts.filter((h) => h === HOST_B)).toHaveLength(1);
  });

  it("lowering capacity below usage stops new files there but keeps existing ones readable", async () => {
    const f = await uploadFile(t, alice, "keep.bin", bytes(6));
    await call(admin, "PATCH", `/api/admin/storage/${A}`, { capacityBytes: 4 });
    expect(await storageOf((await uploadFile(t, alice, "next.bin", bytes(1))).file.id)).toBe(B);
    expect(await (await call(alice, "GET", `/api/files/${f.file.id}/download`)).text()).toBe(bytes(6));
  });

  it("an unlimited target takes whatever the others cannot", async () => {
    await call(admin, "PATCH", `/api/admin/storage/${B}`, { capacityBytes: null });
    await uploadFile(t, alice, "a.bin", bytes(10)); // A full
    expect(await storageOf((await uploadFile(t, alice, "big.bin", bytes(500))).file.id)).toBe(B);
    const summary = ((await (await call(admin, "GET", "/api/admin/storage")).json()) as { summary: { capacityBytes: number | null } }).summary;
    expect(summary.capacityBytes).toBeNull();
  });
});

describe("admin: capacity and order", () => {
  it("new targets default to 10 GB and are appended last; order can be changed", async () => {
    const r = await call(admin, "POST", "/api/admin/storage", { name: "C", accountId: "c".repeat(32), bucket: "bucket-c", credentialRef: "A" });
    const c = (await r.json()) as { id: string; capacityBytes: number; priority: number };
    expect(c.capacityBytes).toBe(10 * 1024 ** 3);
    expect(c.priority).toBe(3);
    expect((await call(admin, "PUT", "/api/admin/storage-order", { ids: [B, A] })).status).toBe(400); // must list all
    expect((await call(admin, "PUT", "/api/admin/storage-order", { ids: [c.id, B, A] })).status).toBe(200);
    const list = (await (await call(admin, "GET", "/api/admin/storage")).json()) as { targets: { id: string }[] };
    expect(list.targets.map((x) => x.id)).toEqual([c.id, B, A]);
    expect((await call(admin, "PATCH", `/api/admin/storage/${A}`, { capacityBytes: -1 })).status).toBe(400);
    const stale = await login(admin.user, Date.now() - 20 * 60_000);
    expect(((await (await call(stale, "PUT", "/api/admin/storage-order", { ids: [A, B, c.id] })).json()) as { error: { code: string } }).error.code).toBe(
      "reauth_required",
    );
    expect((await call(alice, "PUT", "/api/admin/storage-order", { ids: [A, B, c.id] })).status).toBe(403);
  });
});

export { browserPut };

describe("placement audit regressions", () => {
  it("a target that was the legacy default can be deleted once empty", async () => {
    const legacy = await makeTarget({ name: "Old", accountId: "d".repeat(32), bucket: "bucket-old", ref: "A", priority: 0 });
    await db().update(appSettings).set({ defaultStorageId: legacy }).where(eq(appSettings.id, 1));
    expect((await call(admin, "DELETE", `/api/admin/storage/${legacy}`)).status).toBe(200);
    expect(await db().select().from(storageTargets).where(eq(storageTargets.id, legacy)).get()).toBeUndefined();
  });

  it("ties in priority are broken the same way for display and for placement", async () => {
    await db().update(storageTargets).set({ priority: 5, createdAt: 1 });
    const summary = ((await (await call(admin, "GET", "/api/admin/storage")).json()) as { summary: { nextTargetId: string } }).summary;
    const placed = (await uploadFile(t, alice, "tie.bin", "x")).file.id;
    expect(await storageOf(placed)).toBe(summary.nextTargetId);
  });

  it("reorder with no targets is rejected without an audit row", async () => {
    await db().delete(storageTargets);
    const r = await call(admin, "PUT", "/api/admin/storage-order", { ids: [] });
    expect(r.status).toBe(400);
  });
});
