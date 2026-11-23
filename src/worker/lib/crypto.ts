const enc = new TextEncoder();

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "===".slice((norm.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 256-bit URL-safe random token. */
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

export async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256B64url(input: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return base64url(new Uint8Array(d));
}

/** Constant-time comparison for equal-length secrets. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function aesKey(keyB64: string): Promise<CryptoKey> {
  const raw = fromBase64(keyB64);
  if (raw.length !== 32) throw new Error("APP_ENCRYPTION_KEY must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM, output = base64url(iv || ciphertext). `aad` binds the value to its row. */
export async function encryptString(keyB64: string, plaintext: string, aad: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
    await aesKey(keyB64),
    enc.encode(plaintext),
  );
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return base64url(out);
}

export async function decryptString(keyB64: string, payload: string, aad: string): Promise<string> {
  const buf = fromBase64(payload);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf.slice(0, 12), additionalData: enc.encode(aad) },
    await aesKey(keyB64),
    buf.slice(12),
  );
  return new TextDecoder().decode(pt);
}

export const PBKDF2_ITERATIONS = 100_000;

/** PBKDF2-SHA256 → "pbkdf2_sha256$<iterations>$<base64url hash>" */
export async function hashPassword(password: string, saltB64: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64(saltB64), iterations }, key, 256);
  return `pbkdf2_sha256$${iterations}$${base64url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, saltB64: string, stored: string): Promise<boolean> {
  const m = /^pbkdf2_sha256\$(\d+)\$([A-Za-z0-9_-]+)$/.exec(stored);
  if (!m) return false;
  const iterations = Number(m[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 10_000 || iterations > 2_000_000) return false;
  return timingSafeEqual(await hashPassword(password, saltB64, iterations), stored);
}

/** HMAC-SHA256 with a key derived (HKDF) from APP_ENCRYPTION_KEY for one purpose. */
async function hmacKey(keyB64: string, purpose: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", fromBase64(keyB64), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode(`filenest:${purpose}`) },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

export async function hmacSign(keyB64: string, purpose: string, message: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(keyB64, purpose), enc.encode(message));
  return base64url(new Uint8Array(sig));
}
