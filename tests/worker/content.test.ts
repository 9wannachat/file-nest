import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { files } from "../../src/worker/db/schema.ts";
import { ACCOUNT_A, db, login, makeTarget, makeUser, resetDb, setup, uploadFile, type Login } from "./helpers.ts";

let t: ReturnType<typeof setup>;
let alice: Login;
const BODY = "0123456789abcdefghij"; // 20 bytes

beforeEach(async () => {
  await resetDb();
  t = setup();
  await makeTarget({ name: "A", accountId: ACCOUNT_A, bucket: "bucket-a", ref: "A", isDefault: true });
  alice = await login(await makeUser());
});

function assertNoR2Leak(res: Response, body = "") {
  const all = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n") + body;
  expect(all).not.toMatch(/r2\.cloudflarestorage\.com|X-Amz|x-amz-request-id|fake-r2|bucket-a|staging\/|files\//i);
}

describe("streamed preview/download", () => {
  it("full GET with safe headers", async () => {
    const { file } = await uploadFile(t, alice, "notes.txt", BODY, { mime: "text/plain" });
    const r = await t.call(`/api/files/${file.id}/preview`, { as: alice });
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(r.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(r.headers.get("Cache-Control")).toContain("no-store");
    expect(r.headers.get("Accept-Ranges")).toBe("bytes");
    expect(r.headers.get("Content-Security-Policy")).toContain("sandbox");
    const text = await r.text();
    expect(text).toBe(BODY);
    assertNoR2Leak(r, text);
    const d = await t.call(`/api/files/${file.id}/download`, { as: alice });
    expect(d.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    await d.arrayBuffer();
  });

  it("HEAD returns size without hitting R2", async () => {
    const { file } = await uploadFile(t, alice, "n.txt", BODY, { mime: "text/plain" });
    const before = t.s3.requests.length;
    const r = await t.call(`/api/files/${file.id}/preview`, { method: "HEAD", as: alice });
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Length")).toBe("20");
    expect(t.s3.requests.length).toBe(before);
  });

  it.each([
    ["bytes=0-4", 206, "01234", "bytes 0-4/20"],
    ["bytes=15-", 206, "fghij", "bytes 15-19/20"],
    ["bytes=-3", 206, "hij", "bytes 17-19/20"],
    ["bytes=10-999", 206, "abcdefghij", "bytes 10-19/20"],
  ])("Range %s -> %i", async (range, status, expected, cr) => {
    const { file } = await uploadFile(t, alice, "r.txt", BODY, { mime: "text/plain" });
    const r = await t.call(`/api/files/${file.id}/preview`, { as: alice, headers: { Range: range } });
    expect(r.status).toBe(status);
    expect(r.headers.get("Content-Range")).toBe(cr);
    expect(r.headers.get("Content-Length")).toBe(String(expected.length));
    expect(await r.text()).toBe(expected);
    expect(t.s3.requests.at(-1)?.range).toBe(`bytes=${cr.split(" ")[1]!.split("/")[0]}`);
  });

  it("unsatisfiable Range -> 416 with Content-Range */size", async () => {
    const { file } = await uploadFile(t, alice, "r.txt", BODY, { mime: "text/plain" });
    const r = await t.call(`/api/files/${file.id}/preview`, { as: alice, headers: { Range: "bytes=20-" } });
    expect(r.status).toBe(416);
    expect(r.headers.get("Content-Range")).toBe("bytes */20");
  });

  it("uploaded HTML and SVG never render inline", async () => {
    for (const [name, mime, body] of [
      ["x.html", "text/html", "<script>alert(document.cookie)</script>"],
      ["x.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'],
    ]) {
      const { file } = await uploadFile(t, alice, name!, body!, { mime: mime! });
      const r = await t.call(`/api/files/${file.id}/preview`, { as: alice });
      expect(r.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(r.headers.get("Content-Disposition")).toMatch(/^attachment;/);
      expect(r.headers.get("Content-Security-Policy")).toContain("sandbox");
      await r.arrayBuffer();
    }
  });

  it("rename and move are metadata-only; object key unchanged", async () => {
    const { file } = await uploadFile(t, alice, "m.txt", BODY, { mime: "text/plain" });
    const before = (await db().select().from(files).where(eq(files.id, file.id)).get())!;
    const folder = (await (await t.call("/api/folders", { method: "POST", as: alice, body: t.json({ name: "F" }) })).json()) as { id: string };
    const sub = (await (await t.call("/api/folders", { method: "POST", as: alice, body: t.json({ name: "S", parentId: folder.id }) })).json()) as { id: string };
    expect((await t.call(`/api/files/${file.id}`, { method: "PATCH", as: alice, body: t.json({ name: "renamed.txt", folderId: sub.id }) })).status).toBe(200);
    expect((await t.call(`/api/folders/${folder.id}`, { method: "PATCH", as: alice, body: t.json({ name: "F2" }) })).status).toBe(200);
    // cycle prevention
    expect((await t.call(`/api/folders/${folder.id}`, { method: "PATCH", as: alice, body: t.json({ parentId: sub.id }) })).status).toBe(400);
    const after = (await db().select().from(files).where(eq(files.id, file.id)).get())!;
    expect(after.objectKey).toBe(before.objectKey);
    expect(after.storageId).toBe(before.storageId);
    expect(await (await t.call(`/api/files/${file.id}/download`, { as: alice })).text()).toBe(BODY);
    const crumbs = (await (await t.call(`/api/folders/${sub.id}`, { as: alice })).json()) as { breadcrumb: { name: string }[] };
    expect(crumbs.breadcrumb.map((b) => b.name)).toEqual(["F2", "S"]);
  });

  it("storage failure gives a generic error", async () => {
    const { file } = await uploadFile(t, alice, "gone.txt", BODY, { mime: "text/plain" });
    for (const k of [...(t.s3.store as unknown as { map: Map<string, unknown> }).map.keys()]) await t.s3.store.delete(k);
    const r = await t.call(`/api/files/${file.id}/download`, { as: alice });
    expect(r.status).toBe(502);
    const body = await r.text();
    assertNoR2Leak(r, body);
  });
});

describe("trash", () => {
  it("trash folder hides subtree; restore brings it back; purge queues deletes", async () => {
    const folder = (await (await t.call("/api/folders", { method: "POST", as: alice, body: t.json({ name: "T" }) })).json()) as { id: string };
    const { file } = await uploadFile(t, alice, "in.txt", "x", { mime: "text/plain", folderId: folder.id });
    const sub = (await (await t.call("/api/folders", { method: "POST", as: alice, body: t.json({ name: "Sub", parentId: folder.id }) })).json()) as { id: string };
    await uploadFile(t, alice, "deep.txt", "y", { mime: "text/plain", folderId: sub.id });
    await t.call(`/api/folders/${folder.id}/trash`, { method: "POST", as: alice });
    expect((await t.call(`/api/files/${file.id}/download`, { as: alice })).status).toBe(404);
    const trash = (await (await t.call("/api/trash", { as: alice })).json()) as { folders: { id: string }[]; files: unknown[] };
    expect(trash.folders.map((f) => f.id)).toEqual([folder.id]);
    expect(trash.files).toHaveLength(0); // file is inside the trashed folder
    expect((await t.call(`/api/files/${file.id}/restore`, { method: "POST", as: alice })).status).toBe(400);
    expect((await t.call(`/api/folders/${folder.id}/restore`, { method: "POST", as: alice })).status).toBe(200);
    expect((await t.call(`/api/files/${file.id}/download`, { as: alice })).status).toBe(200);
    await t.call(`/api/folders/${folder.id}/trash`, { method: "POST", as: alice });
    expect((await t.call(`/api/folders/${folder.id}`, { method: "DELETE", as: alice })).status).toBe(200);
    expect(await db().select().from(files)).toHaveLength(0);
    const list = (await (await t.call("/api/folders/root", { as: alice })).json()) as { folders: unknown[] };
    expect(list.folders).toHaveLength(0);
  });
});
