import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import { userIdentities, users } from "../../src/worker/db/schema.ts";
import { db, googleKeys, login, makeUser, ORIGIN, resetDb, setup, type Login } from "./helpers.ts";

const TID = "11111111-2222-3333-4444-555555555555";
const MS_ISS = `https://login.microsoftonline.com/${TID}/v2.0`;

type Keys = Awaited<ReturnType<typeof googleKeys>>;
let keys: Keys;
let t: ReturnType<typeof setup>;
let admin: Login;

/** What the fake identity providers answer with. */
const idp: {
  ms: (nonce: string) => Record<string, unknown>;
  msIss: string;
  ghUser: unknown;
  ghEmails: unknown;
  tokenCalls: { url: string; form: URLSearchParams }[];
} = { ms: () => ({}), msIss: MS_ISS, ghUser: null, ghEmails: null, tokenCalls: [] };
let nonce = "";

const oauthFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/oauth2/v2.0/token")) {
    idp.tokenCalls.push({ url, form: new URLSearchParams(String(init?.body)) });
    return Response.json({ id_token: await keys.idToken(idp.ms(nonce), { iss: idp.msIss, aud: "ms-client-id" }) });
  }
  if (url === "https://github.com/login/oauth/access_token") {
    idp.tokenCalls.push({ url, form: new URLSearchParams(String(init?.body)) });
    return Response.json({ access_token: "gho_test" });
  }
  if (url === "https://api.github.com/user") return Response.json(idp.ghUser);
  if (url === "https://api.github.com/user/emails") return Response.json(idp.ghEmails);
  return new Response("unexpected", { status: 500 });
}) as typeof fetch;

beforeEach(async () => {
  await resetDb();
  keys = await googleKeys();
  t = setup({ oauthFetch, oauthJwks: { google: keys.jwks, microsoft: keys.jwks } });
  admin = await login(await makeUser({ role: "admin", email: "admin@example.test" }));
  idp.ms = (n) => ({ sub: "ms-sub-1", tid: TID, email: "ms@example.test", name: "Ms User", nonce: n });
  idp.msIss = MS_ISS;
  idp.ghUser = { id: 4242, login: "octo", name: "Octo Cat" };
  idp.ghEmails = [{ email: "gh@example.test", primary: true, verified: true }];
  idp.tokenCalls = [];
});

const oauthCookie = (r: Response) => r.headers.getSetCookie().find((c) => c.startsWith("fn_oauth="))!.split(";")[0]!;

/** Start at /auth/login/<p> (or a given start response) and come back through the callback. */
async function flow(provider: "microsoft" | "github", opts: { query?: string; cookie?: string; start?: Response } = {}) {
  const start = opts.start ?? (await t.call(`/auth/login/${provider}${opts.query ? `?${opts.query}` : ""}`));
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.get("Location")!);
  nonce = loc.searchParams.get("nonce") ?? "";
  const state = loc.searchParams.get("state")!;
  const cookie = [opts.cookie, oauthCookie(start)].filter(Boolean).join("; ");
  const cb = await t.call(`/auth/callback/${provider}?code=c0de&state=${state}`, { headers: { Cookie: cookie } });
  return { loc, cb, location: cb.headers.get("Location") };
}

const identitiesOf = (userId: string) => db().select().from(userIdentities).where(eq(userIdentities.userId, userId)).all();

async function invite(body: Record<string, unknown>) {
  const r = await t.call("/api/admin/invitations", { method: "POST", as: admin, body: t.json(body) });
  expect(r.status).toBe(201);
  return ((await r.json()) as { url: string }).url.split("/invite/")[1]!;
}

