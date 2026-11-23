/**
 * Structured logging with redaction. Never log raw request URLs for /s/*,
 * cookies, Authorization headers, presigned URLs or secrets.
 */
const PATTERNS: [RegExp, string][] = [
  [/X-Amz-[A-Za-z-]+=[^&\s"']+/g, "X-Amz-[redacted]"],
  [/(x-amz-[a-z-]+:\s*)[^\s"']+/gi, "$1[redacted]"],
  [/Credential=[^,\s"']+/g, "Credential=[redacted]"],
  [/Signature=[0-9a-f]+/gi, "Signature=[redacted]"],
  [/[0-9a-f]{32}\.(?:[a-z]+\.)?r2\.cloudflarestorage\.com/gi, "[r2-host]"],
  [/\/s\/[A-Za-z0-9_-]{16,}/g, "/s/[token]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]"],
  [/((?:__Host-)?fn_[a-z]+=)[^;\s"']+/g, "$1[redacted]"],
  [/(code|state|code_verifier|id_token|access_token|refresh_token|client_secret)=[^&\s"']+/g, "$1=[redacted]"],
];

export function redact(input: string): string {
  let out = input;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

type Fields = Record<string, string | number | boolean | null | undefined>;

function emit(level: "info" | "warn" | "error", event: string, fields: Fields = {}) {
  const safe: Record<string, unknown> = { level, event };
  for (const [k, v] of Object.entries(fields)) safe[k] = typeof v === "string" ? redact(v) : v;
  console[level === "info" ? "log" : level](JSON.stringify(safe));
}

export const log = {
  info: (event: string, fields?: Fields) => emit("info", event, fields),
  warn: (event: string, fields?: Fields) => emit("warn", event, fields),
  error: (event: string, fields?: Fields) => emit("error", event, fields),
};

/** Safe path for logs: share tokens removed. */
export function safePath(url: string): string {
  try {
    return redact(new URL(url).pathname);
  } catch {
    return "[invalid-url]";
  }
}
