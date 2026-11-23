/**
 * All local file access is confined to one working folder (FILENEST_WORKDIR).
 * This protects the rest of the machine (e.g. ~/.ssh) if an AI assistant is
 * tricked by prompt injection into asking for other paths.
 */
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class SandboxError extends Error {}

export class Workdir {
  private constructor(readonly root: string) {}

  static async open(path: string): Promise<Workdir> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    return new Workdir(await realpath(path));
  }

  private inside(p: string) {
    const rel = relative(this.root, p);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
  }

  private lexical(input: string): string {
    if (typeof input !== "string" || !input.trim()) throw new SandboxError("Path is required");
    if (input.includes("\0")) throw new SandboxError("Invalid path");
    const target = resolve(this.root, input);
    if (!this.inside(target)) throw new SandboxError(`Path must stay inside the working folder (${this.root})`);
    return target;
  }

  /** Existing regular file to read (symlinks are resolved and must stay inside). */
  async readable(input: string): Promise<string> {
    const target = this.lexical(input);
    let real: string;
    try {
      real = await realpath(target);
    } catch {
      throw new SandboxError(`File not found in working folder: ${relative(this.root, target)}`);
    }
    if (!this.inside(real)) throw new SandboxError("Path resolves outside the working folder");
    if (!(await stat(real)).isFile()) throw new SandboxError("Not a regular file");
    return real;
  }

  /** Destination to write. Parent dirs are created inside the workdir; existing files need overwrite. */
  async writable(input: string, overwrite = false): Promise<string> {
    const target = this.lexical(input);
    if (target === this.root) throw new SandboxError("Path must name a file");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const parentReal = await realpath(dirname(target));
    if (!this.inside(parentReal)) throw new SandboxError("Path resolves outside the working folder");
    const final = join(parentReal, basename(target));
    try {
      const st = await lstat(final);
      if (st.isSymbolicLink()) throw new SandboxError("Refusing to write through a symlink");
      if (!st.isFile()) throw new SandboxError("Destination exists and is not a file");
      if (!overwrite) throw new SandboxError(`File already exists: ${relative(this.root, final)} (pass overwrite: true to replace it)`);
    } catch (e) {
      if (e instanceof SandboxError) throw e;
      // ENOENT: fine
    }
    return final;
  }

  rel(p: string) {
    return relative(this.root, p) || ".";
  }
}

/** Make a file name from the server safe as a single local path segment. */
export function safeFileName(name: string): string {
  let cleaned = name
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_") // separators + Windows-reserved characters (incl. ADS ':')
    .replace(/^\.+/, "_")
    .trim()
    .replace(/[. ]+$/, ""); // Windows strips trailing dots/spaces
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned.slice(0, 200) || "download";
}