describe("provider config", () => {
  it("lists every enabled + configured provider and hides switched-off ones", async () => {
    expect(await (await t.call("/auth/config")).json()).toMatchObject({ google: true, microsoft: true, github: true, password: true });
    expect((await t.call("/api/admin/settings", { method: "PUT", as: admin, body: t.json({ githubEnabled: false }) })).status).toBe(200);
    expect(await (await t.call("/auth/config")).json()).toMatchObject({ github: false, microsoft: true });
    expect((await t.call("/auth/login/github")).headers.get("Location")).toBe("/login?error=method_disabled");
    expect((await t.call("/auth/login/nope")).status).toBe(404);
    const s = (await (await t.call("/api/admin/settings", { as: admin })).json()) as { configured: Record<string, boolean> };
    expect(s.configured).toEqual({ google: true, microsoft: true, github: true });
  });

  it("switching a provider off also stops a sign-in already in flight", async () => {
    await makeUser({ email: "gh@example.test", status: "invited", googleSub: null });
    const start = await t.call("/auth/login/github");
    await t.call("/api/admin/settings", { method: "PUT", as: admin, body: t.json({ githubEnabled: false }) });
    expect((await flow("github", { start })).location).toBe("/login?error=method_disabled");
  });

  it("a state started for one provider is not accepted by another provider's callback", async () => {
    const start = await t.call("/auth/login/github");
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    const cb = await t.call(`/auth/callback/microsoft?code=x&state=${state}`, { headers: { Cookie: oauthCookie(start) } });
    expect(cb.headers.get("Location")).toBe("/login?error=invalid_state");
    expect((await t.call(`/auth/callback/google?code=x&state=${state}`)).status).toBe(404); // Google keeps /auth/callback
  });
});

