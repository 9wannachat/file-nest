import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditEvents, sessions, users } from "../../src/worker/db/schema.ts";
import { base32Decode, hotp, stepAt } from "../../src/worker/lib/totp.ts";
import { db, login, makeUser, ORIGIN, resetDb, setup, type Login } from "./helpers.ts";

let t: ReturnType<typeof setup>;
let admin: Login;
const PW = "a-Strong-passphrase-42";

beforeEach(async () => {
  await resetDb();
  t = setup();
  admin = await login(await makeUser({ role: "admin", email: "root@example.test" }));
});

const json = (o: unknown) => JSON.stringify(o);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  t.call(path, { method: "POST", body: json(body), headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "198.51.100.1", ...headers } });
const cookieFrom = (r: Response, name: string) => r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0];
const sessionCookie = (r: Response) => cookieFrom(r, "__Host-fn_session");

async function invite(body: Record<string, unknown> = {}) {
  const r = await t.call("/api/admin/invitations", { method: "POST", as: admin, body: t.json(body) });
  expect(r.status).toBe(201);
  const inv = (await r.json()) as { id: string; url: string };
  return { ...inv, token: inv.url.split("/invite/")[1]! };
}

async function register(token: string, email?: string, password = PW) {
  return post(`/auth/invite/${token}/register`, { email, name: "New", password });
}

/** Email-bound invitation + password sign-up. */
async function signUp(email: string, password = PW) {
  const inv = await invite({ email });
  return register(inv.token, email, password);
}

async function totpNow(secret: string, offsetSteps = 0) {
  return hotp(base32Decode(secret), stepAt(t.clock.t) + offsetSteps);
}

/** Session from a password login (no 2FA). */
async function passwordSession(email: string, password = PW): Promise<Login> {
  const r = await post("/auth/password/login", { email, password });
  expect(r.status).toBe(200);
  const cookie = sessionCookie(r)!;
  const me = (await (await t.call("/api/me", { headers: { Cookie: cookie } })).json()) as { csrfToken: string; user: { id: string } };
  const user = (await db().select().from(users).where(eq(users.id, me.user.id)).get())!;
  return { user, cookie, csrf: me.csrfToken };
}

describe("TOTP", () => {
  it("matches RFC 6238 test vectors (SHA-1)", async () => {
    const secret = new TextEncoder().encode("12345678901234567890");
    expect(await hotp(secret, Math.floor(59 / 30), 8)).toBe("94287082");
    expect(await hotp(secret, Math.floor(1111111109 / 30), 8)).toBe("07081804");
    expect(await hotp(secret, Math.floor(20000000000 / 30), 8)).toBe("65353130");
  });
});

