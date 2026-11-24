import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { multipartAborts, uploadSessions } from "../../src/worker/db/schema.ts";
import { runCleanup } from "../../src/worker/services/cleanup.ts";
import { planParts } from "../../src/worker/services/uploads.ts";
import { ACCOUNT_A, db, enc, login, makeTarget, makeUser, resetDb, setup, uploadFile, type Login } from "./helpers.ts";

// vitest.config: MULTIPART_THRESHOLD_BYTES=10, MULTIPART_PART_BYTES=4 (fake S3 accepts tiny parts).
const FP = "a".repeat(64);
const CONTENT = "0123456789ABCDEFGHIJ"; // 20 bytes -> parts 4,4,4,4,4
let t: ReturnType<typeof setup>;
let alice: Login;

beforeEach(async () => {
  await resetDb();
  t = setup();
  await makeTarget({ name: "A", accountId: ACCOUNT_A, bucket: "bucket-a", ref: "A", isDefault: true });
  alice = await login(await makeUser({ quotaUnlimited: true }));
});

const call = (as: Login, method: string, path: string, body?: unknown) => t.call(path, { method, as, body: body === undefined ? undefined : t.json(body) });
async function create(content = CONTENT, extra: Record<string, unknown> = {}) {
  const r = await call(alice, "POST", "/api/uploads", { name: "big.bin", size: enc(content).length, mime: "application/octet-stream", folderId: null, multipart: true, fingerprint: FP, ...extra });
  expect(r.status).toBe(201);
  return (await r.json()) as { uploadId: string; mode: string; partSize: number; partCount: number; expiresAt: number };
}
async function partUrls(id: string, parts: number[], fingerprint = FP) {
  return call(alice, "POST", `/api/uploads/${id}/parts`, { parts, fingerprint });
}
async function sendParts(id: string, content: string, parts: number[], partSize: number) {
  const r = await partUrls(id, parts);
  expect(r.status).toBe(200);
  const { urls } = (await r.json()) as { urls: { part: number; size: number; url: string }[] };
  const bytes = enc(content);
  for (const u of urls) {
    const body = bytes.slice((u.part - 1) * partSize, (u.part - 1) * partSize + u.size);
    expect(body.length).toBe(u.size);
    expect((await t.s3.fetch(u.url, { method: "PUT", body })).status).toBe(200);
  }
}
const finalize = (id: string) => call(alice, "POST", `/api/uploads/${id}/finalize`);
const session = (id: string) => db().select().from(uploadSessions).where(eq(uploadSessions.id, id)).get();

