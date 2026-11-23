import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_A, login, makeTarget, makeUser, resetDb, setup, uploadFile, type Login } from "./helpers.ts";
import { auditEvents } from "../../src/worker/db/schema.ts";
import { db } from "./helpers.ts";

let t: ReturnType<typeof setup>;
let alice: Login;
let fileId: string;

beforeEach(async () => {
  await resetDb();
  t = setup();
  await makeTarget({ name: "A", accountId: ACCOUNT_A, bucket: "bucket-a", ref: "A", isDefault: true });
  alice = await login(await makeUser());
  fileId = (await uploadFile(t, alice, "report.pdf", "%PDF-1.7\nhello world", { mime: "application/pdf" })).file.id;
});

async function makeLink() {
  const r = await t.call(`/api/files/${fileId}/sharing/link`, { method: "POST", as: alice });
  expect(r.status).toBe(201);
  const s = (await r.json()) as { visibility: string; publicLink: { url: string } };
  expect(s.visibility).toBe("public");
  return new URL(s.publicLink.url).pathname;
}

describe("public share links", () => {
  it("new files are private", async () => {
    const s = (await (await t.call(`/api/files/${fileId}/sharing`, { as: alice })).json()) as { visibility: string };
    expect(s.visibility).toBe("private");
  });

  it("works without login, with no-store + no-referrer; same link on re-share", async () => {
    const path = await makeLink();
    expect(path).toMatch(/^\/s\/[A-Za-z0-9_-]{43}$/);
    expect(await makeLink()).toBe(path); // copy link again
    const page = await t.call(path);
    expect(page.status).toBe(200);
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(page.headers.get("Cache-Control")).toContain("no-store");
    expect(page.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain("report.pdf");
    expect(html).not.toMatch(/r2\.cloudflarestorage|X-Amz/);
    const pv = await t.call(`${path}/preview`, { headers: { Range: "bytes=0-4" } });
    expect(pv.status).toBe(206);
    expect(await pv.text()).toBe("%PDF-");
    expect(pv.headers.get("Referrer-Policy")).toBe("no-referrer");
    const dl = await t.call(`${path}/download`);
    expect(dl.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    await dl.arrayBuffer();
  });

  it("after revoke every new request with the old token is rejected (page, HEAD, Range, download)", async () => {
    const path = await makeLink();
    expect((await t.call(`${path}/download`, { method: "HEAD" })).status).toBe(200);
    const rv = await t.call(`/api/files/${fileId}/sharing/link`, { method: "DELETE", as: alice });
    expect(((await rv.json()) as { visibility: string }).visibility).toBe("private");
    expect((await t.call(path)).status).toBe(404);
    expect((await t.call(`${path}/preview`, { headers: { Range: "bytes=0-1" } })).status).toBe(404);
    expect((await t.call(`${path}/preview`, { method: "HEAD" })).status).toBe(404);
    expect((await t.call(`${path}/download`)).status).toBe(404);
    // A new link is a different token.
    expect(await makeLink()).not.toBe(path);
    const actions = (await db().select().from(auditEvents)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["share.link_create", "share.link_revoke"]));
  });

  it("trashed file link stops working; malformed tokens 404", async () => {
    const path = await makeLink();
    await t.call(`/api/files/${fileId}/trash`, { method: "POST", as: alice });
    expect((await t.call(path)).status).toBe(404);
    expect((await t.call("/s/short")).status).toBe(404);
    expect((await t.call(`/s/${"A".repeat(43)}/download`)).status).toBe(404);
  });

  it("audit metadata never contains the token", async () => {
    const path = await makeLink();
    const token = path.split("/")[2]!;
    const rows = await db().select().from(auditEvents);
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});

describe("share page theme", () => {
  it("follows the fn_theme cookie and ignores anything but light/dark", async () => {
    const path = await makeLink();
    const html = async (cookie?: string) => (await t.call(path, cookie ? { headers: { Cookie: cookie } } : {})).text();
    expect(await html("fn_theme=dark")).toContain('<html lang="en" class="dark">');
    expect(await html("fn_theme=light")).toContain('<html lang="en" class="light">');
    expect(await html()).toContain('<html lang="en">');
    const evil = await html('fn_theme="><script>alert(1)</script>');
    expect(evil).toContain('<html lang="en">');
    expect(evil).not.toContain("<script>alert(1)");
  });
});

describe("/api/me usage", () => {
  it("reports usedBytes for the caller only", async () => {
    const me = (await (await t.call("/api/me", { as: alice })).json()) as { user: { usedBytes: number } };
    expect(me.user.usedBytes).toBe("%PDF-1.7\nhello world".length);
    const bob = await login(await makeUser());
    const b = (await (await t.call("/api/me", { as: bob })).json()) as { user: { usedBytes: number } };
    expect(b.user.usedBytes).toBe(0);
  });
});