describe("invitation sign-up with email + password", () => {
  it("creates an active member, signs in, and counts the use", async () => {
    const inv = await invite({ email: "New.Person@Example.test" });
    const info = (await (await t.call(`/auth/invite/${inv.token}`)).json()) as { valid: boolean; methods: { password: boolean } };
    expect(info).toMatchObject({ valid: true, methods: { password: true } });
    const r = await register(inv.token);
    expect(r.status).toBe(201);
    expect(sessionCookie(r)).toBeTruthy();
    const u = (await db().select().from(users).where(eq(users.email, "new.person@example.test")).get())!;
    expect(u.status).toBe("active");
    expect(u.passwordHash).toMatch(/^pbkdf2_sha256\$20000\$/);
    expect(u.passwordHash).not.toContain(PW);
  });

  it("rejects weak passwords, email mismatch, reuse, revoked, expired and closed registration", async () => {
    const bound = await invite({ email: "bound@example.test" });
    expect((await register(bound.token, "bound@example.test", "short")).status).toBe(400);
    expect((await register(bound.token, "bound@example.test", "password123")).status).toBe(400);
    // Email-bound: the invite email wins over what the client sends.
    expect((await register(bound.token, "someone-else@example.test")).status).toBe(201);
    expect(await db().select().from(users).where(eq(users.email, "bound@example.test")).get()).toBeTruthy();
    expect((await register(bound.token, "x@example.test")).status).toBe(410); // used up

    const rv = await invite({ email: "r@example.test" });
    await t.call(`/api/admin/invitations/${rv.id}`, { method: "DELETE", as: admin });
    expect((await register(rv.token)).status).toBe(410);

    const ex = await invite({ email: "e@example.test", expiresInDays: 1 });
    t.clock.t += 2 * 24 * 3600_000;
    expect((await register(ex.token)).status).toBe(410);
    t.clock.t = Date.now();

    const closed = await invite({ email: "c@example.test" });
    await t.call("/api/admin/settings", { method: "PUT", as: admin, body: t.json({ registrationMode: "closed" }) });
    expect((await register(closed.token)).status).toBe(403);
    expect((await t.call(`/auth/invite/${closed.token}`)).status).toBe(404);
  });

  it("concurrent sign-ups on one link create one account", async () => {
    const inv = await invite({ email: "race@example.test" });
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => register(inv.token)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
  });

  it("open (multi-use) links allow Google only, so nobody can claim an arbitrary email with a password", async () => {
    const inv = await invite({ maxUses: 5 });
    const info = (await (await t.call(`/auth/invite/${inv.token}`)).json()) as { methods: { password: boolean } };
    expect(info.methods.password).toBe(false);
    expect((await register(inv.token, "ceo@example.test")).status).toBe(403);
    expect(await db().select().from(users).where(eq(users.email, "ceo@example.test")).get()).toBeUndefined();
  });
});

describe("password login", () => {
  beforeEach(async () => {
    await signUp("pw@example.test");
  });

  it("generic errors: unknown email and wrong password look the same", async () => {
    const a = await post("/auth/password/login", { email: "nobody@example.test", password: PW }, { "CF-Connecting-IP": "203.0.113.1" });
    const b = await post("/auth/password/login", { email: "pw@example.test", password: "wrong-password-xx" }, { "CF-Connecting-IP": "203.0.113.2" });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(await a.json()).toEqual(await b.json());
  });

  it("locks a guessing client, not the real user; success refunds the client's budget", async () => {
    const attacker = "203.0.113.66";
    const owner = "198.51.100.200";
    for (let i = 0; i < 5; i++) await post("/auth/password/login", { email: "pw@example.test", password: `nope-nope-${i}` }, { "CF-Connecting-IP": attacker });
    expect((await post("/auth/password/login", { email: "pw@example.test", password: PW }, { "CF-Connecting-IP": attacker })).status).toBe(429);
    expect((await post("/auth/password/login", { email: "pw@example.test", password: PW }, { "CF-Connecting-IP": owner })).status).toBe(200);
    // An office network: many successful sign-ins from one IP never lock.
    for (let i = 0; i < 8; i++) expect((await post("/auth/password/login", { email: "pw@example.test", password: PW }, { "CF-Connecting-IP": owner })).status).toBe(200);
    t.clock.t += 61_000;
    expect((await post("/auth/password/login", { email: "pw@example.test", password: PW }, { "CF-Connecting-IP": attacker })).status).toBe(200);
  });

  it("distributed guessing still hits the per-account cap", async () => {
    const results = [];
    for (let i = 0; i < 32; i++) results.push((await post("/auth/password/login", { email: "pw@example.test", password: `x-wrong-${i}-x` }, { "CF-Connecting-IP": `192.0.2.${i}` })).status);
    expect(results).toContain(429);
  });

  it("requires same origin and respects the method switch and bans", async () => {
    expect((await post("/auth/password/login", { email: "pw@example.test", password: PW }, { Origin: "https://evil.test" })).status).toBe(403);
    await t.call("/api/admin/settings", { method: "PUT", as: admin, body: t.json({ passwordEnabled: false }) });
    expect((await post("/auth/password/login", { email: "pw@example.test", password: PW })).status).toBe(403);
    await t.call("/api/admin/settings", { method: "PUT", as: admin, body: t.json({ passwordEnabled: true }) });
    const u = (await db().select().from(users).where(eq(users.email, "pw@example.test")).get())!;
    await t.call(`/api/admin/members/${u.id}/ban`, { method: "POST", as: admin, body: t.json({ reason: "spam" }) });
    // Banned: same generic answer as a wrong password (no account-state oracle).
    const banned = await post("/auth/password/login", { email: "pw@example.test", password: PW });
    expect(banned.status).toBe(401);
    expect(((await banned.json()) as { error: { code: string } }).error.code).toBe("invalid_credentials");
  });

  it("changing the password signs out other sessions", async () => {
    const s1 = await passwordSession("pw@example.test");
    const s2 = await passwordSession("pw@example.test");
    const r = await t.call("/api/account/password", { method: "PUT", as: s1, body: t.json({ newPassword: "another-Strong-passphrase-7" }) });
    expect(r.status).toBe(200);
    expect((await t.call("/api/me", { as: s2 })).status).toBe(401);
    expect((await t.call("/api/me", { as: s1 })).status).toBe(200);
  });
});

