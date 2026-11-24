import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Deps, Env } from "../env.ts";
import { HttpError } from "../lib/errors.ts";
import { randomToken, sha256B64url } from "../lib/crypto.ts";

/** External sign-in providers. */
export const PROVIDERS = ["google", "microsoft", "github"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const isProvider = (v: unknown): v is Provider => typeof v === "string" && (PROVIDERS as readonly string[]).includes(v);

export interface ExternalIdentity {
  provider: Provider;
  subject: string;
  email: string;
  /**
   * The provider guarantees the address belongs to this account. Only then may a
   * sign-in attach to an existing member by email (Google `email_verified`,
   * GitHub primary+verified). Microsoft's `email` claim is not verified.
   */
  emailVerified: boolean;
  name: string | null;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function msTenant(env: Env): string {
  const t = env.MICROSOFT_TENANT_ID?.trim().toLowerCase();
  return t && GUID_RE.test(t) ? t : "common";
}

export function credentials(env: Env, p: Provider): { clientId: string; clientSecret: string } | null {
  const [id, secret] =
    p === "google"
      ? [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET]
      : p === "microsoft"
        ? [env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET]
        : [env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET];
  return id && secret ? { clientId: id, clientSecret: secret } : null;
}

export const configured = (env: Env, p: Provider) => credentials(env, p) !== null;
export const configuredMap = (env: Env) => Object.fromEntries(PROVIDERS.map((p) => [p, configured(env, p)])) as Record<Provider, boolean>;

/** Google keeps the redirect URI registered before multi-provider support. */
export const callbackPath = (p: Provider) => (p === "google" ? "/auth/callback" : `/auth/callback/${p}`);

export const PROVIDER_LABEL: Record<Provider, string> = { google: "Google", microsoft: "Microsoft", github: "GitHub" };

const GOOGLE = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
};
const MS_BASE = "https://login.microsoftonline.com";
const GITHUB = {
  auth: "https://github.com/login/oauth/authorize",
  token: "https://github.com/login/oauth/access_token",
  api: "https://api.github.com",
};

const remote: Partial<Record<"google" | "microsoft", JWTVerifyGetKey>> = {};
function jwksFor(p: "google" | "microsoft", deps: Deps): JWTVerifyGetKey {
  const injected = deps.oauthJwks?.[p];
  if (injected) return injected;
  remote[p] ??= createRemoteJWKSet(new URL(p === "google" ? GOOGLE.jwks : `${MS_BASE}/common/discovery/v2.0/keys`));
  return remote[p];
}

export async function pkcePair() {
  const verifier = randomToken(48);
  const challenge = await sha256B64url(verifier);
  return { verifier, challenge };
}

export function buildAuthUrl(env: Env, p: Provider, a: { clientId: string; redirectUri: string; state: string; nonce: string; challenge: string }) {
  const u = new URL(p === "google" ? GOOGLE.auth : p === "microsoft" ? `${MS_BASE}/${msTenant(env)}/oauth2/v2.0/authorize` : GITHUB.auth);
  const q = u.searchParams;
  q.set("client_id", a.clientId);
  q.set("redirect_uri", a.redirectUri);
  q.set("state", a.state);
  q.set("code_challenge", a.challenge);
  q.set("code_challenge_method", "S256");
  if (p === "github") {
    q.set("scope", "read:user user:email");
    q.set("allow_signup", "false");
  } else {
    q.set("response_type", "code");
    q.set("scope", "openid email profile");
    q.set("nonce", a.nonce);
    q.set("prompt", "select_account");
  }
  return u.toString();
}

const fail = (code = "oauth_exchange_failed") => new HttpError(401, code, "Sign-in failed");

/** Exchange the authorization code and verify who signed in. */
export async function exchange(
  env: Env,
  deps: Deps,
  p: Provider,
  a: { clientId: string; clientSecret: string; redirectUri: string; code: string; verifier: string; nonce: string; now: number },
): Promise<ExternalIdentity> {
  const tokenUrl = p === "google" ? GOOGLE.token : p === "microsoft" ? `${MS_BASE}/${msTenant(env)}/oauth2/v2.0/token` : GITHUB.token;
  const res = await deps.oauthFetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: a.code,
      client_id: a.clientId,
      client_secret: a.clientSecret,
      redirect_uri: a.redirectUri,
      code_verifier: a.verifier,
    }),
  });
  if (!res.ok) throw fail();
  const body = (await res.json().catch(() => ({}))) as { id_token?: unknown; access_token?: unknown };
  return p === "github" ? githubIdentity(deps, body.access_token) : oidcIdentity(env, deps, p, body.id_token, a);
}