describe("GitHub", () => {
  it("signs in an allowlisted member by primary verified email, with state + PKCE", async () => {
    const u = await makeUser({ email: "gh@example.test", status: "invited", googleSub: null });
    const { loc, location, cb } = await flow("github", { query: "return_to=/folders/x" });
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback/github`);
    expect(idp.tokenCalls[0]!.form.get("code_verifier")).toBeTruthy();
    expect(location).toBe("/folders/x");
    expect(cb.headers.getSetCookie().some((c) => c.startsWith("__Host-fn_session="))).toBe(true);
    expect((await identitiesOf(u.id)).map((i) => [i.provider, i.subject])).toEqual([["github", "4242"]]);
    // Next time the GitHub id alone is enough; a changed provider email never rewrites the member's email.
    idp.ghEmails = [{ email: "renamed@example.test", primary: true, verified: true }];
    expect((await flow("github")).location).toBe("/");
    expect((await db().select().from(users).where(eq(users.id, u.id)).get())!.email).toBe("gh@example.test");
    expect((await identitiesOf(u.id))[0]!.email).toBe("renamed@example.test");
  });

  it("rejects an unverified primary email even when another email is verified", async () => {
    await makeUser({ email: "gh@example.test", status: "invited", googleSub: null });
    idp.ghEmails = [
      { email: "gh@example.test", primary: true, verified: false },
      { email: "other@example.test", primary: false, verified: true },
    ];
    expect((await flow("github")).location).toBe("/login?error=email_not_verified");
  });

  it("does not take over a member already linked to a different GitHub account", async () => {
    const u = await makeUser({ email: "gh@example.test", googleSub: null });
    await db().insert(userIdentities).values({ provider: "github", subject: "999", userId: u.id, email: u.email, createdAt: Date.now() });
    expect((await flow("github")).location).toBe("/not-authorized?reason=account_mismatch");
  });

  it("a verified email never joins an account that can already sign in (connect from Settings instead)", async () => {
    const pw = await makeUser({ email: "gh@example.test", googleSub: null, passwordHash: "x", passwordSalt: "x" });
    expect((await flow("github")).location).toBe("/not-authorized?reason=link_required");
    expect(await identitiesOf(pw.id)).toEqual([]);
  });

  it("an email-bound invite claimed with Microsoft is not later joined by Google/GitHub on that email", async () => {
    const bound = await invite({ email: "gh@example.test" });
    expect((await flow("microsoft", { query: `invite=${bound}` })).location).toBe("/");
    const u = (await db().select().from(users).where(eq(users.email, "gh@example.test")).get())!;
    expect((await flow("github")).location).toBe("/not-authorized?reason=link_required");
    expect((await identitiesOf(u.id)).map((i) => i.provider)).toEqual(["microsoft"]);
  });

  it("a member with 2FA gets the MFA step, not a session", async () => {
    await makeUser({ email: "gh@example.test", status: "invited", googleSub: null });
    // Linked already, so 2FA (set below) is what stands between the sign-in and a session.
    expect((await flow("github")).location).toBe("/");
    await db().update(users).set({ totpEnabledAt: Date.now(), totpSecretEnc: "x" }).where(eq(users.email, "gh@example.test"));
    const { cb, location } = await flow("github");
    expect(location).toMatch(/^\/mfa\?/);
    expect(cb.headers.getSetCookie().some((c) => c.startsWith("__Host-fn_session="))).toBe(false);
    expect(cb.headers.getSetCookie().some((c) => c.startsWith("fn_mfa="))).toBe(true);
  });

  it("an open invitation accepts GitHub sign-up", async () => {
    const token = await invite({ maxUses: 5 });
    const { location } = await flow("github", { query: `invite=${token}` });
    expect(location).toBe("/");
    const u = (await db().select().from(users).where(eq(users.email, "gh@example.test")).get())!;
    expect((await identitiesOf(u.id)).map((i) => i.provider)).toEqual(["github"]);
  });
});

describe("Microsoft", () => {
  it("verifies the token but never attaches to an existing member by email", async () => {
    const u = await makeUser({ email: "ms@example.test", status: "invited", googleSub: null });
    const { loc, location } = await flow("microsoft");
    expect(loc.origin + loc.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback/microsoft`);
    expect(location).toBe("/not-authorized?reason=not_invited");
    expect(await identitiesOf(u.id)).toEqual([]);
  });

  it("bootstrap admin is not possible with an unverified Microsoft email", async () => {
    await db().delete(users);
    idp.ms = (n) => ({ sub: "boot", tid: TID, email: "admin@example.test", nonce: n });
    expect((await flow("microsoft")).location).toBe("/not-authorized?reason=not_invited");
  });

  it("rejects bad issuer/tenant, audience and nonce", async () => {
    const token = await invite({ email: "new@example.test" });
    const cases: [() => Record<string, unknown>, string][] = [
      [() => ({ sub: "s", tid: TID, email: "x@example.test", nonce }), "https://login.microsoftonline.com/99999999-2222-3333-4444-555555555555/v2.0"],
      [() => ({ sub: "s", email: "x@example.test", nonce }), MS_ISS],
      [() => ({ sub: "s", tid: TID, email: "x@example.test", nonce: "wrong" }), MS_ISS],
    ];
    for (const [claims, iss] of cases) {
      idp.ms = claims;
      idp.msIss = iss;
      expect((await flow("microsoft", { query: `invite=${token}` })).location).toBe("/login?error=signin_failed");
    }
    expect(await db().select().from(users).where(eq(users.email, "new@example.test")).get()).toBeUndefined();
  });

  it("signs up only through an email-bound invitation, using the invitation's address", async () => {
    const open = await invite({ maxUses: 5 });
    expect((await t.call(`/auth/login/microsoft?invite=${open}`)).headers.get("Location")).toBe("/login?error=invite_needs_email");
    const info = (await (await t.call(`/auth/invite/${open}`)).json()) as { methods: Record<string, boolean> };
    expect(info.methods).toMatchObject({ google: true, github: true, microsoft: false, password: false });

    const bound = await invite({ email: "invitee@example.test" });
    idp.ms = (n) => ({ sub: "ms-new", tid: TID, email: "attacker-chosen@example.test", nonce: n });
    expect((await flow("microsoft", { query: `invite=${bound}` })).location).toBe("/");
    const u = (await db().select().from(users).where(eq(users.email, "invitee@example.test")).get())!;
    expect((await identitiesOf(u.id)).map((i) => [i.provider, i.subject])).toEqual([["microsoft", `${TID}:ms-new`]]);
    expect(await db().select().from(users).where(eq(users.email, "attacker-chosen@example.test")).get()).toBeUndefined();
    // Afterwards the Microsoft account signs straight in.
    expect((await flow("microsoft")).location).toBe("/");
  });

  it("MICROSOFT_TENANT_ID pins the tenant", async () => {
    const pinned = { ...env, MICROSOFT_TENANT_ID: "aaaaaaaa-2222-3333-4444-555555555555" };
    const ctx = (await import("cloudflare:test")).createExecutionContext();
    const start = await t.app.fetch(new Request(`${ORIGIN}/auth/login/microsoft`), pinned, ctx);
    expect(new URL(start.headers.get("Location")!).pathname).toBe("/aaaaaaaa-2222-3333-4444-555555555555/oauth2/v2.0/authorize");
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    nonce = new URL(start.headers.get("Location")!).searchParams.get("nonce")!;
    const cb = await t.app.fetch(
      new Request(`${ORIGIN}/auth/callback/microsoft?code=c&state=${state}`, { headers: { Cookie: oauthCookie(start) } }),
      pinned,
      ctx,
    );
    expect(cb.headers.get("Location")).toBe("/login?error=signin_failed"); // token is from TID, not the pinned tenant
  });
});