describe("two-factor authentication", () => {
  let me: Login;
  let secret: string;
  let recovery: string[];

  beforeEach(async () => {
    await signUp("mfa@example.test");
    me = await passwordSession("mfa@example.test");
    const setupRes = (await (await t.call("/api/account/2fa/setup", { method: "POST", as: me })).json()) as { secret: string; otpauthUrl: string };
    secret = setupRes.secret;
    expect(setupRes.otpauthUrl).toMatch(/^otpauth:\/\/totp\/FileNest%3Amfa%40example\.test\?secret=/);
    expect((await t.call("/api/account/2fa/enable", { method: "POST", as: me, body: t.json({ code: "000000" }) })).status).toBe(400);
    const ok = await t.call("/api/account/2fa/enable", { method: "POST", as: me, body: t.json({ code: await totpNow(secret) }) });
    expect(ok.status).toBe(200);
    recovery = ((await ok.json()) as { recoveryCodes: string[] }).recoveryCodes;
    expect(recovery).toHaveLength(10);
    const row = (await db().select().from(users).where(eq(users.email, "mfa@example.test")).get())!;
    expect(row.totpSecretEnc).not.toContain(secret);
    t.clock.t += 31_000; // next code window
  });

  it("password step returns a challenge, not a session; TOTP completes it once", async () => {
    const r = await post("/auth/password/login", { email: "mfa@example.test", password: PW });
    expect(((await r.json()) as { status: string }).status).toBe("mfa_required");
    expect(sessionCookie(r)).toBeUndefined();
    const mfa = cookieFrom(r, "fn_mfa")!;
    expect((await post("/auth/mfa/verify", { code: "123456" }, { Cookie: mfa })).status).toBe(401);
    const code = await totpNow(secret);
    const v = await post("/auth/mfa/verify", { code }, { Cookie: mfa });
    expect(v.status).toBe(200);
    expect(sessionCookie(v)).toBeTruthy();
    // Challenge is single use and the same TOTP code cannot be replayed.
    expect((await post("/auth/mfa/verify", { code }, { Cookie: mfa })).status).toBe(401);
    const r2 = await post("/auth/password/login", { email: "mfa@example.test", password: PW });
    expect((await post("/auth/mfa/verify", { code }, { Cookie: cookieFrom(r2, "fn_mfa")! })).status).toBe(401);
  });

  it("recovery codes work once; challenges expire; attempts are limited", async () => {
    const r = await post("/auth/password/login", { email: "mfa@example.test", password: PW });
    const mfa = cookieFrom(r, "fn_mfa")!;
    expect((await post("/auth/mfa/verify", { recoveryCode: recovery[0] }, { Cookie: mfa })).status).toBe(200);
    const r2 = await post("/auth/password/login", { email: "mfa@example.test", password: PW });
    expect((await post("/auth/mfa/verify", { recoveryCode: recovery[0] }, { Cookie: cookieFrom(r2, "fn_mfa")! })).status).toBe(401);

    const r3 = await post("/auth/password/login", { email: "mfa@example.test", password: PW });
    const c3 = cookieFrom(r3, "fn_mfa")!;
    t.clock.t += 6 * 60_000;
    expect((await post("/auth/mfa/verify", { code: await totpNow(secret) }, { Cookie: c3 })).status).toBe(401);

    const r4 = await post("/auth/password/login", { email: "mfa@example.test", password: PW });
    const c4 = cookieFrom(r4, "fn_mfa")!;
    const tries = await Promise.all(Array.from({ length: 8 }, (_, i) => post("/auth/mfa/verify", { code: String(100000 + i) }, { Cookie: c4 })));
    expect(tries.filter((x) => x.status === 429).length).toBeGreaterThanOrEqual(3);
  });

  it("disabling needs recent re-auth; admins cannot disable when required", async () => {
    t.clock.t += 11 * 60_000; // session older than the re-auth window
    expect((await t.call("/api/account/2fa/disable", { method: "POST", as: me })).status).toBe(403);
    expect((await t.call("/api/account/reauth", { method: "POST", as: me, body: t.json({ code: "111111" }) })).status).toBe(401);
    expect((await t.call("/api/account/reauth", { method: "POST", as: me, body: t.json({ code: await totpNow(secret) }) })).status).toBe(200);
    expect((await t.call("/api/account/2fa/disable", { method: "POST", as: me })).status).toBe(200);
  });
});

