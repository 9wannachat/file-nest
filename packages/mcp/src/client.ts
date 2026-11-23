/** Minimal FileNest API client using a personal access token. */
import { constants, openAsBlob } from "node:fs";
import { open, rename } from "node:fs/promises";
import { Readable } from "node:stream";

export interface FileItem {
  id: string;
  kind: "file";
  name: string;
  size: number;
  contentType: string;
  inline: boolean;
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
  isOwner: boolean;
  owner: { id: string; email: string; name: string | null };
}
export interface FolderItem {
  id: string;
  kind: "folder";
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function assertId(id: string, what = "id") {
  if (!UUID.test(id)) throw new ApiError(400, "invalid_id", `Invalid ${what}: expected a FileNest UUID`);
}

export class FileNestClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async req(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    headers.set("Accept", "application/json");
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.baseUrl), { ...init, headers, redirect: "error" });
    } catch (e) {
      throw new ApiError(0, "network", `Cannot reach FileNest: ${(e as Error).message}`);
    }
    if (!res.ok && res.status !== 206) {
      let code = "http_error";
      let message = `FileNest returned HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: { code?: string; message?: string } };
        code = j.error?.code ?? code;
        message = j.error?.message ?? message;
      } catch {
        /* not json */
      }
      throw new ApiError(res.status, code, message);
    }
    return res;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await (await this.req(path, init)).json()) as T;
  }

  private post<T>(path: string, body?: unknown) {
    return this.json<T>(path, {
      method: "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  me() {
    return this.json<{ user: { id: string; email: string; name: string | null }; limits: { maxUploadBytes: number } }>("/api/me");
  }

  listFolder(folderId: string | null) {
    if (folderId) assertId(folderId, "folderId");
    return this.json<{ folder: FolderItem | null; breadcrumb: { id: string; name: string }[]; folders: FolderItem[]; files: FileItem[] }>(
      `/api/folders/${folderId ?? "root"}`,
    );
  }

  search(q: string) {
    return this.json<{ folders: FolderItem[]; files: FileItem[] }>(`/api/search?q=${encodeURIComponent(q)}`);
  }

  shared() {
    return this.json<{ files: FileItem[] }>("/api/shared");
  }

  fileInfo(id: string) {
    assertId(id, "fileId");
    return this.json<FileItem>(`/api/files/${id}`);
  }

  createFolder(name: string, parentId: string | null) {
    if (parentId) assertId(parentId, "parentId");
    return this.post<FolderItem>("/api/folders", { name, parentId });
  }

  /** Read up to maxBytes from the start of a file (for inline text/images). */
  async readBytes(id: string, maxBytes: number): Promise<Uint8Array> {
    assertId(id, "fileId");
    const res = await this.req(`/api/files/${id}/download`, { headers: { Range: `bytes=0-${maxBytes - 1}` } });
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.subarray(0, maxBytes);
  }

  /**
   * Stream a file to `dest` via `<dest>.<fileId>.part`, resuming an earlier partial
   * download of the SAME file id (FileNest files are immutable per id).
   * The part file is opened with O_NOFOLLOW so a planted symlink cannot redirect writes.
   */
  async download(id: string, dest: string, expected: { size: number }): Promise<{ bytes: number; resumed: boolean }> {
    assertId(id, "fileId");
    const part = `${dest}.${id}.part`;
    const nofollow = constants.O_NOFOLLOW ?? 0;
    let handle;
    try {
      handle = await open(part, constants.O_WRONLY | constants.O_CREAT | nofollow, 0o600);
    } catch (e) {
      throw new ApiError(400, "unsafe_partial_file", `Cannot use partial file safely (${(e as NodeJS.ErrnoException).code ?? "error"})`);
    }
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.nlink > 1) throw new ApiError(400, "unsafe_partial_file", "Partial file is not a plain file");
      let have = st.size > expected.size ? 0 : st.size;
      const headers: Record<string, string> = {};
      if (have > 0 && have < expected.size) headers["Range"] = `bytes=${have}-`;
      const res = await this.req(`/api/files/${id}/download`, { headers });
      const resumed = res.status === 206 && have > 0;
      if (!resumed) have = 0;
      await handle.truncate(have);
      if (!res.body) throw new ApiError(502, "empty_body", "Empty response");
      let pos = have;
      for await (const chunk of Readable.fromWeb(res.body as import("node:stream/web").ReadableStream) as AsyncIterable<Uint8Array>) {
        await handle.write(chunk, 0, chunk.length, pos);
        pos += chunk.length;
      }
      const size = (await handle.stat()).size;
      if (size !== expected.size) throw new ApiError(502, "incomplete_download", `Downloaded ${size} of ${expected.size} bytes; call again to resume`);
      await handle.close();
      handle = undefined;
      await rename(part, dest); // rename never follows a symlink at dest
      return { bytes: size, resumed };
    } finally {
      await handle?.close();
    }
  }

  /** create session → PUT to presigned URL (exact length) → finalize (retrying while in progress). */
  async upload(localPath: string, name: string, size: number, mime: string, folderId: string | null): Promise<FileItem> {
    if (folderId) assertId(folderId, "folderId");
    const ticket = await this.post<{ uploadId: string; putUrl: string; putHeaders: Record<string, string> }>("/api/uploads", {
      name,
      size,
      mime,
      folderId,
    });
    // A Blob body has a known length, so fetch sends the exact signed Content-Length.
    const blob = await openAsBlob(localPath, { type: ticket.putHeaders["Content-Type"] ?? mime });
    if (blob.size !== size) throw new ApiError(409, "file_changed", "The local file changed while uploading");
    let put: Response;
    try {
      put = await this.fetchImpl(ticket.putUrl, { method: "PUT", headers: ticket.putHeaders, body: blob });
    } catch (e) {
      throw new ApiError(0, "network", `Upload to storage failed: ${(e as Error).message}`);
    }
    if (!put.ok) throw new ApiError(put.status, "storage_put_failed", `Storage rejected the upload (HTTP ${put.status})`);
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const r = await this.post<{ state: string; file?: FileItem }>(`/api/uploads/${ticket.uploadId}/finalize`);
        if (r.state === "completed" && r.file) return r.file;
      } catch (e) {
        if (!(e instanceof ApiError) || !["upload_incomplete", "staging_changed", "storage_unavailable"].includes(e.code) || attempt >= 5) throw e;
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    throw new ApiError(504, "finalize_timeout", "Finalizing took too long");
  }
}
