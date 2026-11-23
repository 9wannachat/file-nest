import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_A, login, makeTarget, makeUser, resetDb, setup, uploadFile, type Login } from "./helpers.ts";

let t: ReturnType<typeof setup>;
let alice: Login;
let bob: Login;
let admin: Login;
let fileId: string;
let folderId: string;

beforeEach(async () => {
  await resetDb();
  t = setup();
  await makeTarget({ name: "A", accountId: ACCOUNT_A, bucket: "bucket-a", ref: "A", isDefault: true });
  alice = await login(await makeUser({ name: "Alice" }));
  bob = await login(await makeUser({ name: "Bob" }));
  admin = await login(await makeUser({ role: "admin" }));
  const f = await t.call("/api/folders", { method: "POST", as: alice, body: t.json({ name: "Private" }) });
  folderId = ((await f.json()) as { id: string }).id;
  fileId = (await uploadFile(t, alice, "secret.txt", "alice secret", { mime: "text/plain", folderId })).file.id;
});

describe("member B cannot touch member A's private file by direct ID", () => {
  it.each(["GET", "HEAD"])("%s preview/download/metadata -> 404", async (method) => {
    for (const p of [`/api/files/${fileId}`, `/api/files/${fileId}/preview`, `/api/files/${fileId}/download`]) {
      expect((await t.call(p, { method, as: bob })).status, p).toBe(404);
    }
  });

  it("Range request -> 404 and no R2 read", async () => {
    const before = t.s3.requests.filter((r) => r.method === "GET").length;
    const r = await t.call(`/api/files/${fileId}/download`, { as: bob, headers: { Range: "bytes=0-3" } });
    expect(r.status).toBe(404);
    expect(t.s3.requests.filter((r) => r.method === "GET").length).toBe(before);
  });

  it("search does not reveal it", async () => {
    const r = (await (await t.call("/api/search?q=secret", { as: bob })).json()) as { files: unknown[]; folders: unknown[] };
    expect(r.files).toHaveLength(0);
    const a = (await (await t.call("/api/search?q=secret", { as: alice })).json()) as { files: unknown[] };
    expect(a.files).toHaveLength(1);
  });

  it("all mutations -> 404", async () => {
    const calls: [string, string, unknown?][] = [
      ["PATCH", `/api/files/${fileId}`, { name: "pwned.txt" }],
      ["PATCH", `/api/files/${fileId}`, { folderId: null }],
      ["POST", `/api/files/${fileId}/trash`],
      ["POST", `/api/files/${fileId}/restore`],
      ["DELETE", `/api/files/${fileId}`],
      ["GET", `/api/files/${fileId}/sharing`],
      ["PUT", `/api/files/${fileId}/sharing/members`, { userIds: [bob.user.id] }],
      ["POST", `/api/files/${fileId}/sharing/link`],
      ["DELETE", `/api/files/${fileId}/sharing/link`],
      ["GET", `/api/folders/${folderId}`],
      ["PATCH", `/api/folders/${folderId}`, { name: "x" }],
      ["POST", `/api/folders/${folderId}/trash`],
      ["POST", "/api/folders", { name: "inside", parentId: folderId }],
      ["POST", "/api/uploads", { name: "drop.txt", size: 1, folderId }],
    ];
    for (const [method, path, body] of calls) {
      const r = await t.call(path, { method, as: bob, body: body ? t.json(body) : undefined });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    // Bob cannot move his own file into Alice's folder either.
    const own = (await uploadFile(t, bob, "b.txt", "b")).file.id;
    expect((await t.call(`/api/files/${own}`, { method: "PATCH", as: bob, body: t.json({ folderId }) })).status).toBe(404);
  });

  it("Admin role grants no access to private files", async () => {
    expect((await t.call(`/api/files/${fileId}/download`, { as: admin })).status).toBe(404);
    expect((await t.call(`/api/files/${fileId}`, { method: "PATCH", as: admin, body: t.json({ name: "x" }) })).status).toBe(404);
  });
});

describe("member sharing = read + download only", () => {
  it("shared member reads but cannot manage", async () => {
    const s = await t.call(`/api/files/${fileId}/sharing/members`, { method: "PUT", as: alice, body: t.json({ userIds: [bob.user.id] }) });
    expect(s.status).toBe(200);
    expect((await t.call(`/api/files/${fileId}/download`, { as: bob })).status).toBe(200);
    expect((await t.call(`/api/files/${fileId}/preview`, { method: "HEAD", as: bob })).status).toBe(200);
    const shared = (await (await t.call("/api/shared", { as: bob })).json()) as { files: { id: string; folderId: string | null }[] };
    expect(shared.files.map((f) => f.id)).toEqual([fileId]);
    expect(shared.files[0]!.folderId).toBeNull(); // does not leak owner's folder structure
    expect((await t.call(`/api/files/${fileId}`, { method: "PATCH", as: bob, body: t.json({ name: "x" }) })).status).toBe(404);
    expect((await t.call(`/api/files/${fileId}/trash`, { method: "POST", as: bob })).status).toBe(404);
    expect((await t.call(`/api/files/${fileId}/sharing/link`, { method: "POST", as: bob })).status).toBe(404);
    // Revoking share removes access immediately.
    await t.call(`/api/files/${fileId}/sharing/members`, { method: "PUT", as: alice, body: t.json({ userIds: [] }) });
    expect((await t.call(`/api/files/${fileId}/download`, { as: bob })).status).toBe(404);
  });

  it("trashed file is not readable by shared members", async () => {
    await t.call(`/api/files/${fileId}/sharing/members`, { method: "PUT", as: alice, body: t.json({ userIds: [bob.user.id] }) });
    await t.call(`/api/folders/${folderId}/trash`, { method: "POST", as: alice });
    expect((await t.call(`/api/files/${fileId}/download`, { as: bob })).status).toBe(404);
  });
});

describe("admin API", () => {
  it("members cannot use admin endpoints or switch R2", async () => {
    const id = crypto.randomUUID();
    for (const [m, p, b] of [
      ["GET", "/api/admin/members"],
      ["POST", "/api/admin/members", { email: "x@example.test" }],
      ["GET", "/api/admin/storage"],
      ["PUT", "/api/admin/storage-default", { storageId: id }],
      ["POST", "/api/admin/storage", { name: "x", accountId: ACCOUNT_A, bucket: "zzz", credentialRef: "A" }],
      ["GET", "/api/admin/audit"],
    ] as [string, string, unknown?][]) {
      expect((await t.call(p, { method: m, as: bob, body: b ? t.json(b) : undefined })).status, `${m} ${p}`).toBe(403);
    }
  });
});

describe("disabled owner", () => {
  it("shared members lose access when the owner is disabled", async () => {
    await t.call(`/api/files/${fileId}/sharing/members`, { method: "PUT", as: alice, body: t.json({ userIds: [bob.user.id] }) });
    expect((await t.call(`/api/files/${fileId}/download`, { as: bob })).status).toBe(200);
    await t.call(`/api/admin/members/${alice.user.id}`, { method: "PATCH", as: admin, body: t.json({ status: "disabled" }) });
    expect((await t.call(`/api/files/${fileId}/download`, { as: bob })).status).toBe(404);
    const shared = (await (await t.call("/api/shared", { as: bob })).json()) as { files: unknown[] };
    expect(shared.files).toHaveLength(0);
    const found = (await (await t.call("/api/search?q=secret", { as: bob })).json()) as { files: unknown[] };
    expect(found.files).toHaveLength(0);
  });
});
