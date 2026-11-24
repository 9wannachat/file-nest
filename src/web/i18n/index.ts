import { useSyncExternalStore } from "react";
import { th } from "./th";

/**
 * UI language (English / Thai). English text is the message key, so code stays
 * readable and `th.ts` must contain every key passed to `t()` — the compiler
 * enforces that through `MessageKey`.
 *
 * The choice is a UI preference only, kept in the non-HttpOnly `fn_lang` cookie
 * (not Web Storage) so the server-rendered share page can match it.
 */
export type Locale = "en" | "th";
export type MessageKey = keyof typeof th;
export const LOCALES: { value: Locale; label: string }[] = [
  { value: "en", label: "English" },
  { value: "th", label: "ไทย" },
];
export const LOCALE_COOKIE = "fn_lang";
const YEAR_S = 365 * 24 * 3600;

export function parseLocale(v: unknown): Locale | null {
  return v === "en" || v === "th" ? v : null;
}

function readCookie(): Locale | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)fn_lang=([^;]*)/);
  return m ? parseLocale(m[1]) : null;
}

export function detectLocale(): Locale {
  const saved = readCookie();
  if (saved) return saved;
  const langs = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some((l) => l?.toLowerCase().startsWith("th")) ? "th" : "en";
}

let current: Locale = detectLocale();
const listeners = new Set<() => void>();
if (typeof document !== "undefined") document.documentElement.lang = current;

export const getLocale = () => current;

export function setLocale(l: Locale) {
  if (l === current) return;
  current = l;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${LOCALE_COOKIE}=${l}; Path=/; Max-Age=${YEAR_S}; SameSite=Lax${secure}`;
  document.documentElement.lang = l;
  for (const f of listeners) f();
}

function subscribe(f: () => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Translate. `{name}` placeholders are filled from `vars`. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const s: string = (current === "th" && Object.hasOwn(th, key) ? th[key] : undefined) ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : m)) : s;
}

/** Translate a key that is only known at runtime (e.g. an API error code mapping); falls back to `fallback`. */
export function tMaybe(key: string, fallback: string): string {
  return Object.hasOwn(th, key) ? t(key as MessageKey) : fallback;
}

/** Re-render on language change. Components that render `t()` text should call this (App does, which re-renders the tree). */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}

/** BCP 47 tag for Intl formatting. Thai uses the Buddhist calendar (พ.ศ.). */
export const intlLocale = () => (current === "th" ? "th-TH" : "en");
