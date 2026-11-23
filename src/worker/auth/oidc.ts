import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { HttpError } from "../lib/errors.ts";
import { base64url, randomToken, sha256B64url } from "../lib/crypto.ts";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

let remoteJwks: JWTVerifyGetKey | null = null;
export function googleJwks(): JWTVerifyGetKey {
  remoteJwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return remoteJwks;
}

export async function pkcePair() {
  const verifier = randomToken(48);
  const challenge = await sha256B64url(verifier);
  return { verifier, challenge };
}

export function buildAuthUrl(p: { clientId: string; redirectUri: string; state: string; nonce: string; challenge: string }) {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", p.state);
  u.searchParams.set("nonce", p.nonce);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
}

/** Exchange the authorization code and verify the ID token (iss, aud, exp, sig, nonce, email_verified). */
export async function exchangeCode(p: {
  fetchImpl: typeof fetch;
  jwks: JWTVerifyGetKey;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  verifier: string;
  nonce: string;
  now: number;
}): Promise<GoogleIdentity> {
  const res = await p.fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: p.code,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      redirect_uri: p.redirectUri,
      code_verifier: p.verifier,
    }),
  });
  if (!res.ok) throw new HttpError(401, "oauth_exchange_failed", "Sign-in failed");
  const body = (await res.json()) as { id_token?: unknown };
  if (typeof body.id_token !== "string") throw new HttpError(401, "oauth_exchange_failed", "Sign-in failed");

  let payload;
  try {
    ({ payload } = await jwtVerify(body.id_token, p.jwks, {
      issuer: GOOGLE_ISSUERS,
      audience: p.clientId,
      algorithms: ["RS256"],
      currentDate: new Date(p.now),
      clockTolerance: 60,
      requiredClaims: ["sub", "exp", "iat"],
    }));
  } catch {
    throw new HttpError(401, "invalid_id_token", "Sign-in failed");
  }
  if (payload.nonce !== p.nonce) throw new HttpError(401, "invalid_id_token", "Sign-in failed");
  if (typeof payload.sub !== "string" || !payload.sub) throw new HttpError(401, "invalid_id_token", "Sign-in failed");
  if (payload.email_verified !== true || typeof payload.email !== "string") {
    throw new HttpError(403, "email_not_verified", "Your Google email is not verified");
  }
  return {
    sub: payload.sub,
    email: payload.email.trim().toLowerCase(),
    name: typeof payload.name === "string" ? payload.name.slice(0, 200) : null,
  };
}

export { base64url };
