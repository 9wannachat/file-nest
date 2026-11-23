import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileNestClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { safeFileName, Workdir } from "../src/sandbox.js";
import { createServer } from "../src/server.js";

const TOKEN = "fnpat_" + "A".repeat(43);
const FILE_ID = "11111111-1111-4111-8111-111111111111";
const IMG_ID = "22222222-2222-4222-8222-222222222222";
const UP_ID = "33333333-3333-4333-8333-333333333333";
const VIDEO = new TextEncoder().encode("0123456789-fake-video-bytes");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** In-memory stand-in for the FileNest API + presigned storage. */
function fakeFileNest() {
  const log: { method: string; path: string; range: string | null; auth: string | null }[] = [];
  const uploaded: { name: string; bytes: Uint8Array; contentType: string | null }[] = [];
  let pending: { name: string; size: number } | null = null;
  const file = (id: string, name: string, size: number, contentType: string) => ({
    id,
    kind: "file",
    name,
    size,
    contentType,
    inline: true,
    folderId: null,
    createdAt: 0,
    updatedAt: 0,
    isOwner: true,
    owner: { id: "u", email: "me@example.test", name: "Me" },
  });
  const files: Record<string, { meta: ReturnType<typeof file>; bytes: Uint8Array }> = {
    [FILE_ID]: { meta: file(FILE_ID, "clip.mp4", VIDEO.length, "video/mp4"), bytes: VIDEO },
    [IMG_ID]: { meta: file(IMG_ID, "pic.png", PNG.length, "image/png"), bytes: PNG },
  };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    log.push({ method: req.method, path: url.pathname, range: req.headers.get("Range"), auth: req.headers.get("Authorization") });
    if (url.host === "storage.test") {
      const body = new Uint8Array(await req.arrayBuffer());
      if (!pending || body.length !== pending.size) return new Response("bad length", { status: 403 });
      uploaded.push({ name: pending.name, bytes: body, contentType: req.headers.get("Content-Type") });
      return new Response(null, { status: 200 });
    }
    if (req.headers.get("Authorization") !== `Bearer ${TOKEN}`) return json({ error: { code: "invalid_token", message: "bad" } }, 401);
    const p = url.pathname;
    if (p === "/api/me") return json({ user: { id: "u", email: "me@example.test", name: "Me" }, limits: { maxUploadBytes: 1000 } });
    if (p === "/api/folders/root") return json({ folder: null, breadcrumb: [], folders: [], files: Object.values(files).map((f) => f.meta) });
    const m = /^\/api\/files\/([0-9a-f-]{36})(\/download)?$/.exec(p);
    if (m) {
      const f = files[m[1]!];
      if (!f) return json({ error: { code: "not_found", message: "Not found" } }, 404);
      if (!m[2]) return json(f.meta);
      const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("Range") ?? "");
      if (r) {
        const start = Number(r[1]);
        const end = r[2] ? Math.min(Number(r[2]), f.bytes.length - 1) : f.bytes.length - 1;
        return new Response(Buffer.from(f.bytes.slice(start, end + 1)), { status: 206 });
      }
      return new Response(Buffer.from(f.bytes), { status: 200 });
    }
    if (p === "/api/uploads" && req.method === "POST") {
      const b = (await req.json()) as { name: string; size: number; mime: string };
      pending = { name: b.name, size: b.size };
      return json({ uploadId: UP_ID, putUrl: "https://storage.test/staging/x?X-Amz-Signature=s", putHeaders: { "Content-Type": b.mime } }, 201);
    }
    if (p === `/api/uploads/${UP_ID}/finalize`) {
      const u = uploaded.at(-1)!;
      return json({ state: "completed", file: file(UP_ID, u.name, u.bytes.length, "video/mp4") });
    }
    return json({ error: { code: "not_found", message: "Not found" } }, 404);
  }) as typeof fetch;
  return { fetchImpl, log, uploaded };
}

let dir: string;
let work: string;
let outside: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "filenest-mcp-"));
  work = join(dir, "work");
  outside = join(dir, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "TOP SECRET");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function connect() {
  const fake = fakeFileNest();
  const workdir = await Workdir.open(work);
  const server = createServer(new FileNestClient("https://files.test", TOKEN, fake.fetchImpl), workdir);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[] };
    return { ...r, text: r.content[0]?.text ?? "", json: () => JSON.parse(r.content[0]!.text!) };
  };
  return { fake, client, call, workdir };
}

