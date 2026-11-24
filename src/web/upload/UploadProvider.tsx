import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FileItem, PartUrls, ResumableUpload, UploadedParts, UploadTicket } from "@shared/types";
import { api, ApiError, errorMessage } from "@/lib/api";
import { t } from "@/i18n";

export type UploadState = "queued" | "uploading" | "paused" | "finalizing" | "done" | "error" | "canceled";

export interface UploadItem {
  key: string;
  file: File;
  folderId: string | null;
  progress: number; // 0..1
  state: UploadState;
  error?: string;
  uploadId?: string;
  /** Set once the server chose multipart: the upload can be paused and resumed. */
  multipart?: { partSize: number; partCount: number };
  result?: FileItem;
}

interface Ctx {
  items: UploadItem[];
  active: number;
  /** Large uploads left unfinished in an earlier visit (resume by choosing the same file again). */
  unfinished: ResumableUpload[];
  enqueue: (files: FileList | File[], folderId: string | null) => void;
  retry: (key: string) => void;
  cancel: (key: string) => void;
  pause: (key: string) => void;
  resume: (key: string) => void;
  resumeWithFile: (u: ResumableUpload, file: File) => string | null;
  discardUnfinished: (uploadId: string) => void;
  clearFinished: () => void;
}

const UploadContext = createContext<Ctx | null>(null);
export const UPLOADED_EVENT = "filenest:uploaded";
const CONCURRENCY = 3;
/** Parallel part uploads per large file. */
const PART_CONCURRENCY = 4;
const URL_BATCH = 20;
const PART_ATTEMPTS = 6;
const MiB = 1024 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAUSE = "pause";

/**
 * Identifies a local file for resuming: SHA-256 of (first MiB ‖ last MiB ‖ size).
 * packages/mcp computes the same value.
 */
export async function fileFingerprint(file: Blob): Promise<string> {
  const size = file.size;
  const pieces: BlobPart[] = [file.slice(0, Math.min(MiB, size))];
  if (size > MiB) pieces.push(file.slice(Math.max(MiB, size - MiB), size));
  pieces.push(String(size));
  const buf = await new Blob(pieces).arrayBuffer();
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

class HttpPutError extends Error {
  constructor(readonly status: number) {
    super(t("Upload failed (HTTP {status})", { status }));
  }
}

function putWithProgress(url: string, headers: Record<string, string>, body: Blob, onProgress: (loaded: number) => void, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException(t("Aborted"), "AbortError"));
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new HttpPutError(xhr.status)));
    xhr.onerror = () =>
      reject(new Error(navigator.onLine ? t("Upload failed. Check storage CORS settings or your connection.") : t("Connection lost during upload.")));
    xhr.onabort = () => reject(new DOMException(t("Aborted"), "AbortError"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

const waitOnline = (signal: AbortSignal) =>
  navigator.onLine
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const done = () => {
          window.removeEventListener("online", done);
          resolve();
        };
        window.addEventListener("online", done);
        signal.addEventListener("abort", done, { once: true });
      });

/** Upload every missing part (PART_CONCURRENCY at a time), retrying each part on its own. */
async function uploadParts(
  item: UploadItem,
  uploadId: string,
  plan: { partSize: number; partCount: number },
  fingerprint: string,
  already: Set<number>,
  onProgress: (bytes: number) => void,
  signal: AbortSignal,
) {
  const size = item.file.size;
  const lengthOf = (n: number) => (n < plan.partCount ? plan.partSize : size - plan.partSize * (plan.partCount - 1));
  let doneBytes = [...already].reduce((s, n) => s + lengthOf(n), 0);
  const inflight = new Map<number, number>();
  const report = () => onProgress(doneBytes + [...inflight.values()].reduce((a, b) => a + b, 0));
  report();

  const todo: number[] = [];
  for (let n = 1; n <= plan.partCount; n++) if (!already.has(n)) todo.push(n);
  const urls = new Map<number, { url: string; until: number }>();

  async function urlFor(n: number): Promise<string> {
    const cached = urls.get(n);
    if (cached && cached.until - Date.now() > 60_000) return cached.url;
    // Fetch this part and the next few that still need one.
    const want = [n, ...todo.filter((m) => m !== n && !urls.has(m))].slice(0, URL_BATCH);
    const r = await api<PartUrls>(`/api/uploads/${uploadId}/parts`, { method: "POST", body: { parts: want, fingerprint }, signal });
    for (const u of r.urls) urls.set(u.part, { url: u.url, until: r.urlExpiresAt });
    return urls.get(n)!.url;
  }

  async function one(n: number) {
    const start = (n - 1) * plan.partSize;
    const blob = item.file.slice(start, start + lengthOf(n));
    for (let attempt = 1; ; attempt++) {
      await waitOnline(signal);
      try {
        const url = await urlFor(n);
        await putWithProgress(url, {}, blob, (loaded) => {
          inflight.set(n, loaded);
          report();
        }, signal);
        inflight.delete(n);
        doneBytes += blob.size;
        report();
        return;
      } catch (e) {
        inflight.delete(n);
        if (signal.aborted || (e as Error).name === "AbortError") throw e;
        if (e instanceof ApiError && e.status !== 0 && e.status < 500 && e.status !== 429) throw e; // session gone, mismatch…
        if (e instanceof HttpPutError && e.status === 403) urls.delete(n); // expired URL: sign again
        if (attempt >= PART_ATTEMPTS) throw e;
        await sleep(Math.min(15_000, 1000 * 2 ** (attempt - 1)));
      }
    }
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PART_CONCURRENCY, todo.length) }, async () => {
      while (next < todo.length) await one(todo[next++]!);
    }),
  );
}

