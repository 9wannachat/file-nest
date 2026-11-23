export type RangeResult =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number } // inclusive
  | { kind: "unsatisfiable" };

/**
 * Parse a single-range `Range` header against a known size (RFC 9110 §14).
 * - Missing, malformed, non-"bytes" or multi-range headers => full response (ignored).
 * - Syntactically valid but unsatisfiable => 416.
 */
export function parseRange(header: string | null | undefined, size: number): RangeResult {
  if (!header) return { kind: "full" };
  const m = /^\s*bytes\s*=\s*(.*)$/i.exec(header);
  if (!m) return { kind: "full" };
  const spec = m[1]!.trim();
  if (spec.includes(",")) return { kind: "full" }; // multi-range not supported => ignore
  const r = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!r) return { kind: "full" };
  const [, a, b] = r;
  if (a === "" && b === "") return { kind: "full" };
  if (a === "") {
    // suffix range: last N bytes
    const n = Number(b);
    if (!Number.isSafeInteger(n)) return { kind: "full" };
    if (n === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (!Number.isSafeInteger(start)) return { kind: "full" };
  if (b !== "" && (!Number.isSafeInteger(Number(b)) || Number(b) < start)) return { kind: "full" }; // invalid => ignore
  if (start >= size) return { kind: "unsatisfiable" };
  let end = b === "" ? size - 1 : Number(b);
  end = Math.min(end, size - 1);
  return { kind: "partial", start, end };
}