describe("MCP tools", () => {
  it("exposes only the planned tools (no share/delete/move)", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["create_folder", "download_file", "get_file_info", "list_folder", "list_shared", "read_file_content", "search_files", "upload_file"]);
  });

  it("lists, downloads into the workdir, and sends the bearer token", async () => {
    const { call, fake } = await connect();
    const list = (await call("list_folder")).json();
    expect(list.files.map((f: { name: string }) => f.name)).toEqual(["clip.mp4", "pic.png"]);
    const d = await call("download_file", { fileId: FILE_ID });
    expect(d.isError).toBeFalsy();
    expect(d.json()).toMatchObject({ relativePath: "clip.mp4", bytes: VIDEO.length, resumed: false });
    expect(new Uint8Array(await readFile(join(work, "clip.mp4")))).toEqual(VIDEO);
    expect(fake.log.every((l) => l.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("resumes a partial download with a Range request", async () => {
    const { call, fake } = await connect();
    await mkdir(work, { recursive: true });
    await writeFile(join(work, `clip.mp4.${FILE_ID}.part`), VIDEO.slice(0, 10));
    const d = (await call("download_file", { fileId: FILE_ID })).json();
    expect(d.resumed).toBe(true);
    expect(fake.log.find((l) => l.path.endsWith("/download"))?.range).toBe("bytes=10-");
    expect(new Uint8Array(await readFile(join(work, "clip.mp4")))).toEqual(VIDEO);
  });

  it("refuses paths outside the workdir, symlink escapes and silent overwrites", async () => {
    const { call } = await connect();
    for (const path of ["../outside/stolen.mp4", join(outside, "x.mp4"), "a/../../outside/y.mp4"]) {
      const r = await call("download_file", { fileId: FILE_ID, path });
      expect(r.isError, path).toBe(true);
      expect(r.text).toMatch(/Not allowed/);
    }
    await symlink(outside, join(work, "link"));
    expect((await call("download_file", { fileId: FILE_ID, path: "link/z.mp4" })).isError).toBe(true);
    expect((await call("upload_file", { path: "link/secret.txt" })).isError).toBe(true);
    expect((await call("upload_file", { path: "../outside/secret.txt" })).isError).toBe(true);
    expect((await call("upload_file", { path: join(outside, "secret.txt") })).isError).toBe(true);

    expect((await call("download_file", { fileId: FILE_ID })).isError).toBeFalsy();
    const again = await call("download_file", { fileId: FILE_ID });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/overwrite/);
    expect((await call("download_file", { fileId: FILE_ID, overwrite: true })).isError).toBeFalsy();
  });

  it("refuses a symlinked .part file and ignores partial data from a different file id", async () => {
    const { call } = await connect();
    await mkdir(work, { recursive: true });
    await symlink(join(outside, "secret.txt"), join(work, `x.mp4.${FILE_ID}.part`));
    const r = await call("download_file", { fileId: FILE_ID, path: "x.mp4" });
    expect(r.isError).toBe(true);
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("TOP SECRET");
    // Stale partial data belonging to ANOTHER file must not be mixed in.
    await writeFile(join(work, `y.mp4.${IMG_ID}.part`), "STALE");
    expect((await call("download_file", { fileId: FILE_ID, path: "y.mp4" })).json().resumed).toBe(false);
    expect(new Uint8Array(await readFile(join(work, "y.mp4")))).toEqual(VIDEO);
  });

  it("makes server file names safe on every OS", () => {
    expect(safeFileName("CON")).toBe("_CON");
    expect(safeFileName("nul.txt")).toBe("_nul.txt");
    expect(safeFileName("a.txt:evil")).toBe("a.txt_evil");
    expect(safeFileName("../../x")).toBe("__.._x"); // no separators survive
    expect(safeFileName("name. ")).toBe("name");
  });

  it("uploads a processed file from the workdir with the exact length", async () => {
    const { call, fake } = await connect();
    await mkdir(join(work, "out"), { recursive: true });
    await writeFile(join(work, "out", "cut.mp4"), "edited!");
    const r = await call("upload_file", { path: "out/cut.mp4", name: "clip (cut).mp4" });
    expect(r.isError).toBeFalsy();
    expect(r.json().uploaded.name).toBe("clip (cut).mp4");
    expect(new TextDecoder().decode(fake.uploaded[0]!.bytes)).toBe("edited!");
    expect(fake.uploaded[0]!.contentType).toBe("video/mp4");
  });

  it("refuses uploads above the server limit before contacting storage", async () => {
    const { call, fake } = await connect();
    await mkdir(work, { recursive: true });
    await writeFile(join(work, "big.bin"), new Uint8Array(2000));
    const r = await call("upload_file", { path: "big.bin" });
    expect(r.isError).toBe(true);
    expect(fake.log.some((l) => l.path === "/api/uploads")).toBe(false);
  });

  it("returns images inline and reports API errors as tool errors", async () => {
    const { call } = await connect();
    const img = await call("read_file_content", { fileId: IMG_ID });
    expect(img.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(Buffer.from(img.content[0]!.data!, "base64")).toEqual(Buffer.from(PNG));
    const video = await call("read_file_content", { fileId: FILE_ID });
    expect(video.isError).toBe(true);
    const missing = await call("get_file_info", { fileId: "44444444-4444-4444-8444-444444444444" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/404/);
  });

  it("rejects non-UUID ids at the schema level", async () => {
    const { call } = await connect();
    const r = await call("get_file_info", { fileId: "../../api/admin/members" });
    expect(r.isError).toBe(true);
  });
});

describe("config", () => {
  it("requires https (except localhost) and a well-formed token; warns on loose token file", async () => {
    await expect(loadConfig({ FILENEST_URL: "http://files.example.com", FILENEST_TOKEN: TOKEN })).rejects.toThrow(/https/);
    await expect(loadConfig({ FILENEST_URL: "https://files.example.com", FILENEST_TOKEN: "nope" })).rejects.toThrow(/token/);
    const ok = await loadConfig({ FILENEST_URL: "http://localhost:8788", FILENEST_TOKEN: TOKEN, FILENEST_WORKDIR: work });
    expect(ok.url).toBe("http://localhost:8788");
    expect(ok.warnings.join()).toMatch(/FILENEST_TOKEN_FILE/);
    const tf = join(dir, "token");
    await writeFile(tf, TOKEN + "\n");
    await chmod(tf, 0o644);
    const loose = await loadConfig({ FILENEST_URL: "https://files.example.com", FILENEST_TOKEN_FILE: tf });
    expect(loose.token).toBe(TOKEN);
    expect(loose.warnings.join()).toMatch(/chmod 600/);
    await chmod(tf, 0o600);
    expect((await loadConfig({ FILENEST_URL: "https://files.example.com", FILENEST_TOKEN_FILE: tf })).warnings).toEqual([]);
  });
});

export { Workdir };
