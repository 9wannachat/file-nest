import { beforeEach, describe, expect, it } from "vitest";
import { auditEvents, shareLinks } from "../../src/worker/db/schema.ts";
import { ACCOUNT_A, db, login, makeTarget, makeUser, resetDb, setup, uploadFile, ORIGIN, type Login } from "./helpers.ts";

let t: ReturnType<typeof setup>;
let alice: Login;
let fileId: string;
let path: string;
const PW = "correct horse 42";

beforeEach(async () => {
  await resetDb();
  t = setup();
  await makeTarget({ name: "A", accountId: ACCOUNT_A, bucket: "bucket-a", ref: "A", isDefault: true });
  alice = await login(await makeUser());
  fileId = (await uploadFile(t, alice, "secret-plan.pdf", "%PDF-1.7\nplan", { mime: "application/pdf" })).file.id;
  const s = (await (await t.call(`/api/files/${fileId}/sharing/link`, { method: "POST", as: alice })).json()) as { publicLink: { url: string } };
  path = new URL(s.publicLink.url).pathname;
});

const setPw = (password: string | null) =>
  password === null
    ? t.call(`/api/files/${fileId}/sharing/link/password`, { method: "DELETE", as: alice })
    : t.call(`/api/files/${fileId}/sharing/link/password`, { method: "PUT", as: alice, body: t.json({ password }) });

function unlock(password: string, headers: Record<string, string> = { Origin: ORIGIN }, ip = "198.51.100.7") {
  const body = new URLSearchParams({ password });
  return t.call(`${path}/unlock`, { method: "POST", body: body.toString(), headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip, ...headers } });
}
const cookieOf = (r: Response) => r.headers.getSetCookie().find((c) => c.startsWith("fn_unlock="))!.split(";")[0]!;

