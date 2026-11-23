import { badRequest } from "./errors.ts";

/** Validate and normalise a file/folder name. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") throw badRequest("invalid_name", "Name is required");
  const name = raw.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || name === "." || name === "..") throw badRequest("invalid_name", "Name is required");
  if (name.length > 255) throw badRequest("invalid_name", "Name is too long");
  if (/[\\/]/.test(name)) throw badRequest("invalid_name", "Name cannot contain / or \\");
  return name;
}

/** "report.pdf" -> "report (2).pdf" */
export function withSuffix(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
  return `${name} (${n})`;
}

/** Escape LIKE wildcards; use with `ESCAPE '\\'`. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}
