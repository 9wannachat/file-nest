/**
 * Inline allowlist + content sniffing. Anything not proven to match an
 * allowlisted type is served as application/octet-stream attachment.
 * HTML and SVG are never inline.
 */
export const INLINE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/mp4",
  "application/pdf",
  "text/plain",
] as const;
export type InlineType = (typeof INLINE_TYPES)[number];

const EXT: Record<string, InlineType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/plain",
  log: "text/plain",
  csv: "text/plain",
};

const ALIASES: Record<string, InlineType> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "audio/mp3": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "video/quicktime": "video/mp4",
  "audio/x-m4a": "audio/mp4",
  "text/markdown": "text/plain",
  "text/csv": "text/plain",
};

/** Normalise a client-declared MIME: lowercased, no params, or null if junk. */
export function normalizeMime(m: string | null | undefined): string | null {
  if (!m) return null;
  const base = m.split(";")[0]!.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(base)) return null;
  return base;
}

/** Which inline type should we try to prove? Declared type first, then extension. */
export function inlineCandidate(name: string, declared: string | null): InlineType | null {
  const d = normalizeMime(declared);
  if (d) {
    if ((INLINE_TYPES as readonly string[]).includes(d)) return d as InlineType;
    if (ALIASES[d]) return ALIASES[d];
  }
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (!d || d === "application/octet-stream") return EXT[ext] ?? null;
  return null;
}

function ascii(b: Uint8Array, off: number, s: string): boolean {
  if (b.length < off + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[off + i] !== s.charCodeAt(i)) return false;
  return true;
}

function isoBmffBrand(b: Uint8Array): string | null {
  if (!ascii(b, 4, "ftyp") || b.length < 12) return null;
  return String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!);
}

/** Does the head of the file match the candidate type? */
export function sniffMatches(type: InlineType, b: Uint8Array): boolean {
  switch (type) {
    case "image/png":
      return b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x);
    case "image/jpeg":
      return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/gif":
      return ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a");
    case "image/webp":
      return ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP");
    case "image/avif": {
      const brand = isoBmffBrand(b);
      return brand === "avif" || brand === "avis";
    }
    case "video/mp4":
    case "audio/mp4": {
      const brand = isoBmffBrand(b);
      return brand !== null && !["avif", "avis", "heic", "heix", "mif1", "msf1"].includes(brand);
    }
    case "video/webm":
    case "audio/webm":
      return b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    case "video/ogg":
    case "audio/ogg":
      return ascii(b, 0, "OggS");
    case "audio/wav":
      return ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE");
    case "audio/mpeg":
      return ascii(b, 0, "ID3") || (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0);
    case "application/pdf":
      return ascii(b, 0, "%PDF-");
    case "text/plain": {
      // Must be valid UTF-8 without NUL bytes. Served with nosniff + sandbox CSP.
      if (b.includes(0)) return false;
      try {
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(trimPartialUtf8(b));
        return true;
      } catch {
        return false;
      }
    }
  }
}

/** Drop a trailing incomplete UTF-8 sequence (we only read the first few KB). */
function trimPartialUtf8(b: Uint8Array): Uint8Array {
  let i = b.length - 1;
  let back = 0;
  while (i >= 0 && back < 4 && (b[i]! & 0xc0) === 0x80) {
    i--;
    back++;
  }
  if (i < 0) return b;
  const lead = b[i]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return need > back + 1 ? b.subarray(0, i) : b;
}

export const SNIFF_BYTES = 4096;

export function decideContentType(
  name: string,
  declared: string | null,
  head: Uint8Array | null,
): { contentType: string; inlineOk: boolean } {
  const cand = inlineCandidate(name, declared);
  if (cand && head && sniffMatches(cand, head)) {
    return { contentType: cand === "text/plain" ? "text/plain; charset=utf-8" : cand, inlineOk: true };
  }
  return { contentType: "application/octet-stream", inlineOk: false };
}