async function oidcIdentity(env: Env, deps: Deps, p: "google" | "microsoft", idToken: unknown, a: { clientId: string; nonce: string; now: number }) {
  if (typeof idToken !== "string") throw fail();
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, jwksFor(p, deps), {
      // Microsoft's issuer contains the tenant id; it is checked below.
      issuer: p === "google" ? GOOGLE.issuers : undefined,
      audience: a.clientId,
      algorithms: ["RS256"],
      currentDate: new Date(a.now),
      clockTolerance: 60,
      requiredClaims: ["sub", "exp", "iat", "iss"],
    }));
  } catch {
    throw fail("invalid_id_token");
  }
  if (payload.nonce !== a.nonce || typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255) throw fail("invalid_id_token");
  const name = typeof payload.name === "string" ? payload.name.slice(0, 200) : null;

  if (p === "google") {
    if (payload.email_verified !== true || typeof payload.email !== "string") {
      throw new HttpError(403, "email_not_verified", "Your email address is not verified");
    }
    return { provider: p, subject: payload.sub, email: payload.email.trim().toLowerCase(), emailVerified: true, name };
  }

  const tid = typeof payload.tid === "string" ? payload.tid.toLowerCase() : "";
  const pinned = msTenant(env);
  if (!GUID_RE.test(tid) || payload.iss !== `${MS_BASE}/${tid}/v2.0` || (pinned !== "common" && tid !== pinned)) throw fail("invalid_id_token");
  const raw = typeof payload.email === "string" ? payload.email : typeof payload.preferred_username === "string" ? payload.preferred_username : "";
  // `sub` is only unique per tenant+app; scope it by tenant.
  return { provider: p, subject: `${tid}:${payload.sub}`, email: raw.trim().toLowerCase().slice(0, 254), emailVerified: false, name };
}

async function githubIdentity(deps: Deps, accessToken: unknown): Promise<ExternalIdentity> {
  if (typeof accessToken !== "string" || !accessToken) throw fail();
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": "FileNest", "X-GitHub-Api-Version": "2022-11-28" };
  const [userRes, emailsRes] = await Promise.all([deps.oauthFetch(`${GITHUB.api}/user`, { headers }), deps.oauthFetch(`${GITHUB.api}/user/emails`, { headers })]);
  if (!userRes.ok || !emailsRes.ok) throw fail();
  const user = (await userRes.json().catch(() => null)) as { id?: unknown; name?: unknown; login?: unknown } | null;
  const emails = (await emailsRes.json().catch(() => null)) as { email?: unknown; primary?: unknown; verified?: unknown }[] | null;
  if (!user || typeof user.id !== "number" || !Number.isSafeInteger(user.id)) throw fail();
  const primary = Array.isArray(emails) ? emails.find((e) => e && e.primary === true) : undefined;
  if (!primary || primary.verified !== true || typeof primary.email !== "string") {
    throw new HttpError(403, "email_not_verified", "Your email address is not verified");
  }
  const name = typeof user.name === "string" && user.name ? user.name : typeof user.login === "string" ? user.login : null;
  return { provider: "github", subject: String(user.id), email: primary.email.trim().toLowerCase(), emailVerified: true, name: name?.slice(0, 200) ?? null };
}