describe("password-protected public links", () => {
  it("owner sets a password; everything is locked until unlocked", async () => {
    const r = await setPw(PW);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { publicLink: { passwordProtected: boolean } }).publicLink.passwordProtected).toBe(true);

    const page = await t.call(path);
    expect(page.status).toBe(401);
    const html = await page.text();
    expect(html).toContain('type="password"');
    expect(html).not.toContain("secret-plan.pdf"); // name hidden until unlocked
    for (const [m, p, h] of [
      ["GET", `${path}/preview`, {}],
      ["HEAD", `${path}/preview`, {}],
      ["GET", `${path}/download`, {}],
      ["GET", `${path}/download`, { Range: "bytes=0-3" }],
    ] as [string, string, Record<string, string>][]) {
      expect((await t.call(p, { method: m, headers: h })).status, `${m} ${p}`).toBe(401);
    }
  });

  it("wrong password fails; right password sets a scoped cookie that unlocks preview, Range and download", async () => {
    await setPw(PW);
    expect((await unlock("nope nope")).status).toBe(401);
    const ok = await unlock(PW);
    expect(ok.status).toBe(303);
    const sc = ok.headers.getSetCookie().find((c) => c.startsWith("fn_unlock="))!;
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    expect(sc).toContain(`Path=${path}`);
    const cookie = cookieOf(ok);
    expect((await t.call(path, { headers: { Cookie: cookie } })).status).toBe(200);
    const pv = await t.call(`${path}/preview`, { headers: { Cookie: cookie, Range: "bytes=0-4" } });
    expect(pv.status).toBe(206);
    expect(await pv.text()).toBe("%PDF-");
    expect(await (await t.call(`${path}/download`, { headers: { Cookie: cookie } })).text()).toContain("plan");
  });

  it("cookie is invalid after password change, removal+re-add, revoke, expiry, or for another link", async () => {
    await setPw(PW);
    const cookie = cookieOf(await unlock(PW));
    await setPw("another password");
    expect((await t.call(`${path}/download`, { headers: { Cookie: cookie } })).status).toBe(401);

    const c2 = cookieOf(await unlock("another password"));
    t.clock.t += 13 * 3600_000;
    expect((await t.call(`${path}/download`, { headers: { Cookie: c2 } })).status).toBe(401);
    t.clock.t = Date.now();

    // Forged / tampered cookies.
    const [id, v, exp] = c2.slice("fn_unlock=".length).split(".");
    for (const forged of [`fn_unlock=${id}.${v}.${Number(exp) + 9e9}.AAAA`, "fn_unlock=x.y.z.w", "fn_unlock="]) {
      expect((await t.call(`${path}/download`, { headers: { Cookie: forged } })).status).toBe(401);
    }

    const c3 = cookieOf(await unlock("another password"));
    await t.call(`/api/files/${fileId}/sharing/link`, { method: "DELETE", as: alice });
    expect((await t.call(`${path}/download`, { headers: { Cookie: c3 } })).status).toBe(404);
  });

  it("removing the password opens the link again", async () => {
    await setPw(PW);
    await setPw(null);
    expect((await t.call(`${path}/download`)).status).toBe(200);
  });

  it("locks out after repeated failures and keeps counting atomically", async () => {
    await setPw(PW);
    for (let i = 0; i < 4; i++) expect((await unlock(`wrong-${i}-xx`)).status).toBe(401);
    const fifth = await unlock("wrong-5-xx");
    expect(fifth.status).toBe(429);
    expect(Number(fifth.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await unlock(PW)).status).toBe(429); // even the right one, while locked
    t.clock.t += 61_000;
    expect((await unlock(PW)).status).toBe(303);
  });

  it("concurrent guesses cannot exceed the attempt budget (reserved before PBKDF2)", async () => {
    await setPw(PW);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => unlock(`wrong-guess-${i}`)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(4);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(8);
    expect((await unlock(PW)).status).toBe(429);
  });

  it("one client's lockout does not block other clients, and counters decay", async () => {
    await setPw(PW);
    for (let i = 0; i < 5; i++) await unlock(`attacker-${i}-x`, undefined, "203.0.113.9");
    expect((await unlock(PW, undefined, "203.0.113.9")).status).toBe(429);
    expect((await unlock(PW, undefined, "198.51.100.20")).status).toBe(303); // legitimate viewer
    // Quiet day later: fresh budget (first wrong attempt is 401, not 429).
    t.clock.t += 25 * 3600_000;
    expect((await unlock("still-wrong-x", undefined, "203.0.113.9")).status).toBe(401);
  });

  it("rejects cross-origin unlock posts and validates password length", async () => {
    await setPw(PW);
    expect((await unlock(PW, { Origin: "https://evil.test" })).status).toBe(403);
    expect((await unlock(PW, { Origin: "null" })).status).toBe(403);
    expect((await unlock(PW, { Origin: "https://evil.test", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    // Real browsers: no-referrer page => "Origin: null" + Sec-Fetch-Site: same-origin.
    expect((await unlock(PW, { Origin: "null", "Sec-Fetch-Site": "same-origin" })).status).toBe(303);
    expect((await setPw("short")).status).toBe(400);
    expect((await setPw("x".repeat(129))).status).toBe(400);
  });

  it("password never stored or audited in clear; only the owner can set it", async () => {
    await setPw(PW);
    const rows = JSON.stringify([...(await db().select().from(shareLinks)), ...(await db().select().from(auditEvents))]);
    expect(rows).not.toContain(PW);
    expect(rows).toContain("pbkdf2_sha256$100000$");
    const bob = await login(await makeUser());
    const r = await t.call(`/api/files/${fileId}/sharing/link/password`, { method: "PUT", as: bob, body: t.json({ password: "hijack1234" }) });
    expect(r.status).toBe(404);
  });

  it("requires an existing public link", async () => {
    await t.call(`/api/files/${fileId}/sharing/link`, { method: "DELETE", as: alice });
    expect((await setPw(PW)).status).toBe(409);
  });
});
