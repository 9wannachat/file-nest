import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../env.ts";
import { authOf, appOrigin, requireSameOrigin, requireUser, sessionOf } from "../auth/middleware.ts";
import { account } from "./account.ts";
import { admin } from "./admin.ts";
import { getSettings, mfaRequired } from "../services/settings.ts";
import * as tokens from "../services/tokens.ts";
import { fileFor } from "../authz.ts";
import { serveFile } from "../services/content.ts";
import * as drive from "../services/drive.ts";
import * as members from "../services/members.ts";
import * as shares from "../services/shares.ts";
import { abortUpload, createUpload, finalizeUpload, presignParts, resumableUploads, uploadedParts } from "../services/uploads.ts";
import { files } from "../db/schema.ts";
import { HttpError } from "../lib/errors.ts";
import { eq, sql } from "drizzle-orm";
import { idParam, jsonBody, now, storageCtx } from "./util.ts";

export const api = new Hono<AppEnv>();

api.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store, private");
  c.header("X-Content-Type-Options", "nosniff");
});
api.get("/health", (c) => c.json({ ok: true }));

api.use(
  "*",
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: { code: "body_too_large", message: "Request too large" } }, 413),
  }),
);
api.use("*", requireSameOrigin);
api.use("*", requireUser);

// ---- session ----
api.get("/me", async (c) => {
  const { user, session } = authOf(c);
  const settings = await getSettings(c.get("db"), c.get("config"));
  const used = await c
    .get("db")
    .select({
      n: sql<number>`coalesce(sum(${files.size}), 0)`,
      trashed: sql<number>`coalesce(sum(CASE WHEN ${files.trashedAt} IS NOT NULL THEN ${files.size} ELSE 0 END), 0)`,
    })
    .from(files)
    .where(eq(files.ownerId, user.id))
    .get();
  return c.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role, quotaBytes: user.quotaBytes, usedBytes: used?.n ?? 0, trashedBytes: used?.trashed ?? 0, quotaUnlimited: user.quotaUnlimited },
    csrfToken: session?.csrfToken ?? null,
    auth: session ? "session" : "token",
    mfa: { enabled: !!user.totpEnabledAt, setupRequired: !!c.get("mfaSetupRequired"), required: mfaRequired(settings, user.role) },
    limits: { maxUploadBytes: settings.maxUploadBytes },
  });
});

// ---- folders ----
api.get("/folders/root", async (c) => c.json(await drive.listFolder(c.get("db"), authOf(c).user.id, null)));
api.get("/folders/:id", async (c) => c.json(await drive.listFolder(c.get("db"), authOf(c).user.id, idParam(c))));
api.post("/folders", async (c) => {
  const b = await jsonBody(c);
  return c.json(await drive.createFolder(c.get("db"), authOf(c).user.id, b, now(c)), 201);
});
api.patch("/folders/:id", async (c) => {
  const b = await jsonBody(c);
  return c.json(await drive.updateFolder(c.get("db"), authOf(c).user.id, idParam(c), b, now(c)));
});
api.post("/folders/:id/trash", async (c) => {
  await drive.trashFolder(c.get("db"), authOf(c).user.id, idParam(c), now(c));
  return c.json({ ok: true });
});
api.post("/folders/:id/restore", async (c) => {
  await drive.restoreFolder(c.get("db"), authOf(c).user.id, idParam(c), now(c));
  return c.json({ ok: true });
});
api.delete("/folders/:id", async (c) => {
  await drive.purgeFolder(c.get("db"), authOf(c).user.id, idParam(c), now(c));
  return c.json({ ok: true });
});

// ---- listings ----
api.get("/shared", async (c) => c.json({ files: await drive.listShared(c.get("db"), authOf(c).user.id) }));
api.get("/trash", async (c) => c.json(await drive.listTrash(c.get("db"), authOf(c).user.id)));
/** Permanently delete everything in the caller's trash (frees quota). Batched; returns what is left. */
api.post("/trash/empty", async (c) => c.json(await drive.emptyTrash(c.get("db"), authOf(c).user.id, now(c))));
api.get("/search", async (c) => c.json(await drive.search(c.get("db"), authOf(c).user.id, c.req.query("q") ?? "")));

