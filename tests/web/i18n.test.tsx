import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LanguagePicker } from "@/components/LanguageSwitcher";
import { detectLocale, getLocale, setLocale, t, tMaybe, useLocale } from "@/i18n";
import { th } from "@/i18n/th";
import { ApiError, errorMessage } from "@/lib/api";

const clearCookie = () => (document.cookie = "fn_lang=; Path=/; Max-Age=0");
afterEach(() => {
  act(() => setLocale("en"));
  clearCookie();
});

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("Thai dictionary", () => {
  it("has a non-empty translation for every key, with the same placeholders", () => {
    for (const [en, tr] of Object.entries(th)) {
      expect(tr.trim(), en).not.toBe("");
      expect(placeholders(tr), en).toEqual(placeholders(en));
    }
  });

  it("covers every literal t() call in the web code (type-checked; this guards against casts)", () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
      });
    const missing = walk("src/web")
      .flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string))
      .filter((k) => !(k in th));
    expect(missing).toEqual([]);
  });
});

describe("t() and locale switching", () => {
  it("returns English by default and fills placeholders", () => {
    expect(getLocale()).toBe("en");
    expect(t("Moved “{name}”", { name: "a.txt" })).toBe("Moved “a.txt”");
  });

  it("switches to Thai, stores only the fn_lang cookie and updates <html lang>", () => {
    act(() => setLocale("th"));
    expect(t("Moved “{name}”", { name: "a.txt" })).toBe("ย้าย “a.txt” แล้ว");
    expect(document.cookie).toContain("fn_lang=th");
    expect(document.documentElement.lang).toBe("th");
    expect(localStorage.length).toBe(0);
  });

  it("detects the language: cookie first, then the browser", () => {
    clearCookie();
    Object.defineProperty(navigator, "languages", { configurable: true, get: () => ["th-TH", "en"] });
    expect(detectLocale()).toBe("th");
    document.cookie = "fn_lang=en; Path=/";
    expect(detectLocale()).toBe("en");
    document.cookie = "fn_lang=xx; Path=/";
    expect(detectLocale()).toBe("th"); // invalid cookie value is ignored
    delete (navigator as unknown as Record<string, unknown>).languages;
  });

  it("translates known server error messages and keeps unknown ones", () => {
    act(() => setLocale("th"));
    expect(errorMessage(new ApiError(401, "invalid_credentials", "Incorrect email or password"))).toBe("อีเมลหรือรหัสผ่านไม่ถูกต้อง");
    expect(errorMessage(new ApiError(400, "x", "Something brand new"))).toBe("Something brand new");
    expect(tMaybe("not a key", "fallback")).toBe("fallback");
    for (const k of ["toString", "__proto__", "constructor"]) expect(tMaybe(k, "x")).toBe("x"); // no prototype lookups
  });

  it("re-renders subscribed components when the language changes", async () => {
    function Label() {
      useLocale();
      return <p>{t("Trash")}</p>;
    }
    render(
      <>
        <Label />
        <LanguagePicker />
      </>,
    );
    expect(screen.getByText("Trash")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "ไทย" }));
    expect(screen.getByText("ถังขยะ")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "ไทย" })).toHaveAttribute("aria-checked", "true");
  });
});
