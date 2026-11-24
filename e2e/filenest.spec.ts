import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

/**
 * LOCAL E2E: built app + service worker on workerd, local D1, fake R2 (S3 API).
 * Not covered here (needs real services/devices): Google sign-in, real R2/CORS,
 * iOS Safari Add to Home Screen.
 */

const APP = "http://localhost:8789";

async function devLogin(page: Page, email = "admin@example.test") {
  await page.goto(`/auth/dev-login?email=${encodeURIComponent(email)}`);
  await expect(page.getByRole("heading", { name: "My Drive" })).toBeVisible();
}

async function upload(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.locator('input[type="file"]').setInputFiles(files);
  await expect(page.getByRole("region", { name: "Uploads" })).toContainText("Uploads complete", { timeout: 20_000 });
}

async function setAccess(page: Page, dialog: import("@playwright/test").Locator, option: "Restricted" | "Anyone with the link") {
  await dialog.getByRole("combobox", { name: "General access" }).click();
  await page.getByRole("option", { name: option }).click();
  await expect(dialog.getByRole("combobox", { name: "General access" })).toHaveText(option);
}

test.describe.configure({ mode: "serial" });

test("upload, preview from app origin only, rename with keyboard", async ({ page }) => {
  const foreign: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    // Presigned PUT to (fake) R2 is the only allowed non-app request.
    if (u.origin !== APP && !(r.method() === "PUT" && u.pathname.includes("/staging/"))) foreign.push(`${r.method()} ${u.origin}`);
  });
  await devLogin(page);
  const name = `notes-${Date.now()}.txt`;
  await upload(page, [{ name, mimeType: "text/plain", buffer: Buffer.from("hello e2e\nline 2") }]);
  const row = page.getByRole("listitem", { name: `File ${name}` });
  await expect(row).toBeVisible();

  await row.dblclick();
  const dialog = page.getByRole("dialog", { name });
  await expect(dialog).toBeVisible();
  const frame = dialog.frameLocator("iframe");
  await expect(frame.locator("body")).toContainText("hello e2e");
  await dialog.getByRole("button", { name: "Close" }).first().click();

  await row.focus();
  await page.keyboard.press("F2");
  const input = page.getByRole("textbox", { name: "Name", exact: true });
  await input.fill(`renamed-${name}`);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listitem", { name: `File renamed-${name}` })).toBeVisible();

  expect(foreign).toEqual([]);
});

test("public link works signed-out, and revoke blocks the old token", async ({ page, browser }) => {
  await devLogin(page);
  const name = `share-${Date.now()}.txt`;
  await upload(page, [{ name, mimeType: "text/plain", buffer: Buffer.from("shared content") }]);
  await page.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: `Share “${name}”` });
  await expect(dialog.getByRole("combobox", { name: "General access" })).toHaveText("Restricted");
  await setAccess(page, dialog, "Anyone with the link");
  const url = await dialog.getByLabel("Public link").inputValue();
  expect(url).toMatch(/^http:\/\/localhost:8789\/s\/[A-Za-z0-9_-]{43}$/);

  const anon = await browser.newContext();
  const p2 = await anon.newPage();
  const res = await p2.goto(url);
  expect(res?.status()).toBe(200);
  expect(res?.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(p2.getByRole("heading", { name })).toBeVisible();
  const dl = await p2.request.get(`${url}/download`);
  expect(await dl.text()).toBe("shared content");

  await setAccess(page, dialog, "Restricted");
  await expect(dialog.getByLabel("Public link")).toHaveCount(0);
  expect((await p2.goto(url))?.status()).toBe(404);
  expect((await p2.request.get(`${url}/preview`, { headers: { Range: "bytes=0-3" } })).status()).toBe(404);
  await anon.close();
});