describe("connected sign-in methods", () => {
  const connect = (as: Login, p: string) => t.call(`/api/account/identities/${p}`, { method: "POST", as });

  it("connects Microsoft to the signed-in member, then Microsoft signs in", async () => {
    const me = await login(await makeUser({ email: "me@example.test", googleSub: null, passwordHash: "x", passwordSalt: "x" }));
    const r = await connect(me, "microsoft");
    expect(r.status).toBe(200);
    const { url } = (await r.json()) as { url: string };
    const start = new Response(null, { status: 302, headers: { Location: url, "Set-Cookie": r.headers.get("Set-Cookie")! } });
    expect((await flow("microsoft", { start, cookie: me.cookie })).location).toBe("/settings?linked=microsoft");
    expect((await identitiesOf(me.user.id)).map((i) => i.provider)).toEqual(["microsoft"]);
    const acct = (await (await t.call("/api/account", { as: me })).json()) as { identities: string[]; availableProviders: string[] };
    expect(acct.identities).toEqual(["microsoft"]);
    expect(acct.availableProviders).toEqual(["google", "microsoft", "github"]);
    expect((await flow("microsoft")).location).toBe("/");
    expect((await connect(me, "microsoft")).status).toBe(409);
  });

  it("the callback only links for the member who started it", async () => {
    const me = await login(await makeUser({ googleSub: null }));
    const other = await login(await makeUser({ googleSub: null }));
    const r = await connect(me, "github");
    const start = new Response(null, { status: 302, headers: { Location: ((await r.json()) as { url: string }).url, "Set-Cookie": r.headers.get("Set-Cookie")! } });
    expect((await flow("github", { start, cookie: other.cookie })).location).toBe("/login?error=invalid_state");
    expect(await identitiesOf(other.user.id)).toEqual([]);
    expect(await identitiesOf(me.user.id)).toEqual([]);
  });

  it("refuses an account already used by another member", async () => {
    const taken = await makeUser({ googleSub: null });
    await db().insert(userIdentities).values({ provider: "github", subject: "4242", userId: taken.id, email: null, createdAt: Date.now() });
    const me = await login(await makeUser({ googleSub: null }));
    const r = await connect(me, "github");
    const start = new Response(null, { status: 302, headers: { Location: ((await r.json()) as { url: string }).url, "Set-Cookie": r.headers.get("Set-Cookie")! } });
    expect((await flow("github", { start, cookie: me.cookie })).location).toBe("/settings?link_error=identity_in_use");
  });

  it("needs a recent sign-in and a browser session", async () => {
    const u = await makeUser({ googleSub: null });
    const stale = await login(u, Date.now() - 20 * 60_000);
    expect(((await (await connect(stale, "github")).json()) as { error: { code: string } }).error.code).toBe("reauth_required");
    const fresh = await login(u);
    const tok = (await (await t.call("/api/tokens", { method: "POST", as: fresh, body: t.json({ name: "t" }) })).json()) as { token: string };
    const bearer = await t.call("/api/account/identities/github", { method: "POST", headers: { Authorization: `Bearer ${tok.token}` } });
    expect(bearer.status).toBe(403);
    expect((await connect(fresh, "nope")).status).toBe(404);
  });

  it("disconnecting never removes the last way to sign in", async () => {
    const u = await makeUser(); // Google only
    const me = await login(u);
    const del = (p: string) => t.call(`/api/account/identities/${p}`, { method: "DELETE", as: me });
    expect(((await (await del("google")).json()) as { error: { code: string } }).error.code).toBe("last_method");
    expect((await del("github")).status).toBe(404);
    await db().insert(userIdentities).values({ provider: "github", subject: "1", userId: u.id, email: null, createdAt: Date.now() });
    expect((await del("google")).status).toBe(200);
    expect((await identitiesOf(u.id)).map((i) => i.provider)).toEqual(["github"]);
    expect((await del("github")).status).toBe(409);
    // A password only counts while password sign-in is switched on.
    await db().update(users).set({ passwordHash: "x", passwordSalt: "x" }).where(eq(users.id, u.id));
    await t.call("/api/admin/settings", { method: "PUT", as: admin, body: t.json({ passwordEnabled: false }) });
    expect(((await (await del("github")).json()) as { error: { code: string } }).error.code).toBe("last_method");
    await t.call("/api/admin/settings", { method: "PUT", as: admin, body: t.json({ passwordEnabled: true }) });
    // Sessions created through the disconnected provider end (other than this one).
    const { createSession } = await import("../../src/worker/auth/session.ts");
    const viaGh = await createSession(db(), u.id, Date.now(), { authMethod: "github" });
    expect((await del("github")).status).toBe(200);
    expect((await t.call("/api/me", { headers: { Cookie: `__Host-fn_session=${viaGh.token}` } })).status).toBe(401);
    expect((await t.call("/api/me", { as: me })).status).toBe(200);
    const ev = await db().select().from((await import("../../src/worker/db/schema.ts")).auditEvents).all();
    expect(ev.some((e) => e.action === "account.identity_unlink")).toBe(true);
  });

  it("admin member list shows linked providers (dev logins hidden)", async () => {
    const u = await makeUser({ email: "multi@example.test" });
    await db().insert(userIdentities).values({ provider: "github", subject: "77", userId: u.id, email: null, createdAt: Date.now() });
    const dev = await makeUser({ googleSub: "dev:x@example.test" });
    const list = (await (await t.call("/api/admin/members", { as: admin })).json()) as { members: { id: string; identities: string[] }[] };
    expect(list.members.find((m) => m.id === u.id)!.identities).toEqual(["github", "google"]);
    expect(list.members.find((m) => m.id === dev.id)!.identities).toEqual([]);
  });
});

describe("migration 0006", () => {
  it("copies users.google_sub into user_identities", async () => {
    const m = (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS.find((x) => x.name.startsWith("0006"))!;
    const copy = m.queries.find((q) => q.includes("INSERT INTO user_identities"))!;
    const u = await makeUser({ googleSub: null });
    const d = await makeUser({ googleSub: null });
    await db().update(users).set({ googleSub: "legacy-sub" }).where(eq(users.id, u.id));
    await db().update(users).set({ googleSub: "dev:d@example.test" }).where(eq(users.id, d.id));
    await env.DB.prepare(copy).run();
    expect(await db().select().from(userIdentities).where(and(eq(userIdentities.provider, "google"), eq(userIdentities.subject, "legacy-sub"))).get()).toMatchObject({ userId: u.id });
    expect((await identitiesOf(d.id)).map((i) => i.provider)).toEqual(["dev"]);
  });
});