describe("2FA policy enforcement", () => {
  it("an admin without 2FA gets a setup-only session until enrolled", async () => {
    const inv = await invite({ role: "admin", email: "newadmin@example.test" });
    await t.call("/api/admin/settings", { method: "PUT", as: admin, body: t.json({ mfaPolicy: "admins" }) });
    // The policy now also gates the existing admin session (no 2FA yet) and API tokens.
    expect((await t.call("/api/admin/members", { as: admin })).status).toBe(403);
    const r = await register(inv.token);
    const cookie = sessionCookie(r)!;
    const me = (await (await t.call("/api/me", { headers: { Cookie: cookie } })).json()) as { csrfToken: string; mfa: { setupRequired: boolean } };
    expect(me.mfa.setupRequired).toBe(true);
    const as = { cookie, csrf: me.csrfToken, user: (await db().select().from(users).where(eq(users.email, "newadmin@example.test")).get())! };
    expect((await t.call("/api/folders/root", { as })).status).toBe(403);
    expect((await t.call("/api/admin/members", { as })).status).toBe(403);
    const s = (await (await t.call("/api/account/2fa/setup", { method: "POST", as })).json()) as { secret: string };
    expect((await t.call("/api/account/2fa/enable", { method: "POST", as, body: t.json({ code: await totpNow(s.secret) }) })).status).toBe(200);
    expect((await t.call("/api/folders/root", { as })).status).toBe(200);
  });
});

describe("admin-issued password reset", () => {
  it("is single use, expires, and signs the member out everywhere", async () => {
    await signUp("reset@example.test");
    const s = await passwordSession("reset@example.test");
    const link = await t.call(`/api/admin/members/${s.user.id}/password-reset`, { method: "POST", as: admin });
    expect(link.status).toBe(201);
    const token = ((await link.json()) as { url: string }).url.split("/reset-password/")[1]!;
    expect(((await (await t.call(`/auth/password-reset/${token}`)).json()) as { email: string }).email).toBe("reset@example.test");
    expect((await post(`/auth/password-reset/${token}`, { password: "brand-New-passphrase-9" })).status).toBe(200);
    expect((await post(`/auth/password-reset/${token}`, { password: "brand-New-passphrase-9" })).status).toBe(410);
    expect((await t.call("/api/me", { as: s })).status).toBe(401);
    expect((await post("/auth/password/login", { email: "reset@example.test", password: "brand-New-passphrase-9" })).status).toBe(200);
    const actions = (await db().select().from(auditEvents)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["member.password_reset_link", "auth.password_reset"]));
    expect(JSON.stringify(await db().select().from(auditEvents))).not.toContain(token);
  });
});

export { sessions };