test("password-protected link: locked page, real-browser unlock, scoped cookie", async ({ page, browser }) => {
  await devLogin(page);
  const name = `pw-${Date.now()}.txt`;
  await upload(page, [{ name, mimeType: "text/plain", buffer: Buffer.from("password content") }]);
  await page.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: `Share “${name}”` });
  await setAccess(page, dialog, "Anyone with the link");
  await dialog.getByRole("button", { name: "Add password" }).click();
  await dialog.getByLabel("Password", { exact: true }).fill("e2e-secret-pass");
  await dialog.getByRole("button", { name: "Save password" }).click();
  await expect(dialog.getByText("Password required to open")).toBeVisible();
  const url = await dialog.getByLabel("Public link").inputValue();

  const anon = await browser.newContext();
  const p2 = await anon.newPage();
  expect((await p2.goto(url))?.status()).toBe(401);
  await expect(p2.getByText(name)).toHaveCount(0);
  expect((await p2.request.get(`${url}/download`)).status()).toBe(401);
  await p2.getByLabel("Password").fill("wrong-password");
  await p2.getByRole("button", { name: "Unlock" }).click();
  await expect(p2.getByRole("alert")).toHaveText("Incorrect password.");
  await p2.getByLabel("Password").fill("e2e-secret-pass");
  await p2.getByRole("button", { name: "Unlock" }).click();
  await expect(p2.getByRole("heading", { name })).toBeVisible();
  await expect(p2.frameLocator("iframe").locator("body")).toContainText("password content");
  await anon.close();
});

