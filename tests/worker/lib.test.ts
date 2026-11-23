import { describe, expect, it } from "vitest";
import { parseRange } from "../../src/worker/lib/range.ts";
import { contentDisposition } from "../../src/worker/lib/headers.ts";
import { decideContentType, sniffMatches } from "../../src/worker/lib/mime.ts";
import { redact } from "../../src/worker/lib/log.ts";
import { cleanName, withSuffix, escapeLike } from "../../src/worker/lib/names.ts";
import { safeReturnTo } from "../../src/worker/routes/auth.ts";
import { decryptString, encryptString } from "../../src/worker/lib/crypto.ts";
import { enc } from "./helpers.ts";

describe("parseRange", () => {
  const size = 1000;
  it.each([
    [null, { kind: "full" }],
    ["bytes=0-99", { kind: "partial", start: 0, end: 99 }],
    ["bytes=900-", { kind: "partial", start: 900, end: 999 }],
    ["bytes=-100", { kind: "partial", start: 900, end: 999 }],
    ["bytes=-5000", { kind: "partial", start: 0, end: 999 }],
    ["bytes=990-5000", { kind: "partial", start: 990, end: 999 }],
    ["bytes=1000-", { kind: "unsatisfiable" }],
    ["bytes=-0", { kind: "unsatisfiable" }],
    ["bytes=0-1,5-6", { kind: "full" }],
    ["items=0-1", { kind: "full" }],
    ["bytes=abc", { kind: "full" }],
    ["bytes=5-1", { kind: "full" }],
  ] as const)("%s", (h, expected) => {
    expect(parseRange(h, size)).toEqual(expected);
  });
  it("empty file is unsatisfiable for any range", () => {
    expect(parseRange("bytes=0-0", 0)).toEqual({ kind: "unsatisfiable" });
  });
});

describe("contentDisposition", () => {
  it("encodes unicode safely and strips header injection", () => {
    const v = contentDisposition("attachment", 'รายงาน "Q1"\r\nSet-Cookie: x=1.pdf');
    expect(v).not.toMatch(/[\r\n]/);
    expect(v).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    expect(v).toContain("%E0%B8%A3"); // ร
    expect(v.split('filename="')[1]!.split('"')[0]).not.toContain('"');
  });
});

describe("content sniffing", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  it("accepts a real PNG", () => {
    expect(decideContentType("a.png", "image/png", png)).toEqual({ contentType: "image/png", inlineOk: true });
  });
  it("rejects HTML pretending to be PNG", () => {
    expect(decideContentType("a.png", "image/png", enc("<html><script>alert(1)</script>"))).toEqual({
      contentType: "application/octet-stream",
      inlineOk: false,
    });
  });
  it("never inlines HTML or SVG", () => {
    expect(decideContentType("x.html", "text/html", enc("<html>")).inlineOk).toBe(false);
    expect(decideContentType("x.svg", "image/svg+xml", enc("<svg onload=alert(1)>")).inlineOk).toBe(false);
  });
  it("text/plain requires UTF-8 without NUL", () => {
    expect(sniffMatches("text/plain", enc("hello ไทย"))).toBe(true);
    expect(sniffMatches("text/plain", new Uint8Array([0x68, 0x00, 0x69]))).toBe(false);
    expect(decideContentType("n.txt", "text/plain", enc("hi")).contentType).toBe("text/plain; charset=utf-8");
  });
  it("PDF and MP4", () => {
    expect(sniffMatches("application/pdf", enc("%PDF-1.7\n"))).toBe(true);
    const mp4 = new Uint8Array([0, 0, 0, 0x18, ...enc("ftypisom"), 0, 0]);
    expect(sniffMatches("video/mp4", mp4)).toBe(true);
  });
});

describe("redaction", () => {
  it("removes signatures, R2 hosts, share tokens, cookies, oauth params", () => {
    const s = redact(
      `https://${"a".repeat(32)}.r2.cloudflarestorage.com/b/k?X-Amz-Signature=abc&X-Amz-Credential=AK /s/${"t".repeat(43)} fn_session=secret code=xyz`,
    );
    expect(s).not.toContain("abc");
    expect(s).not.toContain("r2.cloudflarestorage.com");
    expect(s).not.toContain("t".repeat(43));
    expect(s).not.toContain("secret");
    expect(s).not.toContain("xyz");
  });
});

describe("names", () => {
  it("validates", () => {
    expect(cleanName("  a.txt ")).toBe("a.txt");
    expect(() => cleanName("a/b")).toThrow();
    expect(() => cleanName("..")).toThrow();
    expect(() => cleanName("x".repeat(256))).toThrow();
    expect(withSuffix("r.pdf", 2)).toBe("r (2).pdf");
    expect(withSuffix(".env", 2)).toBe(".env (2)");
    expect(escapeLike("50%_a\\")).toBe("50\\%\\_a\\\\");
  });
});

describe("safeReturnTo", () => {
  it.each([
    ["/folders/x", "/folders/x"],
    ["//evil.com", "/"],
    ["/\\evil.com", "/"],
    ["https://evil.com", "/"],
    ["/api/me", "/"],
    [undefined, "/"],
  ])("%s", (v, e) => expect(safeReturnTo(v)).toBe(e));
});

describe("AES-GCM", () => {
  const key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
  it("round-trips and binds AAD", async () => {
    const c = await encryptString(key, "tok", "row-1");
    expect(await decryptString(key, c, "row-1")).toBe("tok");
    await expect(decryptString(key, c, "row-2")).rejects.toThrow();
  });
});
