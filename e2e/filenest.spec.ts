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
  await expect(dialog.getByText("Only people with access").first()).toBeVisible();
  await dialog.getByRole("button", { name: "Create public link" }).click();
  await expect(dialog.getByText("Anyone with the link").first()).toBeVisible();
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

  await dialog.getByRole("button", { name: "Revoke link" }).click();
  await expect(dialog.getByText("Only people with access").first()).toBeVisible();
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
  await dialog.getByRole("button", { name: "Create public link" }).click();
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
  await page.getByRole("menuitem", { name: "API tokens" }).click();
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

test("manifest and installability basics", async ({ request }) => {
  const m = await (await request.get("/manifest.webmanifest")).json();
  expect(m).toMatchObject({ name: "FileNest", short_name: "FileNest", id: "/", start_url: "/", scope: "/", display: "standalone" });
  const sizes = m.icons.map((i: { sizes: string; purpose?: string }) => `${i.sizes}:${i.purpose ?? "any"}`);
  expect(sizes).toEqual(expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]));
  expect((await request.get("/icons/apple-touch-icon.png")).status()).toBe(200);
});

test("mobile: drive, actions menu and share sheet fit the viewport @mobile", async ({ page }) => {
  await devLogin(page);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog", { name: "Navigation" }).getByRole("link", { name: "Trash" })).toBeVisible();
  await page.getByRole("button", { name: "Close navigation" }).click();
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