// ---- files ----
api.get("/files/:id", async (c) => {
  const f = await fileFor(c.get("db"), authOf(c).user.id, idParam(c), "read");
  return c.json(await drive.fileDtoFor(c.get("db"), authOf(c).user.id, f.id));
});
api.patch("/files/:id", async (c) => {
  const b = await jsonBody(c);
  return c.json(await drive.updateFile(c.get("db"), authOf(c).user.id, idParam(c), b, now(c)));
});
api.post("/files/:id/trash", async (c) => {
  await drive.trashFile(c.get("db"), authOf(c).user.id, idParam(c), now(c));
  return c.json({ ok: true });
});
api.post("/files/:id/restore", async (c) => {
  await drive.restoreFile(c.get("db"), authOf(c).user.id, idParam(c), now(c));
  return c.json({ ok: true });
});
api.delete("/files/:id", async (c) => {
  await drive.purgeFile(c.get("db"), authOf(c).user.id, idParam(c), now(c));
  return c.json({ ok: true });
});
// GET also answers HEAD in Hono; the handler checks the method.
for (const mode of ["preview", "download"] as const) {
  api.get(`/files/:id/${mode}`, async (c) => {
    const file = await fileFor(c.get("db"), authOf(c).user.id, idParam(c), "read");
    return serveFile(storageCtx(c), file, c.req.raw, mode);
  });
}

// ---- sharing (owner only) ----
async function sharingResponse(c: Parameters<typeof idParam>[0]) {
  const s = await getSettings(c.get("db"), c.get("config"));
  const r = await shares.getSharing(c.get("db"), c.env, authOf(c).user, idParam(c), appOrigin(c));
  return { ...r, policy: { publicLinksEnabled: s.publicLinksEnabled, requirePassword: s.publicLinksRequirePassword } };
}
api.get("/files/:id/sharing", async (c) =>
  c.json(await sharingResponse(c)),
);
api.put("/files/:id/sharing/members", async (c) => {
  const b = await jsonBody(c);
  await shares.setMemberShares(c.get("db"), authOf(c).user, idParam(c), b.userIds, now(c));
  return c.json(await sharingResponse(c));
});
api.post("/files/:id/sharing/link", async (c) => {
  if (!(await getSettings(c.get("db"), c.get("config"))).publicLinksEnabled) {
    throw new HttpError(403, "public_links_disabled", "Public links are turned off by an Admin");
  }
  await shares.createPublicLink(c.get("db"), c.env, authOf(c).user, idParam(c), appOrigin(c), now(c));
  return c.json(await sharingResponse(c), 201);
});
api.delete("/files/:id/sharing/link", async (c) => {
  await shares.revokePublicLink(c.get("db"), authOf(c).user, idParam(c), now(c));
  return c.json(await sharingResponse(c));
});
api.put("/files/:id/sharing/link/password", async (c) => {
  const b = await jsonBody(c);
  await shares.setLinkPassword(c.get("db"), authOf(c).user, idParam(c), b.password, now(c));
  return c.json(await sharingResponse(c));
});
api.delete("/files/:id/sharing/link/password", async (c) => {
  await shares.setLinkPassword(c.get("db"), authOf(c).user, idParam(c), null, now(c));
  return c.json(await sharingResponse(c));
});

// ---- personal access tokens (browser session only; a token cannot mint tokens) ----
api.get("/tokens", async (c) => c.json({ tokens: await tokens.listTokens(c.get("db"), sessionOf(c).user) }));
api.post("/tokens", async (c) => {
  const b = await jsonBody(c);
  return c.json(await tokens.createToken(c.get("db"), sessionOf(c).user, b, now(c)), 201);
});
api.delete("/tokens/:id", async (c) => c.json(await tokens.revokeToken(c.get("db"), sessionOf(c).user, idParam(c), now(c))));

api.get("/members", async (c) =>
  c.json({ members: await members.lookupMembers(c.get("db"), c.req.query("q") ?? "", authOf(c).user.id) }),
);

// ---- uploads ----
api.post("/uploads", async (c) => {
  const b = await jsonBody(c);
  return c.json(await createUpload(storageCtx(c), authOf(c).user, b), 201);
});
api.post("/uploads/:id/finalize", async (c) => {
  const r = await finalizeUpload(storageCtx(c), authOf(c).user, idParam(c));
  if (r.status === "in_progress") return c.json({ state: "finalizing" }, 202);
  return c.json({ state: "completed", file: r.file });
});
api.post("/uploads/:id/abort", async (c) => c.json(await abortUpload(storageCtx(c), authOf(c).user, idParam(c))));
// Multipart (large files): part URLs in batches, uploaded parts for resuming, and unfinished uploads.
api.get("/uploads/resumable", async (c) => c.json(await resumableUploads(storageCtx(c), authOf(c).user)));
api.post("/uploads/:id/parts", async (c) => c.json(await presignParts(storageCtx(c), authOf(c).user, idParam(c), await jsonBody(c))));
api.get("/uploads/:id/parts", async (c) => c.json(await uploadedParts(storageCtx(c), authOf(c).user, idParam(c))));

// ---- account security & admin console ----
api.route("/account", account);
api.route("/admin", admin);
