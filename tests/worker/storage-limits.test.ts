import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditEvents, objectDeletions } from "../../src/worker/db/schema.ts";
import { ACCOUNT_A, browserPut, db, login, makeTarget, makeUser, resetDb, setup, uploadFile, type Login } from "./helpers.ts";

let t: ReturnType<typeof setup>;
let admin: Login;
let alice: Login;

beforeEach(async () => {
  await resetDb();
  t = setup();
  await makeTarget({ name: "A", accountId: ACCOUNT_A, bucket: "bucket-a", ref: "A", isDefault: true });
  admin = await login(await makeUser({ role: "admin" }));
  alice = await login(await makeUser({ quotaBytes: 10 }));
});

const call = (as: Login, method: string, path: string, body?: unknown) => t.call(path, { method, as, body: body === undefined ? undefined : t.json(body) });
const create = (as: Login, size: number, name = `f-${crypto.randomUUID().slice(0, 6)}.bin`) => call(as, "POST", "/api/uploads", { name, size, mime: "application/octet-stream" });
const me = async (as: Login) =>
  ((await (await call(as, "GET", "/api/me")).json()) as { user: { usedBytes: number; trashedBytes: number; quotaBytes: number; quotaUnlimited: boolean } }).user;

describe("member quota", () => {
  it("unlimited members are not bound by their byte quota", async () => {
    expect((await create(alice, 20)).status).toBe(413);
    expect((await call(admin, "PATCH", `/api/admin/members/${alice.user.id}`, { quotaBytes: null })).status).toBe(200);
    expect((await me(alice)).quotaUnlimited).toBe(true);
    expect((await create(alice, 20)).status).toBe(201);
    await call(admin, "PATCH", `/api/admin/members/${alice.user.id}`, { quotaBytes: 10 });
    expect((await me(alice)).quotaUnlimited).toBe(false);
  });

  it("lowering a quota below usage keeps files but blocks new uploads", async () => {
    const { file } = await uploadFile(t, alice, "eight.bin", "12345678");
    expect((await call(admin, "PATCH", `/api/admin/members/${alice.user.id}`, { quotaBytes: 4 })).status).toBe(200);
    expect((await create(alice, 1)).status).toBe(413);
    expect(await (await call(alice, "GET", `/api/files/${file.id}/download`)).text()).toBe("12345678");
    const ev = (await db().select().from(auditEvents).where(eq(auditEvents.action, "member.update"))).at(-1)!;
    expect(JSON.parse(ev.metadata!)).toMatchObject({ previousQuota: 10, newQuota: 4 });
  });

  it("trash counts toward quota; Empty trash frees it and queues object deletes", async () => {
    const { file } = await uploadFile(t, alice, "nine.bin", "123456789");
    await call(alice, "POST", `/api/files/${file.id}/trash`);
    expect(await me(alice)).toMatchObject({ usedBytes: 9, trashedBytes: 9 });
    expect((await create(alice, 5)).status).toBe(413);
    const r = (await (await call(alice, "POST", "/api/trash/empty")).json()) as { purged: number; remaining: number };
    expect(r).toEqual({ purged: 1, remaining: 0 });
    expect(await me(alice)).toMatchObject({ usedBytes: 0, trashedBytes: 0 });
    expect(await db().select().from(objectDeletions).where(eq(objectDeletions.reason, "purge"))).toHaveLength(1);
    expect((await create(alice, 5)).status).toBe(201);
  });

  it("Empty trash only touches the caller's own trash", async () => {
    const bob = await login(await makeUser());
    const { file } = await uploadFile(t, bob, "b.bin", "b");
    await call(bob, "POST", `/api/files/${file.id}/trash`);
    await call(alice, "POST", "/api/trash/empty");
    expect(((await (await call(bob, "GET", "/api/trash")).json()) as { files: unknown[] }).files).toHaveLength(1);
  });
});

