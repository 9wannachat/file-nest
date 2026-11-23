import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from "jose";
import { createApp } from "../../src/worker/app.ts";
import { getDb } from "../../src/worker/db/client.ts";
import { appSettings, storageTargets, USER_SECURITY_DEFAULTS, users, type User } from "../../src/worker/db/schema.ts";
import { createSession } from "../../src/worker/auth/session.ts";
import { createFakeS3, type FakeS3 } from "../../src/dev/fake-s3.ts";
import { loadConfig, type Env } from "../../src/worker/env.ts";
import { eq } from "drizzle-orm";

export const ORIGIN = "https://filenest.test";
export const ACCOUNT_A = "a".repeat(32);
export const ACCOUNT_B = "b".repeat(32);
export const HOST_A = `${ACCOUNT_A}.r2.cloudflarestorage.com`;
export const HOST_B = `${ACCOUNT_B}.r2.cloudflarestorage.com`;

export const testEnv = env as unknown as Env;
export const db = () => getDb(testEnv.DB);

export interface Clock {
  t: number;
}

export async function googleKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  async function idToken(claims: Record<string, unknown>, opts: { aud?: string; iss?: string; exp?: number } = {}) {
    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuer(opts.iss ?? "https://accounts.google.com")
      .setAudience(opts.aud ?? "test-client-id")
      .setIssuedAt();
    jwt = jwt.setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 600);
    return jwt.sign(privateKey);
  }
  return { jwks, idToken };
}

export function setup(
  opts: { googleFetch?: typeof fetch; googleJwks?: import("jose").JWTVerifyGetKey; beforeS3?: (req: Request) => Promise<void> } = {},
) {
  const clock: Clock = { t: Date.now() };
  const s3: FakeS3 = createFakeS3({ allowedOrigins: [ORIGIN], now: () => clock.t });
  const s3Fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input, init);
    if (opts.beforeS3) await opts.beforeS3(req.clone());
    return s3.fetch(req);
  }) as typeof fetch;
  const app = createApp({
    s3Fetch,
    googleFetch: opts.googleFetch ?? (async () => new Response("no", { status: 500 })),
    googleJwks: opts.googleJwks,
    now: () => clock.t,
  });

  async function call(path: string, init: RequestInit & { as?: Login } = {}) {
    const headers = new Headers(init.headers);
    if (init.as) {
      headers.set("Cookie", init.as.cookie);
      const m = (init.method ?? "GET").toUpperCase();
      if (!["GET", "HEAD"].includes(m)) {
        if (!headers.has("X-CSRF-Token")) headers.set("X-CSRF-Token", init.as.csrf);
        if (!headers.has("Origin")) headers.set("Origin", ORIGIN);
      }
    }
    if (init.body && typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(ORIGIN + path, { ...init, headers }), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  const json = (body: unknown) => JSON.stringify(body);

  return { app, s3, clock, call, json, ctx: { db: db(), env: testEnv, config: loadConfig(testEnv), deps: { s3Fetch: s3.fetch, googleFetch: fetch, now: () => clock.t } } };
}

export interface Login {
  user: User;
  cookie: string;
  csrf: string;
}

let seq = 0;
export async function makeUser(p: Partial<User> = {}): Promise<User> {
  seq++;
  const now = Date.now();
  const u: User = {
    id: crypto.randomUUID(),
    email: `user${seq}-${crypto.randomUUID().slice(0, 6)}@example.test`,
    googleSub: `sub-${crypto.randomUUID()}`,
    name: `User ${seq}`,
    role: "member",
    status: "active",
    quotaBytes: 50 * 1024 * 1024,
    invitedBy: null,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,
    ...USER_SECURITY_DEFAULTS,
    ...p,
  };
  await db().insert(users).values(u);
  return u;
}

export async function login(user: User, now = Date.now()): Promise<Login> {
  const { token, session } = await createSession(db(), user.id, now);
  return { user, cookie: `__Host-fn_session=${token}`, csrf: session.csrfToken };
}

export async function makeTarget(p: { name: string; accountId: string; bucket: string; ref: "A" | "B"; isDefault?: boolean; capacityBytes?: number | null; priority?: number }) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db()
    .insert(storageTargets)
    .values({
      id,
      name: p.name,
      accountId: p.accountId,
      bucket: p.bucket,
      credentialRef: p.ref,
      acceptingUploads: true,
      // Tests default to unlimited capacity; isDefault puts the target first in line.
      capacityBytes: p.capacityBytes ?? null,
      priority: p.priority ?? (p.isDefault ? 0 : 10),
      createdAt: now,
      updatedAt: now,
    });
  return id;
}

export const enc = (s: string) => new TextEncoder().encode(s);

/** Browser-side PUT to the presigned URL. */
export async function browserPut(s3: FakeS3, putUrl: string, headers: Record<string, string>, body: Uint8Array | string) {
  return s3.fetch(putUrl, { method: "PUT", headers, body: typeof body === "string" ? enc(body) : body });
}

/** create -> PUT -> finalize */
export async function uploadFile(
  t: ReturnType<typeof setup>,
  as: Login,
  name: string,
  content: Uint8Array | string,
  opts: { mime?: string; folderId?: string | null } = {},
) {
  const bytes = typeof content === "string" ? enc(content) : content;
  const created = await t.call("/api/uploads", {
    method: "POST",
    as,
    body: t.json({ name, size: bytes.length, mime: opts.mime ?? "application/octet-stream", folderId: opts.folderId ?? null }),
  });
  if (created.status !== 201) throw new Error(`create failed ${created.status} ${await created.text()}`);
  const c = (await created.json()) as { uploadId: string; putUrl: string; putHeaders: Record<string, string> };
  const put = await browserPut(t.s3, c.putUrl, c.putHeaders, bytes);
  if (!put.ok) throw new Error(`put failed ${put.status}`);
  const fin = await t.call(`/api/uploads/${c.uploadId}/finalize`, { method: "POST", as });
  if (fin.status !== 200) throw new Error(`finalize failed ${fin.status} ${await fin.text()}`);
  const body = (await fin.json()) as { file: { id: string; name: string; contentType: string; inline: boolean } };
  return { ...c, file: body.file };
}

export async function resetDb() {
  const d = testEnv.DB;
  for (const t of [
    "audit_events",
    "object_deletions",
    "share_links",
    "file_shares",
    "upload_sessions",
    "files",
    "folders",
    "sessions",
    "oauth_states",
    "api_tokens",
    "mfa_challenges",
    "recovery_codes",
    "password_resets",
    "invitation_uses",
    "invitations",
    "auth_attempts",
    "system_settings",
  ]) {
    await d.prepare(`DELETE FROM ${t}`).run();
  }
  await d.prepare("UPDATE app_settings SET default_storage_id = NULL").run();
  await d.prepare("DELETE FROM storage_targets").run();
  await d.prepare("DELETE FROM users").run();
  // Baseline: 2FA optional (policy tests switch it on explicitly).
  await d.prepare(`INSERT INTO system_settings (key, value, updated_at) VALUES ('mfaPolicy', '"optional"', 0)`).run();
}
