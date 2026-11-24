import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FileItem, UploadTicket } from "@shared/types";
import { api, ApiError, errorMessage } from "@/lib/api";
import { t } from "@/i18n";

export type UploadState = "queued" | "uploading" | "finalizing" | "done" | "error" | "canceled";

export interface UploadItem {
  key: string;
  file: File;
  folderId: string | null;
  progress: number; // 0..1
  state: UploadState;
  error?: string;
  uploadId?: string;
  result?: FileItem;
}

interface Ctx {
  items: UploadItem[];
  active: number;
  enqueue: (files: FileList | File[], folderId: string | null) => void;
  retry: (key: string) => void;
  cancel: (key: string) => void;
  clearFinished: () => void;
}

const UploadContext = createContext<Ctx | null>(null);
export const UPLOADED_EVENT = "filenest:uploaded";
const CONCURRENCY = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function putWithProgress(url: string, headers: Record<string, string>, file: File, onProgress: (p: number) => void, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(t("Upload failed (HTTP {status})", { status: xhr.status }))));
    xhr.onerror = () =>
      reject(new Error(navigator.onLine ? t("Upload failed. Check storage CORS settings or your connection.") : t("Connection lost during upload.")));
    xhr.onabort = () => reject(new DOMException(t("Aborted"), "AbortError"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export function UploadProvider({
  children,
  maxBytes,
  remainingBytes = null,
}: {
  children: ReactNode;
  maxBytes: number;
  /** Space left in the member's quota (null = unlimited). The server re-checks. */
  remainingBytes?: number | null;
}) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const running = useRef(new Set<string>());

  const patch = useCallback((key: string, p: Partial<UploadItem>) => {
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i)));
  }, []);

  const run = useCallback(
    async (item: UploadItem) => {
      const ctrl = new AbortController();
      controllers.current.set(item.key, ctrl);
      running.current.add(item.key);
      let uploadId: string | undefined;
      try {
        if (item.file.size > maxBytes) throw new ApiError(413, "file_too_large", t("File is larger than the upload limit"));
        patch(item.key, { state: "uploading", progress: 0, error: undefined });
        const ticket = await api<UploadTicket>("/api/uploads", {
          method: "POST",
          body: { name: item.file.name, size: item.file.size, mime: item.file.type || null, folderId: item.folderId },
          signal: ctrl.signal,
        });
        uploadId = ticket.uploadId;
        patch(item.key, { uploadId });
        await putWithProgress(ticket.putUrl, ticket.putHeaders, item.file, (p) => patch(item.key, { progress: p }), ctrl.signal);
        patch(item.key, { state: "finalizing", progress: 1 });

        // Finalize is idempotent; 202 means another request is finishing it.
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            const res = await fetchFinalize(ticket.uploadId, ctrl.signal);
            if (res) {
              patch(item.key, { state: "done", result: res });
              window.dispatchEvent(new CustomEvent(UPLOADED_EVENT, { detail: { folderId: item.folderId } }));
              return;
            }
          } catch (e) {
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
        if ((e as Error).name === "AbortError") {
          patch(item.key, { state: "canceled" });
          if (uploadId) void api(`/api/uploads/${uploadId}/abort`, { method: "POST" }).catch(() => {});
        } else {
          patch(item.key, { state: "error", error: errorMessage(e) });
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
      setItems((cur) => {
        // Bytes already promised to uploads that have not finished yet.
        let pending = cur.filter((i) => ["queued", "uploading", "finalizing"].includes(i.state)).reduce((n, i) => n + i.file.size, 0);
        const list = Array.from(files).map<UploadItem>((file) => {
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

  const retry = useCallback((key: string) => patch(key, { state: "queued", progress: 0, error: undefined, uploadId: undefined }), [patch]);
  const cancel = useCallback(
    (key: string) => {
      const c = controllers.current.get(key);
      if (c) c.abort();
      else patch(key, { state: "canceled" });
    },
    [patch],
  );
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

  const value = useMemo(() => ({ items, active, enqueue, retry, cancel, clearFinished }), [items, active, enqueue, retry, cancel, clearFinished]);
  return <UploadContext.Provider value={value}>{children}</UploadContext.Provider>;
}

async function fetchFinalize(uploadId: string, signal: AbortSignal): Promise<FileItem | null> {
  const r = await api<{ state: string; file?: FileItem }>(`/api/uploads/${uploadId}/finalize`, { method: "POST", signal });
  return r.state === "completed" && r.file ? r.file : null;
}

export function useUploads() {
  const c = useContext(UploadContext);
  if (!c) throw new Error("useUploads outside UploadProvider");
  return c;
}
