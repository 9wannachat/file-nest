import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileNestClient, fileFingerprint } from "../src/client.js";

const UP = "44444444-4444-4444-8444-444444444444";
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

describe("large uploads (multipart)", () => {
  it("sends the fingerprint, uploads every part (retrying a failed one), refills a missing part, then finalizes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fn-mp-"));
    const path = join(dir, "clip.mp4");
    const content = "0123456789";
    await writeFile(path, content);
    const stored = new Map<number, string>();
    let created: Record<string, unknown> = {};
    let failPart2 = true;
    let dropPart3Once = true;
    let finalizes = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const u = new URL(req.url);
      if (u.host === "storage.test") {
        const n = Number(u.searchParams.get("part"));
        if (n === 2 && failPart2) {
          failPart2 = false;
          return new Response("boom", { status: 500 });
        }
        stored.set(n, await req.text());
        if (n === 3 && dropPart3Once) {
          dropPart3Once = false;
          stored.delete(3); // lost after a 200: finalize must notice and refill
        }
        return new Response(null, { status: 200 });
      }
      if (u.pathname === "/api/uploads") {
        created = (await req.json()) as Record<string, unknown>;
        return json({ uploadId: UP, mode: "multipart", partSize: 4, partCount: 3 }, 201);
      }
      if (u.pathname === `/api/uploads/${UP}/parts` && req.method === "POST") {
        const b = (await req.json()) as { parts: number[]; fingerprint: string };
        expect(b.fingerprint).toBe(created.fingerprint);
        return json({ urls: b.parts.map((n) => ({ part: n, size: n < 3 ? 4 : 2, url: `https://storage.test/x?part=${n}` })), urlExpiresAt: Date.now() + 900_000, expiresAt: 0 });
      }
      if (u.pathname === `/api/uploads/${UP}/parts`) return json({ parts: [...stored.keys()].map((part) => ({ part, size: 0 })) });
      if (u.pathname === `/api/uploads/${UP}/finalize`) {
        finalizes++;
        if (stored.size < 3) return json({ error: { code: "upload_incomplete", message: "incomplete" } }, 409);
        return json({ state: "completed", file: { id: UP, name: "clip.mp4", size: 10 } });
      }
      return json({ error: { code: "not_found", message: "?" } }, 404);
    }) as typeof fetch;

    const client = new FileNestClient("https://nest.test", "fnpat_x", fetchImpl);
    const file = await client.upload(path, "clip.mp4", 10, "video/mp4", null);
    expect(file.name).toBe("clip.mp4");
    expect(created).toMatchObject({ multipart: true, size: 10 });
    expect(created.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect([1, 2, 3].map((n) => stored.get(n)).join("")).toBe(content);
    expect(finalizes).toBe(2);
  }, 20_000);

  it("fingerprints a file as SHA-256(first MiB ‖ last MiB ‖ size)", async () => {
    const { createHash } = await import("node:crypto");
    const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
    const want = createHash("sha256").update(big.subarray(0, 1024 * 1024)).update(big.subarray(2 * 1024 * 1024)).update(String(big.length)).digest("hex");
    expect(await fileFingerprint(new Blob([big]))).toBe(want);
  });
});