async function fetchFinalize(uploadId: string, signal: AbortSignal): Promise<FileItem | null> {
  const r = await api<{ state: string; file?: FileItem }>(`/api/uploads/${uploadId}/finalize`, { method: "POST", signal });
  return r.state === "completed" && r.file ? r.file : null;
}

export function UploadProvider({
  children,
  maxBytes,
  remainingBytes = null,
  resumable = false,
}: {
  children: ReactNode;
  maxBytes: number;
  /** Space left in the member's quota (null = unlimited). The server re-checks. */
  remainingBytes?: number | null;
  /** Look up unfinished large uploads from earlier visits. */
  resumable?: boolean;
}) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [unfinished, setUnfinished] = useState<ResumableUpload[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const running = useRef(new Set<string>());

  const patch = useCallback((key: string, p: Partial<UploadItem>) => {
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i)));
  }, []);

  useEffect(() => {
    if (!resumable) return;
    const ctrl = new AbortController();
    api<{ uploads: ResumableUpload[] }>("/api/uploads/resumable", { signal: ctrl.signal })
      .then((r) => setUnfinished(r.uploads))
      .catch(() => {});
    return () => ctrl.abort();
  }, [resumable]);

  const run = useCallback(
    async (item: UploadItem) => {
      const ctrl = new AbortController();
      controllers.current.set(item.key, ctrl);
      running.current.add(item.key);
      let uploadId = item.uploadId;
      let multipart = item.multipart;
      try {
        if (item.file.size > maxBytes) throw new ApiError(413, "file_too_large", t("File is larger than the upload limit"));
        patch(item.key, { state: "uploading", error: undefined });
        const fingerprint = await fileFingerprint(item.file);
        let already = new Set<number>();

        if (uploadId && multipart) {
          // Resume: ask R2 (through the Worker) which parts are already there.
          try {
            const r = await api<UploadedParts>(`/api/uploads/${uploadId}/parts`, { signal: ctrl.signal });
            already = new Set(r.parts.map((p) => p.part));
          } catch (e) {
            if (!(e instanceof ApiError) || ![404, 410].includes(e.status)) throw e;
            uploadId = undefined; // session gone: start over
            multipart = undefined;
          }
        }
        if (uploadId && !multipart) uploadId = undefined; // single PUTs cannot resume: start over
        if (!uploadId) {
          patch(item.key, { progress: 0 });
          const ticket = await api<UploadTicket>("/api/uploads", {
            method: "POST",
            body: { name: item.file.name, size: item.file.size, mime: item.file.type || null, folderId: item.folderId, multipart: true, fingerprint },
            signal: ctrl.signal,
          });
          uploadId = ticket.uploadId;
          if (ticket.mode === "multipart") multipart = { partSize: ticket.partSize, partCount: ticket.partCount };
          patch(item.key, { uploadId, multipart });
          if (ticket.mode === "single") {
            await putWithProgress(ticket.putUrl, ticket.putHeaders, item.file, (loaded) => patch(item.key, { progress: loaded / Math.max(1, item.file.size) }), ctrl.signal);
          }
        }
        const size = Math.max(1, item.file.size);
        const sendParts = (have: Set<number>) =>
          uploadParts(item, uploadId!, multipart!, fingerprint, have, (bytes) => patch(item.key, { progress: bytes / size }), ctrl.signal);
        if (multipart) await sendParts(already);
        patch(item.key, { state: "finalizing", progress: 1 });

        // Finalize is idempotent; 202 means another request is finishing it.
        let refilled = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            const res = await fetchFinalize(uploadId, ctrl.signal);
            if (res) {
              patch(item.key, { state: "done", result: res });
              setUnfinished((u) => u.filter((x) => x.uploadId !== uploadId));
              window.dispatchEvent(new CustomEvent(UPLOADED_EVENT, { detail: { folderId: item.folderId } }));
              return;
            }
          } catch (e) {
            if (e instanceof ApiError && e.code === "upload_incomplete" && multipart && !refilled) {
              // A part went missing (e.g. a dropped request): send what R2 lacks, then finalize again.
              refilled = true;
              patch(item.key, { state: "uploading" });
              const r = await api<UploadedParts>(`/api/uploads/${uploadId}/parts`, { signal: ctrl.signal });
              await sendParts(new Set(r.parts.map((p) => p.part)));
              patch(item.key, { state: "finalizing", progress: 1 });
              continue;
            }
            if (e instanceof ApiError && ["upload_incomplete", "staging_changed", "storage_unavailable"].includes(e.code) && attempt < 5) {
              await sleep(800 * (attempt + 1));
              continue;
            }
            throw e;
          }
          await sleep(1000);
        }
        throw new Error(t("Finalizing took too long. Try again."));
      } catch (e) {
        if (ctrl.signal.reason === PAUSE) {
          patch(item.key, { state: "paused", uploadId, multipart });
        } else if ((e as Error).name === "AbortError") {
          patch(item.key, { state: "canceled" });
          if (uploadId) void api(`/api/uploads/${uploadId}/abort`, { method: "POST" }).catch(() => {});
        } else {
          const mismatch = e instanceof ApiError && e.code === "file_mismatch";
          patch(item.key, {
            state: "error",
            error: mismatch ? t("This is not the same file that this upload started with.") : errorMessage(e),
            uploadId: mismatch ? undefined : uploadId,
            multipart: mismatch ? undefined : multipart,
          });
        }
      } finally {
        controllers.current.delete(item.key);
        running.current.delete(item.key);
      }
    },
    [maxBytes, patch],
  );

  // Simple scheduler: keep up to CONCURRENCY uploads running.
  useEffect(() => {
    const slots = CONCURRENCY - running.current.size;
    if (slots <= 0) return;
    const next = items.filter((i) => i.state === "queued" && !running.current.has(i.key)).slice(0, slots);
    for (const i of next) void run(i);
  }, [items, run]);

  const enqueue = useCallback(
    (files: FileList | File[], folderId: string | null) => {
      // Copy now: callers clear the <input>'s live FileList right after this call,
      // and React may run the updater below later.
      const chosen = Array.from(files);
      setItems((cur) => {
        // Bytes already promised to uploads that have not finished yet.
        let pending = cur.filter((i) => ["queued", "uploading", "paused", "finalizing"].includes(i.state)).reduce((n, i) => n + i.file.size, 0);
        const list = chosen.map<UploadItem>((file) => {
          const fits = remainingBytes === null || pending + file.size <= remainingBytes;
          if (fits) pending += file.size;
          return {
            key: crypto.randomUUID(),
            file,
            folderId,
            progress: 0,
            state: fits ? "queued" : "error",
            error: fits ? undefined : t("Not enough storage left for this file"),
          };
        });
        return [...cur, ...list];
      });
    },
    [remainingBytes],
  );

  // A failed large upload keeps its session, so Retry resumes instead of starting over.
  const retry = useCallback(
    (key: string) =>
      setItems((list) =>
        list.map((i) => (i.key === key ? { ...i, state: "queued", error: undefined, ...(i.multipart ? {} : { progress: 0, uploadId: undefined }) } : i)),
      ),
    [],
  );
  const cancel = useCallback(
    (key: string) => {
      const c = controllers.current.get(key);
      if (c) c.abort();
      else
        setItems((list) =>
          list.map((i) => {
            if (i.key !== key) return i;
            if (i.uploadId && i.state === "paused") void api(`/api/uploads/${i.uploadId}/abort`, { method: "POST" }).catch(() => {});
            return { ...i, state: "canceled" };
          }),
        );
    },
    [],
  );
  const pause = useCallback((key: string) => controllers.current.get(key)?.abort(PAUSE), []);
  const resume = useCallback((key: string) => patch(key, { state: "queued", error: undefined }), [patch]);

  const resumeWithFile = useCallback((u: ResumableUpload, file: File): string | null => {
    if (file.name !== u.name || file.size !== u.size) return t("Choose the same file: {name} ({size} bytes).", { name: u.name, size: u.size });
    setUnfinished((list) => list.filter((x) => x.uploadId !== u.uploadId));
    setItems((cur) => [
      ...cur,
      {
        key: crypto.randomUUID(),
        file,
        folderId: u.folderId,
        progress: 0,
        state: "queued",
        uploadId: u.uploadId,
        multipart: { partSize: u.partSize, partCount: u.partCount },
      },
    ]);
    return null;
  }, []);

  const discardUnfinished = useCallback((uploadId: string) => {
    setUnfinished((list) => list.filter((x) => x.uploadId !== uploadId));
    void api(`/api/uploads/${uploadId}/abort`, { method: "POST" }).catch(() => {});
  }, []);

  const clearFinished = useCallback(() => setItems((cur) => cur.filter((i) => !["done", "canceled"].includes(i.state))), []);

  const active = items.filter((i) => ["queued", "uploading", "finalizing"].includes(i.state)).length;

  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  const value = useMemo(
    () => ({ items, active, unfinished, enqueue, retry, cancel, pause, resume, resumeWithFile, discardUnfinished, clearFinished }),
    [items, active, unfinished, enqueue, retry, cancel, pause, resume, resumeWithFile, discardUnfinished, clearFinished],
  );
  return <UploadContext.Provider value={value}>{children}</UploadContext.Provider>;
}

export function useUploads() {
  const c = useContext(UploadContext);
  if (!c) throw new Error("useUploads outside UploadProvider");
  return c;
}