describe("admin usage", () => {
  it("lists usage with filters, bulk-sets quotas, and is admin-only", async () => {
    const bob = await login(await makeUser({ quotaBytes: 100 }));
    await uploadFile(t, alice, "nine.bin", "123456789"); // 90% of 10
    await uploadFile(t, bob, "one.bin", "1"); // 1%
    const all = (await (await call(admin, "GET", "/api/admin/usage")).json()) as { members: { id: string; usedBytes: number; percent: number | null }[]; totalBytes: number };
    expect(all.totalBytes).toBe(10);
    expect(all.members[0]!.id).toBe(alice.user.id); // sorted by usage
    const near = (await (await call(admin, "GET", "/api/admin/usage?filter=near")).json()) as { members: { id: string }[] };
    expect(near.members.map((m) => m.id)).toEqual([alice.user.id]);

    const r = await call(admin, "POST", "/api/admin/members/bulk-quota", { userIds: [alice.user.id, bob.user.id], quotaBytes: null });
    expect(((await r.json()) as { updated: number }).updated).toBe(2);
    expect((await me(alice)).quotaUnlimited).toBe(true);
    expect((await call(admin, "POST", "/api/admin/members/bulk-quota", { userIds: [], quotaBytes: 5 })).status).toBe(400);

    const ov = (await (await call(admin, "GET", "/api/admin/overview")).json()) as { capacity: { capBytes: number | null } };
    expect(ov.capacity.capBytes).toBeNull(); // the test target is unlimited

    expect((await call(alice, "GET", "/api/admin/usage")).status).toBe(403);
    expect((await call(alice, "POST", "/api/admin/members/bulk-quota", { userIds: [alice.user.id], quotaBytes: null })).status).toBe(403);
  });
});

export { browserPut };

describe("storage-limit audit regressions", () => {
  it("bulk quota is validated, atomic and re-auth protected; unlimited via PATCH needs re-auth", async () => {
    const before = (await db().select().from(auditEvents)).length;
    expect((await call(admin, "POST", "/api/admin/members/bulk-quota", { userIds: [alice.user.id] })).status).toBe(400);
    expect((await call(admin, "POST", "/api/admin/members/bulk-quota", { userIds: [alice.user.id], quotaBytes: -5 })).status).toBe(400);
    expect((await db().select().from(auditEvents)).length).toBe(before);

    const many = await Promise.all(Array.from({ length: 30 }, () => makeUser()));
    const r = await call(admin, "POST", "/api/admin/members/bulk-quota", { userIds: [...many.map((u) => u.id), alice.user.id], quotaBytes: 2048 });
    expect(((await r.json()) as { updated: number }).updated).toBe(31);
    const audits = (await db().select().from(auditEvents)).filter((e) => e.resourceId === alice.user.id && e.action === "member.update");
    expect(JSON.parse(audits.at(-1)!.metadata!)).toMatchObject({ bulk: true, previousQuota: 10, newQuota: 2048 });

    const stale = await login(admin.user, Date.now() - 20 * 60_000);
    const code = async (r: Response) => ((await r.json()) as { error?: { code: string } }).error?.code;
    expect(await code(await call(stale, "POST", "/api/admin/members/bulk-quota", { userIds: [alice.user.id], quotaBytes: null }))).toBe("reauth_required");
    expect(await code(await call(stale, "PATCH", `/api/admin/members/${alice.user.id}`, { quotaBytes: null }))).toBe("reauth_required");
    expect((await call(stale, "PATCH", `/api/admin/members/${alice.user.id}`, { quotaBytes: 4096 })).status).toBe(200);
  });

  it("expired pending uploads stop holding quota even before cleanup runs", async () => {
    expect((await create(alice, 8)).status).toBe(201); // reserved, never uploaded
    expect((await create(alice, 8)).status).toBe(413);
    t.clock.t += 3 * 3600_000; // session window (2 h) passed; cron has not run
    expect((await create(alice, 8)).status).toBe(201);
  });

  it("repeated rejected creates are throttled", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await create(alice, 1000)).status);
    expect(statuses.slice(0, 19).every((s) => s === 413)).toBe(true);
    expect(statuses).toContain(429);
    expect((await create(alice, 1)).status).toBe(429); // throttled before any scan
  });

  it("Empty trash works in chunks and reports what is left", async () => {
    await call(admin, "PATCH", `/api/admin/members/${alice.user.id}`, { quotaBytes: 10_000 });
    for (let i = 0; i < 25; i++) {
      const f = await call(alice, "POST", "/api/folders", { name: `d${i}` });
      const { id } = (await f.json()) as { id: string };
      await call(alice, "POST", `/api/folders/${id}/trash`);
    }
    const first = (await (await call(alice, "POST", "/api/trash/empty")).json()) as { purged: number; remaining: number };
    expect(first).toEqual({ purged: 20, remaining: 5 });
    const second = (await (await call(alice, "POST", "/api/trash/empty")).json()) as { purged: number; remaining: number };
    expect(second).toEqual({ purged: 5, remaining: 0 });
  });
});