test("settings: create and revoke an API token", async ({ page, request }) => {
  await devLogin(page);
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("menuitem", { name: "Settings & API tokens" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("e2e token");
  await page.getByRole("button", { name: "Create token" }).click();
  const tokenBox = page.getByLabel("New token", { exact: true });
  await expect(tokenBox).toHaveValue(/^fnpat_[A-Za-z0-9_-]{43}$/);
  const token = await tokenBox.inputValue();
  await page.getByRole("button", { name: "Done" }).click();
  // `request` has no browser cookies: token-only, like the MCP server.
  expect((await request.get("/api/folders/root", { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(200);
  await page.getByRole("button", { name: "Revoke e2e token" }).click();
  await expect(page.getByText("Revoked").first()).toBeVisible();
  expect((await request.get("/api/folders/root", { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401);
});

test("offline shows status without cached file lists", async ({ page, context }) => {
  await devLogin(page);
  const name = `offline-${Date.now()}.txt`;
  await upload(page, [{ name, mimeType: "text/plain", buffer: Buffer.from("x") }]);
  // Wait for the service worker to control the page so the app shell is cached.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText("You are offline. An internet connection is required")).toBeVisible();
  await expect(page.getByText(name)).toHaveCount(0);
  // Nothing user-specific in Cache Storage.
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) urls.push(new URL(r.url).pathname);
    return urls;
  });
  expect(cached.filter((u) => /^\/(api|auth|s)\//.test(u))).toEqual([]);
  await context.setOffline(false);
});

test("logout revokes access; members cannot open admin", async ({ page }) => {
  await devLogin(page);
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect((await page.request.get("/api/folders/root")).status()).toBe(401);

  // Non-invited dev login is refused.
  await page.goto("/auth/dev-login?email=stranger@example.test");
  await expect(page.getByRole("heading", { name: "No access" })).toBeVisible();
});

test("theme: System follows the OS, explicit choice persists, share page matches", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await devLogin(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("menuitem", { name: "Theme" }).click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/); // no flash back to light: set before React mounts
  expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe("dark");

  // The server-rendered share page follows the same choice via the fn_theme cookie.
  const name = `theme-${Date.now()}.txt`;
  await upload(page, [{ name, mimeType: "text/plain", buffer: Buffer.from("t") }]);
  await page.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: `Share “${name}”` });
  await setAccess(page, dialog, "Anyone with the link");
  const url = await dialog.getByLabel("Public link").inputValue();
  await page.goto(url);
  await expect(page.locator("html")).toHaveClass("dark");

  // Back to System for the remaining tests.
  await page.goto("/settings");
  await page.getByRole("radio", { name: "System" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});

test("language: Thai on the sign-in page and in the app, switch back without losing the page", async ({ page, browser }) => {
  const anon = await browser.newContext();
  const p = await anon.newPage();
  await p.goto("/login");
  await p.getByRole("button", { name: "Language" }).click();
  await p.getByRole("menuitemradio", { name: "ไทย" }).click();
  await expect(p.locator("html")).toHaveAttribute("lang", "th");
  await expect(p.getByRole("link", { name: "ดำเนินการต่อด้วย Google" })).toBeVisible();
  await p.reload();
  await expect(p.getByRole("link", { name: "ดำเนินการต่อด้วย Google" })).toBeVisible(); // remembered via fn_lang
  await anon.close();

  await devLogin(page);
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("menuitem", { name: "Language" }).click();
  await page.getByRole("menuitemradio", { name: "ไทย" }).click();
  await expect(page.getByRole("link", { name: "ไดรฟ์ของฉัน" }).first()).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByText("การแสดงผล", { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "English" }).click();
  await expect(page.getByText("Appearance", { exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

function totp(secretB32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secretB32.replace(/\s/g, "")) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const off = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

test("invite → password sign-up → 2FA → password+TOTP sign-in → admin ban", async ({ page, browser }) => {
  await devLogin(page);
  const email = `pw-${Date.now()}@example.test`;
  await page.goto("/admin/invitations");
  await page.getByLabel(/^Email \(optional/).fill(email);
  await page.getByRole("button", { name: "Create link" }).click();
  const url = await page.getByLabel("New invitation link").inputValue();
  expect(url).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);

  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const password = "e2e-Strong-passphrase-1";
  await p.goto(url);
  await expect(p.getByRole("heading", { name: "Join FileNest" })).toBeVisible();
  await p.getByLabel("Name").fill("E2E Person");
  await expect(p.getByLabel("Email", { exact: true })).toHaveValue(email); // bound to the invitation
  await p.getByLabel("Password (10+ characters)").fill(password);
  await p.getByLabel("Confirm password").fill(password);
  await p.getByRole("button", { name: "Create account" }).click();
  await expect(p.getByRole("heading", { name: "My Drive" })).toBeVisible();

  // Enable 2FA from Settings.
  await p.goto("/settings");
  await p.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = (await p.locator("#mfa-secret").textContent())!.replace(/\s/g, "");
  await expect(p.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  await p.getByLabel("6-digit code").fill(totp(secret));
  await p.getByRole("button", { name: "Turn on 2FA" }).click();
  await expect(p.getByRole("list", { name: "Recovery codes" }).getByRole("listitem")).toHaveCount(10);
  await p.getByRole("button", { name: "I saved them" }).click();
  await expect(p.getByText("Two-factor authentication").first()).toBeVisible();

  // Sign out, sign back in with password + TOTP (next 30 s window to avoid replay).
  await p.getByRole("button", { name: /^Account:/ }).click();
  await p.getByRole("menuitem", { name: "Sign out" }).click();
  await p.getByLabel("Email", { exact: true }).fill(email);
  await p.getByLabel("Password", { exact: true }).fill(password);
  await p.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(p.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
  expect((await p.request.get("/api/me")).status()).toBe(401); // no session before the second factor
  await p.waitForTimeout(Math.max(0, 30_000 - (Date.now() % 30_000)) + 200);
  await p.getByLabel("Authentication code").fill(totp(secret));
  await p.getByRole("button", { name: "Verify" }).click();
  await expect(p.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible(); // returns to where they signed out
  expect((await p.request.get("/api/me")).status()).toBe(200);

  // Admin bans the member: their next request is rejected.
  await page.goto("/admin/members");
  await page.getByRole("link", { name: new RegExp(email) }).click();
  await page.getByRole("button", { name: "Ban", exact: true }).click();
  await page.getByLabel("Reason (shown in the audit log)").fill("e2e test");
  await page.getByRole("button", { name: "Ban member" }).click();
  await expect(page.getByText("Banned: e2e test")).toBeVisible();
  expect((await p.request.get("/api/me")).status()).toBe(401);
  await ctx.close();
});

test("admin settings: changes save and apply (password sign-in switch)", async ({ page, browser }) => {
  await devLogin(page);
  await page.goto("/admin/settings");
  await page.getByRole("switch", { name: "Sign in with email and password" }).click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("All changes saved")).toBeVisible();
  const anon = await browser.newContext();
  const p = await anon.newPage();
  await p.goto("/login");
  await expect(p.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  await expect(p.getByRole("form", { name: "Sign in with email" })).toHaveCount(0);
  await anon.close();
  await page.getByRole("switch", { name: "Sign in with email and password" }).click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("All changes saved")).toBeVisible();
});

test("storage quota: warning, blocked upload, Empty trash frees space", async ({ page, browser }) => {
  await devLogin(page);
  const email = `quota-${Date.now()}@example.test`;
  const csrf = await page.evaluate(async () => ((await (await fetch("/api/me")).json()) as { csrfToken: string }).csrfToken);
  const adminApi = (method: string, path: string, body?: unknown) =>
    page.evaluate(
      async ([m, p, b, t]) => (await fetch(p as string, { method: m as string, headers: { "Content-Type": "application/json", "X-CSRF-Token": t as string }, body: b ? JSON.stringify(b) : undefined })).status,
      [method, path, body, csrf] as const,
    );
  expect(await adminApi("POST", "/api/admin/members", { email })).toBe(201);

  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await devLogin(p, email);
  const myId = await p.evaluate(async () => ((await (await fetch("/api/me")).json()) as { user: { id: string } }).user.id);
  expect(await adminApi("PATCH", `/api/admin/members/${myId}`, { quotaBytes: 10 })).toBe(200);
  await p.reload();

  await upload(p, [{ name: "eight.bin", mimeType: "application/octet-stream", buffer: Buffer.from("12345678") }]);
  await p.reload();
  await expect(p.getByText("You’ve used 80% of your storage.")).toBeVisible();

  await p.locator('input[type="file"]').setInputFiles([{ name: "five.bin", mimeType: "application/octet-stream", buffer: Buffer.from("12345") }]);
  await expect(p.getByText("Not enough storage left for this file")).toBeVisible();

  // Trash still counts; Empty trash frees the space.
  await p.getByRole("button", { name: "Actions for eight.bin" }).click();
  await p.getByRole("menuitem", { name: "Move to trash" }).click();
  await p.goto("/trash");
  await p.getByRole("button", { name: "Empty trash" }).click();
  await p.getByRole("alertdialog").getByRole("button", { name: "Empty trash" }).click();
  await expect(p.getByText("Trash is empty")).toBeVisible();
  await p.goto("/");
  await expect(p.getByText(/of your storage|storage is full/)).toHaveCount(0);
  await upload(p, [{ name: "five.bin", mimeType: "application/octet-stream", buffer: Buffer.from("12345") }]);
  await expect(p.getByRole("listitem", { name: "File five.bin" })).toBeVisible();
  await ctx.close();
});

test("storage capacity adds up: A fills first, then uploads go to B", async ({ page }) => {
  await devLogin(page);
  const csrf = await page.evaluate(async () => ((await (await fetch("/api/me")).json()) as { csrfToken: string }).csrfToken);
  const apiCall = (method: string, path: string, body?: unknown) =>
    page.evaluate(
      async ([m, p, b, t]) => {
        const r = await fetch(p as string, { method: m as string, headers: { "Content-Type": "application/json", "X-CSRF-Token": t as string }, body: b ? JSON.stringify(b) : undefined });
        return { status: r.status, json: await r.json().catch(() => null) };
      },
      [method, path, body, csrf] as const,
    );

  // Add target B through the UI (same fake R2, different bucket), then make A small.
  const bucketB = `e2e-b-${Date.now()}`;
  await page.goto("/admin/storage");
  await page.getByLabel("Display name").fill(`R2 B ${Date.now()}`);
  await page.getByLabel("Cloudflare account ID").fill("0".repeat(32));
  await page.getByLabel("Bucket name").fill(bucketB);
  await page.getByLabel("Credential ref").fill("LOCAL");
  await page.getByRole("button", { name: "Add target" }).click();
  await expect(page.getByText(`Bucket ${bucketB}`, { exact: false })).toBeVisible();

  const list = (await apiCall("GET", "/api/admin/storage")).json as { targets: { id: string; bucket: string; usedBytes: number; reservedBytes: number }[] };
  const a = list.targets[0]!;
  const b = list.targets.find((t) => t.bucket === bucketB)!;
  expect((await apiCall("PATCH", `/api/admin/storage/${a.id}`, { capacityBytes: a.usedBytes + a.reservedBytes + 10 })).status).toBe(200);

  const before = new Map(list.targets.map((t) => [t.id, t.usedBytes]));
  await page.goto("/");
  await upload(page, [{ name: `fits-a-${Date.now()}.bin`, mimeType: "application/octet-stream", buffer: Buffer.from("12345678") }]);
  await upload(page, [{ name: `goes-b-${Date.now()}.bin`, mimeType: "application/octet-stream", buffer: Buffer.from("12345678") }]);
  const after = (await apiCall("GET", "/api/admin/storage")).json as { targets: { id: string; usedBytes: number }[] };
  const grew = (id: string) => after.targets.find((t) => t.id === id)!.usedBytes - before.get(id)!;
  expect(grew(a.id)).toBe(8);
  expect(grew(b.id)).toBe(8);

  await page.goto("/admin/storage");
  // A still has 2 bytes free, so it stays first in line for tiny files; B offers the large free space.
  const status = page.getByRole("status").filter({ hasText: "Next upload goes to" });
  await expect(status).toContainText("Largest file that fits right now: 10.0 GB");
  // Restore A for the other tests.
  expect((await apiCall("PATCH", `/api/admin/storage/${a.id}`, { capacityBytes: null })).status).toBe(200);
});

test("manifest and installability basics", async ({ request }) => {
  const m = await (await request.get("/manifest.webmanifest")).json();
  expect(m).toMatchObject({ name: "FileNest", short_name: "FileNest", id: "/", start_url: "/", scope: "/", display: "standalone" });
  const sizes = m.icons.map((i: { sizes: string; purpose?: string }) => `${i.sizes}:${i.purpose ?? "any"}`);
  expect(sizes).toEqual(expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]));
  expect((await request.get("/icons/apple-touch-icon.png")).status()).toBe(200);
});

test("mobile: drive, actions menu and share sheet fit the viewport @mobile", async ({ page }) => {
  await devLogin(page);
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  const nav = page.getByRole("dialog", { name: "Navigation" });
  await expect(nav.getByRole("link", { name: "Trash" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(nav).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Upload" }).last()).toBeVisible(); // floating action button
  const name = `m-${Date.now()}.txt`;
  await upload(page, [{ name, mimeType: "text/plain", buffer: Buffer.from("m") }]);
  const btn = page.getByRole("button", { name: `Actions for ${name}` });
  const box = await btn.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(40);
  expect(box!.height).toBeGreaterThanOrEqual(40);
  await btn.click();
  await page.getByRole("menuitem", { name: "Share" }).click();
  const sheet = page.getByRole("dialog", { name: `Share “${name}”` });
  const vb = page.viewportSize()!;
  const sb = (await sheet.boundingBox())!;
  expect(sb.x).toBeGreaterThanOrEqual(0);
  expect(sb.x + sb.width).toBeLessThanOrEqual(vb.width + 1);
});