describe("multipart uploads", () => {
  it("plans equal parts (except the last) and never more than 10,000", () => {
    expect(planParts(20, 4)).toEqual({ partSize: 4, partCount: 5 });
    expect(planParts(21, 4)).toEqual({ partSize: 4, partCount: 6 });
    const big = planParts(4_000 * 1024 ** 3, 16 * 1024 ** 2);
    expect(big.partCount).toBeLessThanOrEqual(10_000);
    expect(big.partSize * big.partCount).toBeGreaterThanOrEqual(4_000 * 1024 ** 3);
  });

  it("uploads parts straight to the final key, completes from R2's own part list and serves the file", async () => {
    const c = await create();
    expect(c).toMatchObject({ mode: "multipart", partSize: 4, partCount: 5 });
    t.s3.requests.length = 0;
    await sendParts(c.uploadId, CONTENT, [1, 2, 3, 4, 5], 4);
    const fin = await finalize(c.uploadId);
    expect(fin.status).toBe(200);
    const file = ((await fin.json()) as { file: { id: string; size: number } }).file;
    expect(file.size).toBe(20);
    expect(await (await call(alice, "GET", `/api/files/${file.id}/download`)).text()).toBe(CONTENT);
    // No staging object and no CopyObject: parts went to files/… directly.
    expect(t.s3.requests.some((r) => r.path.includes("/staging/"))).toBe(false);
    expect(t.s3.requests.every((r) => r.path.includes("/files/"))).toBe(true);
    expect(t.s3.multipart.size).toBe(0);
    // Idempotent.
    expect((await finalize(c.uploadId)).status).toBe(200);
  });

  it("keeps the single PUT for small files and for clients that do not opt in", async () => {
    const small = await call(alice, "POST", "/api/uploads", { name: "s.bin", size: 5, mime: null, folderId: null, multipart: true, fingerprint: FP });
    expect(((await small.json()) as { mode: string }).mode).toBe("single");
    const legacy = await call(alice, "POST", "/api/uploads", { name: "l.bin", size: 20, mime: null, folderId: null });
    expect(((await legacy.json()) as { mode: string; putUrl: string }).putUrl).toBeTruthy();
    expect((await uploadFile(t, alice, "plain.txt", CONTENT)).file.name).toBe("plain.txt");
  });

  it("requires a fingerprint, and part URLs only for the same file and valid part numbers", async () => {
    const bad = await call(alice, "POST", "/api/uploads", { name: "x.bin", size: 20, mime: null, folderId: null, multipart: true });
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_fingerprint");
    const c = await create();
    expect(((await (await partUrls(c.uploadId, [1], "b".repeat(64))).json()) as { error: { code: string } }).error.code).toBe("file_mismatch");
    for (const parts of [[], [0], [6], [1, 1], [1.5], Array.from({ length: 101 }, (_, i) => i + 1)]) {
      expect((await partUrls(c.uploadId, parts)).status).toBe(400);
    }
    // Last part's URL is signed for its own (shorter) length.
    const urls = ((await (await partUrls(c.uploadId, [5])).json()) as { urls: { size: number; url: string }[] }).urls;
    expect(urls[0]!.size).toBe(4);
    expect(new URL(urls[0]!.url).searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
  });

  it("a missing part keeps the session open; the client sends it and finalizes again", async () => {
    const c = await create();
    await sendParts(c.uploadId, CONTENT, [1, 2, 4, 5], 4);
    const r = await finalize(c.uploadId);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("upload_incomplete");
    expect((await session(c.uploadId))!.state).toBe("pending");
    const have = (await (await call(alice, "GET", `/api/uploads/${c.uploadId}/parts`)).json()) as { parts: { part: number }[] };
    expect(have.parts.map((p) => p.part)).toEqual([1, 2, 4, 5]);
    await sendParts(c.uploadId, CONTENT, [3], 4);
    expect((await finalize(c.uploadId)).status).toBe(200);
  });

  it("a part replaced between listing and completing is not published; a retry uses the new part", async () => {
    let swap = true;
    t = setup({
      beforeS3: async (req) => {
        const u = new URL(req.url);
        if (swap && req.method === "POST" && u.searchParams.has("uploadId")) {
          swap = false;
          for (const mp of t.s3.multipart.values()) mp.parts.set(1, { body: enc("zzzz"), etag: '"changed"' });
        }
      },
    });
    const c = await create();
    await sendParts(c.uploadId, CONTENT, [1, 2, 3, 4, 5], 4);
    const r = await finalize(c.uploadId);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("staging_changed");
    expect((await session(c.uploadId))!.state).toBe("pending");
    const ok = await finalize(c.uploadId);
    const file = ((await ok.json()) as { file: { id: string } }).file;
    expect(await (await call(alice, "GET", `/api/files/${file.id}/download`)).text()).toBe("zzzz" + CONTENT.slice(4));
  });

  it("recovers when R2 completed the object but the file row was never written", async () => {
    const c = await create();
    await sendParts(c.uploadId, CONTENT, [1, 2, 3, 4, 5], 4);
    const s = (await session(c.uploadId))!;
    // Complete directly in the fake (as if the Worker died right after Complete).
    const [mpId, mp] = [...t.s3.multipart.entries()][0]!;
    expect(mpId).toBe(s.multipartId);
    const parts = [...mp.parts.entries()].sort((a, b) => a[0] - b[0]);
    const xml = `<CompleteMultipartUpload>${parts.map(([n, p]) => `<Part><PartNumber>${n}</PartNumber><ETag>${p.etag}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
    const done = await t.s3.fetch(`https://${ACCOUNT_A}.r2.cloudflarestorage.com/bucket-a/${s.finalKey}?uploadId=${encodeURIComponent(mpId)}`, {
      method: "POST",
      headers: { Authorization: "AWS4-HMAC-SHA256 Credential=test-a-key/x" },
      body: xml,
    });
    expect(done.status).toBe(200);
    const fin = await finalize(c.uploadId);
    expect(fin.status).toBe(200);
    const file = ((await fin.json()) as { file: { id: string } }).file;
    expect(await (await call(alice, "GET", `/api/files/${file.id}/download`)).text()).toBe(CONTENT);
  });

  it("abort and expiry release the reservation and abort the parts in R2", async () => {
    const c = await create();
    await sendParts(c.uploadId, CONTENT, [1, 2], 4);
    await expect((await call(alice, "POST", `/api/uploads/${c.uploadId}/abort`)).json()).resolves.toEqual({ state: "aborted" });
    expect(await db().select().from(multipartAborts).all()).toHaveLength(1);
    expect((await partUrls(c.uploadId, [3])).status).toBe(410);
    expect(t.s3.multipart.size).toBe(0); // aborted in R2 right away
    t.clock.t += 17 * 60_000; // the queued second abort runs once all part URLs are dead
    await runCleanup({ ...t.ctx, deps: { ...t.ctx.deps, now: () => t.clock.t } });
    expect(await db().select().from(multipartAborts).all()).toHaveLength(0);

    const d = await create();
    t.clock.t += 25 * 3600_000; // past the 24 h window
    expect((await partUrls(d.uploadId, [1])).status).toBe(410);
    await runCleanup({ ...t.ctx, deps: { ...t.ctx.deps, now: () => t.clock.t } });
    expect((await session(d.uploadId))!.state).toBe("expired");
    t.clock.t += 17 * 60_000;
    await runCleanup({ ...t.ctx, deps: { ...t.ctx.deps, now: () => t.clock.t } });
    expect(t.s3.multipart.size).toBe(0);
  });

  it("part requests keep an active upload alive, but never past 7 days", async () => {
    const c = await create();
    const created = (await session(c.uploadId))!;
    t.clock.t += 20 * 3600_000;
    await partUrls(c.uploadId, [1]);
    expect((await session(c.uploadId))!.expiresAt).toBe(t.clock.t + 24 * 3600_000);
    for (let day = 0; day < 7; day++) {
      t.clock.t += 20 * 3600_000;
      await partUrls(c.uploadId, [1]);
    }
    expect((await session(c.uploadId))!.expiresAt).toBeLessThanOrEqual(created.createdAt + 7 * 24 * 3600_000);
  });

  it("only the owner sees, resumes or extends an upload; the resumable list is per member", async () => {
    const c = await create();
    const bob = await login(await makeUser());
    for (const [m, p] of [["POST", `/api/uploads/${c.uploadId}/parts`], ["GET", `/api/uploads/${c.uploadId}/parts`], ["POST", `/api/uploads/${c.uploadId}/finalize`]] as const) {
      expect((await call(bob, m, p, m === "POST" ? { parts: [1], fingerprint: FP } : undefined)).status).toBe(404);
    }
    const mine = (await (await call(alice, "GET", "/api/uploads/resumable")).json()) as { uploads: { uploadId: string; partCount: number }[] };
    expect(mine.uploads).toEqual([expect.objectContaining({ uploadId: c.uploadId, partCount: 5 })]);
    expect(((await (await call(bob, "GET", "/api/uploads/resumable")).json()) as { uploads: unknown[] }).uploads).toEqual([]);
  });

  it("personal access tokens can upload large files (files:write) and nothing more", async () => {
    const r = await call(alice, "POST", "/api/tokens", { name: "mcp", scopes: ["files:read", "files:write"], expiresInDays: 30 });
    const token = ((await r.json()) as { token: string }).token;
    const bearer = (method: string, path: string, body?: unknown) =>
      t.call(path, { method, headers: { Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : t.json(body) });
    const c = (await (await bearer("POST", "/api/uploads", { name: "m.bin", size: 20, mime: null, folderId: null, multipart: true, fingerprint: FP })).json()) as { uploadId: string };
    expect((await bearer("POST", `/api/uploads/${c.uploadId}/parts`, { parts: [1], fingerprint: FP })).status).toBe(200);
    expect((await bearer("GET", `/api/uploads/${c.uploadId}/parts`)).status).toBe(200);
    expect((await bearer("GET", "/api/uploads/resumable")).status).toBe(403);
  });

  it("the declared size is reserved against the quota for the whole upload", async () => {
    const bob = await login(await makeUser({ quotaBytes: 30 }));
    const mk = () => t.call("/api/uploads", { method: "POST", as: bob, body: t.json({ name: "q.bin", size: 20, mime: null, folderId: null, multipart: true, fingerprint: FP }) });
    expect((await mk()).status).toBe(201);
    expect((await mk()).status).toBe(413);
  });
});

describe("multipart security regressions", () => {
  it("a cancelled upload keeps its reservation until its part URLs are dead, and is aborted in R2 at once", async () => {
    const bob = await login(await makeUser({ quotaBytes: 30 }));
    const mk = () => t.call("/api/uploads", { method: "POST", as: bob, body: t.json({ name: "q.bin", size: 20, mime: null, folderId: null, multipart: true, fingerprint: FP }) });
    const c = (await (await mk()).json()) as { uploadId: string };
    const urls = ((await (await t.call(`/api/uploads/${c.uploadId}/parts`, { method: "POST", as: bob, body: t.json({ parts: [1, 2, 3, 4, 5], fingerprint: FP }) })).json()) as { urls: { url: string }[] }).urls;
    expect((await t.call(`/api/uploads/${c.uploadId}/abort`, { method: "POST", as: bob })).status).toBe(200);
    expect(t.s3.multipart.size).toBe(0); // aborted in R2 right away
    for (const u of urls) expect((await t.s3.fetch(u.url, { method: "PUT", body: enc("xxxx") })).status).toBe(404); // NoSuchUpload
    expect((await mk()).status).toBe(413); // still reserved
    t.clock.t += 17 * 60_000; // all part URLs expired
    expect((await mk()).status).toBe(201);
  });

  it("an R2 part-size rejection fails the upload for good instead of retrying forever", async () => {
    t = setup({ minPartBytes: 1024 });
    const c = await create();
    await sendParts(c.uploadId, CONTENT, [1, 2, 3, 4, 5], 4);
    const r = await finalize(c.uploadId);
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("part_too_small");
    expect((await session(c.uploadId))!.state).toBe("failed");
  });

  it("part URLs are signed for exactly one part, its length and 15 minutes", async () => {
    const c = await create();
    const { urls } = (await (await partUrls(c.uploadId, [2])).json()) as { urls: { url: string }[] };
    const u = new URL(urls[0]!.url);
    expect(u.pathname).toMatch(/^\/bucket-a\/files\//);
    expect(u.searchParams.get("partNumber")).toBe("2");
    expect(u.searchParams.get("uploadId")).toBe((await session(c.uploadId))!.multipartId);
    expect(u.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;host");
  });

  it("a malformed ListParts answer is a retryable storage fault, never 'part 0'", async () => {
    const { R2Bucket } = await import("../../src/worker/storage/s3.ts");
    const { loadConfig } = await import("../../src/worker/env.ts");
    const { testEnv } = await import("./helpers.ts");
    const xml = (parts: string) => new Response(`<ListPartsResult><IsTruncated>false</IsTruncated>${parts}</ListPartsResult>`);
    const b = (body: string) => new R2Bucket({ accountId: ACCOUNT_A, bucket: "bucket-a", credentialRef: "A" }, testEnv, loadConfig(testEnv), (async () => xml(body)) as unknown as typeof fetch);
    await expect(b(`<Part><ETag>"x"</ETag></Part>`).listParts("files/x/y", "m")).rejects.toThrow(/mpu_list/);
    await expect(b(`<Part><PartNumber>0</PartNumber><ETag>"x"</ETag><Size>4</Size></Part>`).listParts("files/x/y", "m")).rejects.toThrow(/mpu_list/);
    await expect(b(`<Part><PartNumber>1</PartNumber><ETag>"x"</ETag><Size>4</Size></Part>`).listParts("files/x/y", "m")).resolves.toEqual([{ part: 1, size: 4, etag: '"x"' }]);
  });
});
