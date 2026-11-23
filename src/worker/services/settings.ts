/**
 * Runtime system settings (Admin Console). Stored as JSON in `system_settings`,
 * with defaults from Worker vars. Deploy-time vars stay the hard ceiling
 * (e.g. max upload size can be lowered here, never raised above the var).
 */
import { systemSettings } from "../db/schema.ts";
import type { AppConfig, Db, Env } from "../env.ts";
import { badRequest } from "../lib/errors.ts";
import { auditInsert } from "./audit.ts";

export interface SystemSettings {
  registrationMode: "invite" | "closed";
  googleEnabled: boolean;
  passwordEnabled: boolean;
  mfaPolicy: "optional" | "admins" | "all";
  defaultQuotaBytes: number;
  maxUploadBytes: number;
  sessionTtlDays: number;
  trashRetentionDays: number;
  publicLinksEnabled: boolean;
  publicLinksRequirePassword: boolean;
}

export function defaultSettings(config: AppConfig): SystemSettings {
  return {
    registrationMode: "invite",
    googleEnabled: true,
    passwordEnabled: true,
    mfaPolicy: "admins",
    defaultQuotaBytes: config.defaultQuotaBytes,
    maxUploadBytes: config.maxUploadBytes,
    sessionTtlDays: 7,
    trashRetentionDays: config.trashRetentionDays,
    publicLinksEnabled: true,
    publicLinksRequirePassword: false,
  };
}

/** Validators: each returns the parsed value or throws. */
const V: { [K in keyof SystemSettings]: (v: unknown, config: AppConfig) => SystemSettings[K] } = {
  registrationMode: (v) => {
    if (v !== "invite" && v !== "closed") throw badRequest("invalid_setting", "registrationMode must be invite or closed");
    return v;
  },
  googleEnabled: (v) => bool(v, "googleEnabled"),
  passwordEnabled: (v) => bool(v, "passwordEnabled"),
  mfaPolicy: (v) => {
    if (v !== "optional" && v !== "admins" && v !== "all") throw badRequest("invalid_setting", "mfaPolicy must be optional, admins or all");
    return v;
  },
  defaultQuotaBytes: (v) => int(v, "defaultQuotaBytes", 0, Number.MAX_SAFE_INTEGER),
  maxUploadBytes: (v, config) => int(v, "maxUploadBytes", 1, config.maxUploadBytes),
  sessionTtlDays: (v) => int(v, "sessionTtlDays", 1, 30),
  trashRetentionDays: (v) => int(v, "trashRetentionDays", 1, 3650),
  publicLinksEnabled: (v) => bool(v, "publicLinksEnabled"),
  publicLinksRequirePassword: (v) => bool(v, "publicLinksRequirePassword"),
};

function bool(v: unknown, k: string): boolean {
  if (typeof v !== "boolean") throw badRequest("invalid_setting", `${k} must be true or false`);
  return v;
}
function int(v: unknown, k: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    throw badRequest("invalid_setting", `${k} must be an integer between ${min} and ${max}`);
  }
  return v;
}

export async function getSettings(db: Db, config: AppConfig): Promise<SystemSettings> {
  const s = defaultSettings(config);
  const rows = await db.select().from(systemSettings);
  for (const r of rows) {
    if (!(r.key in V)) continue;
    try {
      const k = r.key as keyof SystemSettings;
      (s as unknown as Record<string, unknown>)[k] = V[k](JSON.parse(r.value), config);
    } catch {
      /* ignore invalid stored value (e.g. above a lowered deploy cap); keep default */
    }
  }
  return s;
}

export async function updateSettings(db: Db, config: AppConfig, actorId: string, patch: Record<string, unknown>, now: number, googleConfigured = true) {
  const keys = Object.keys(patch);
  if (!keys.length) throw badRequest("invalid_setting", "Nothing to update");
  const parsed: Partial<SystemSettings> = {};
  for (const k of keys) {
    if (!(k in V)) throw badRequest("invalid_setting", `Unknown setting ${k}`);
    (parsed as Record<string, unknown>)[k] = V[k as keyof SystemSettings](patch[k], config);
  }
  const current = await getSettings(db, config);
  const next = { ...current, ...parsed };
  if (!(next.googleEnabled && googleConfigured) && !next.passwordEnabled) {
    throw badRequest("invalid_setting", "At least one working sign-in method must stay enabled (Google needs its client ID and secret configured)");
  }
  await db.batch([
    ...Object.entries(parsed).map(([key, value]) =>
      db
        .insert(systemSettings)
        .values({ key, value: JSON.stringify(value), updatedAt: now, updatedBy: actorId })
        .onConflictDoUpdate({ target: systemSettings.key, set: { value: JSON.stringify(value), updatedAt: now, updatedBy: actorId } }),
    ),
    auditInsert(db, now, actorId, "settings.update", "system", "settings", Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v as string | number | boolean]))),
  ] as unknown as [ReturnType<typeof auditInsert>]);
  return next;
}

/** Does the policy require this member to have 2FA? */
export function mfaRequired(s: SystemSettings, role: "admin" | "member") {
  return s.mfaPolicy === "all" || (s.mfaPolicy === "admins" && role === "admin");
}

export type { Env };
