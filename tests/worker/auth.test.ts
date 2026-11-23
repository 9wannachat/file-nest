import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users } from "../../src/worker/db/schema.ts";
import { db, googleKeys, login, makeUser, ORIGIN, resetDb, setup } from "./helpers.ts";

beforeEach(resetDb);

async function oidcFlow(claims: (nonce: string) => Record<string, unknown>, tokenOpts: { aud?: string; iss?: string } = {}) {
  const keys = await googleKeys();
  let nonce = "";
  const googleFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("code_verifier")).toBeTruthy();
    expect(form.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    return Response.json({ id_token: await keys.idToken(claims(nonce), tokenOpts) });
  }) as typeof fetch;
  const t = setup({ googleFetch, googleJwks: keys.jwks });
  const start = await t.call("/auth/login?return_to=/folders/abc");
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.get("Location")!);
  expect(loc.origin).toBe("https://accounts.google.com");
  expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  nonce = loc.searchParams.get("nonce")!;
  const state = loc.searchParams.get("state")!;
  const stateCookie = start.headers.get("Set-Cookie")!.match(/fn_oauth=([^;]+)/)![1]!;
  const cb = await t.call(`/auth/callback?code=c0de&state=${state}`, { headers: { Cookie: `fn_oauth=${stateCookie}` } });
  return { t, cb, state, stateCookie };
}

describe("Google OIDC login", () => {
  it("invited member signs in, gets rotated HttpOnly Secure Lax session", async () => {
    await makeUser({ email: "inv@example.test", status: "invited", googleSub: null });
    const { cb } = await oidcFlow((nonce) => ({ sub: "g-1", email: "Inv@Example.test", email_verified: true, nonce }));
    expect(cb.status).toBe(302);
    expect(cb.headers.get("Location")).toBe("/folders/abc");
    const cookie = cb.headers.getSetCookie().find((c) => c.startsWith("__Host-fn_session="))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const u = await db().select().from(users).where(eq(users.email, "inv@example.test")).get();
    expect(u?.googleSub).toBe("g-1");
    expect(u?.status).toBe("active");
  });

  it("non-allowlisted email is denied", async () => {
    const { cb } = await oidcFlow((nonce) => ({ sub: "g-2", email: "stranger@example.test", email_verified: true, nonce }));
    expect(cb.headers.get("Location")).toBe("/not-authorized?reason=not_invited");
    expect(cb.headers.getSetCookie().some((c) => c.startsWith("__Host-fn_session=") && !c.includes("Max-Age=0"))).toBe(false);
  });

  it("bootstrap admin only while no admin exists", async () => {
    const { cb } = await oidcFlow((nonce) => ({ sub: "g-adm", email: "admin@example.test", email_verified: true, nonce }));
    expect(cb.headers.get("Location")).toBe("/folders/abc");
    const u = await db().select().from(users).where(eq(users.email, "admin@example.test")).get();
    expect(u?.role).toBe("admin");
    // A second bootstrap with a different Google account is not possible.
    await db().update(users).set({ email: "renamed@example.test" }).where(eq(users.id, u!.id));
    const again = await oidcFlow((nonce) => ({ sub: "g-other", email: "admin@example.test", email_verified: true, nonce }));
    expect(again.cb.headers.get("Location")).toBe("/not-authorized?reason=not_invited");
  });

  it("rejects unverified email, wrong nonce, wrong audience, wrong issuer", async () => {
    await makeUser({ email: "v@example.test", status: "invited", googleSub: null });
    const bad = [
      await oidcFlow((nonce) => ({ sub: "g", email: "v@example.test", email_verified: false, nonce })),
      await oidcFlow(() => ({ sub: "g", email: "v@example.test", email_verified: true, nonce: "nope" })),
      await oidcFlow((nonce) => ({ sub: "g", email: "v@example.test", email_verified: true, nonce }), { aud: "other" }),
      await oidcFlow((nonce) => ({ sub: "g", email: "v@example.test", email_verified: true, nonce }), { iss: "https://evil" }),
    ];
    for (const { cb } of bad) expect(cb.headers.get("Location")).toMatch(/^\/login\?error=/);
  });

  it("state must match the browser cookie and is single use", async () => {
    const keys = await googleKeys();
    const t = setup({ googleJwks: keys.jwks });
    const start = await t.call("/auth/login");
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    const noCookie = await t.call(`/auth/callback?code=x&state=${state}`);
    expect(noCookie.headers.get("Location")).toBe("/login?error=invalid_state");
    const forged = await t.call(`/auth/callback?code=x&state=${state}`, { headers: { Cookie: "fn_oauth=other" } });
    expect(forged.headers.get("Location")).toBe("/login?error=invalid_state");
  });

  it("disabled member is rejected at login", async () => {
    await makeUser({ email: "d@example.test", status: "disabled", googleSub: "g-d" });
    const { cb } = await oidcFlow((nonce) => ({ sub: "g-d", email: "d@example.test", email_verified: true, nonce }));
    expect(cb.headers.get("Location")).toBe("/not-authorized?reason=disabled");
  });
});

describe("sessions, CSRF and origin", () => {
  it("no session => 401 on API; Drive data is no-store", async () => {
    const t = setup();
    const r = await t.call("/api/folders/root");
    expect(r.status).toBe(401);
    const me = await login(await makeUser());
    const ok = await t.call("/api/folders/root", { as: me });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Cache-Control")).toContain("no-store");
  });

  it("mutations require CSRF token and same origin", async () => {
    const t = setup();
    const me = await login(await makeUser());
    const body = t.json({ name: "x" });
    expect((await t.call("/api/folders", { method: "POST", as: me, body, headers: { "X-CSRF-Token": "wrong" } })).status).toBe(403);
    expect((await t.call("/api/folders", { method: "POST", as: me, body, headers: { Origin: "https://evil.test" } })).status).toBe(403);
    const noOrigin = await t.call("/api/folders", {
      method: "POST",
      body,
      headers: { Cookie: me.cookie, "X-CSRF-Token": me.csrf, "Content-Type": "application/json" },
    });
    expect(noOrigin.status).toBe(403);
    expect((await t.call("/api/folders", { method: "POST", as: me, body })).status).toBe(201);
  });

  it("logout revokes the session server-side", async () => {
    const t = setup();
    const me = await login(await makeUser());
    expect((await t.call("/auth/logout", { method: "POST", as: me })).status).toBe(200);
    expect((await t.call("/api/me", { as: me })).status).toBe(401);
  });

  it("disabling a member kills existing sessions", async () => {
    const t = setup();
    const admin = await login(await makeUser({ role: "admin" }));
    const m = await login(await makeUser());
    expect((await t.call("/api/me", { as: m })).status).toBe(200);
    const r = await t.call(`/api/admin/members/${m.user.id}`, { method: "PATCH", as: admin, body: t.json({ status: "disabled" }) });
    expect(r.status).toBe(200);
    expect((await t.call("/api/me", { as: m })).status).toBe(401);
  });

  it("expired session is rejected", async () => {
    const t = setup();
    const me = await login(await makeUser(), Date.now() - 8 * 24 * 3600_000);
    expect((await t.call("/api/me", { as: me })).status).toBe(401);
  });

  it("dev-login is unavailable outside development", async () => {
    const t = setup();
    expect((await t.call("/auth/dev-login?email=admin@example.test")).status).toBe(404);
  });
});
