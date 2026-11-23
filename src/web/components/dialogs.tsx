import { ChevronRight, Copy, Download, Folder, Globe, Home, Link2Off, Lock, UserPlus, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { FileItem, FolderListing, MemberLite, Sharing } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { cn, formatBytes } from "@/lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "./ui/dialog";
import { Input, Label } from "./ui/input";
import { Badge, ErrorState, Spinner } from "./ui/misc";

export function NameDialog({
  open,
  title,
  initial,
  submitLabel,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(initial);
      setError(null);
    }
  }, [open, initial]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Name is required");
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          const el = (e.currentTarget as HTMLElement).querySelector("input");
          el?.focus();
          const dot = initial.lastIndexOf(".");
          el?.setSelectionRange(0, dot > 0 ? dot : initial.length);
        }}
      >
        <form onSubmit={submit}>
          <DialogHeader title={title} />
          <DialogBody className="space-y-2">
            <Label htmlFor="name-input">Name</Label>
            <Input id="name-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={255} aria-invalid={!!error} aria-describedby={error ? "name-error" : undefined} />
            {error ? (
              <p id="name-error" role="alert" className="text-sm text-red-600">
                {error}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner className="text-white" /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  destructive,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title={title} />
        <DialogBody>
          <p className="text-sm text-slate-600 dark:text-slate-300">{body}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } catch (e) {
                toast.error(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Folder picker for "Move to". */
export function MoveDialog({
  open,
  itemName,
  excludeFolderId,
  onClose,
  onMove,
}: {
  open: boolean;
  itemName: string;
  excludeFolderId?: string;
  onClose: () => void;
  onMove: (folderId: string | null) => Promise<void>;
}) {
  const [at, setAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, loading, error, reload } = useApi<FolderListing>(open ? (at ? `/api/folders/${at}` : "/api/folders/root") : null);
  useEffect(() => {
    if (open) setAt(null);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title={`Move “${itemName}”`} description="Choose a destination folder" />
        <nav aria-label="Destination path" className="flex flex-wrap items-center gap-1 border-b border-slate-200 px-5 py-2 text-sm dark:border-slate-800">
          <button className="inline-flex min-h-9 items-center gap-1 rounded px-1 hover:underline" onClick={() => setAt(null)}>
            <Home className="size-4" /> My Drive
          </button>
          {data?.breadcrumb.map((b) => (
            <span key={b.id} className="inline-flex items-center gap-1">
              <ChevronRight className="size-4 text-slate-400" aria-hidden />
              <button className="min-h-9 rounded px-1 hover:underline" onClick={() => setAt(b.id)}>
                {b.name}
              </button>
            </span>
          ))}
        </nav>
        <DialogBody className="min-h-48 p-2">
          {loading ? <Spinner className="m-4" /> : null}
          {error ? <ErrorState message={error} onRetry={reload} /> : null}
          {data && !data.folders.filter((f) => f.id !== excludeFolderId).length ? (
            <p className="p-4 text-sm text-slate-500">No subfolders here.</p>
          ) : null}
          <ul>
            {data?.folders
              .filter((f) => f.id !== excludeFolderId)
              .map((f) => (
                <li key={f.id}>
                  <button
                    className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                    onClick={() => setAt(f.id)}
                  >
                    <Folder className="size-5 fill-brand-100 text-brand-700" /> <span className="flex-1 truncate">{f.name}</span>
                    <ChevronRight className="size-4 text-slate-400" />
                  </button>
                </li>
              ))}
          </ul>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || loading}
            onClick={async () => {
              setBusy(true);
              try {
                await onMove(at);
                onClose();
              } catch (e) {
                toast.error(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Move here
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ShareDialog({ file, onClose, onChanged }: { file: FileItem | null; onClose: () => void; onChanged: () => void }) {
  const open = !!file;
  const { data, error, loading, reload, setData } = useApi<Sharing>(file ? `/api/files/${file.id}/sharing` : null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<MemberLite[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api<{ members: MemberLite[] }>(`/api/members?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => setResults(r.members))
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, open]);

  const mutate = async (fn: () => Promise<Sharing>) => {
    setBusy(true);
    try {
      setData(await fn());
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const setMembers = (ids: string[]) =>
    mutate(() => api<Sharing>(`/api/files/${file!.id}/sharing/members`, { method: "PUT", body: { userIds: ids } }));
  const memberIds = data?.members.map((m) => m.id) ?? [];
  const candidates = results.filter((r) => !memberIds.includes(r.id));

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy. Select the link and copy it manually.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title={`Share “${file?.name ?? ""}”`} />
        <DialogBody className="space-y-5">
          {loading && !data ? <Spinner /> : null}
          {error ? <ErrorState message={error} onRetry={reload} /> : null}
          {data ? (
            <>
              <section aria-labelledby="general-access" className="space-y-2">
                <h3 id="general-access" className="text-sm font-semibold">
                  General access
                </h3>
                <div
                  className={cn(
                    "flex items-start gap-3 rounded-xl border p-3",
                    data.visibility === "public"
                      ? "border-brand-500 bg-brand-50 dark:bg-brand-800/20"
                      : "border-slate-200 dark:border-slate-800",
                  )}
                >
                  {data.visibility === "public" ? (
                    <Globe className="mt-0.5 size-5 text-brand-700" aria-hidden />
                  ) : (
                    <Lock className="mt-0.5 size-5 text-slate-500" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {data.visibility === "public" ? "Anyone with the link" : "Only people with access"}
                      <Badge tone={data.visibility === "public" ? "brand" : "slate"}>{data.visibility === "public" ? "Public" : "Private"}</Badge>
                    </div>
                    <p className="text-xs text-slate-500">
                      {data.visibility === "public"
                        ? "Anyone with the link can view and download without signing in."
                        : "Only you and the members below can open this file."}
                    </p>
                    {data.publicLink ? (
                      <div className="mt-2 flex gap-2">
                        <Input readOnly value={data.publicLink.url} aria-label="Public link" onFocus={(e) => e.currentTarget.select()} className="text-xs" />
                        <Button size="icon" variant="outline" aria-label="Copy link" onClick={() => void copy(data.publicLink!.url)}>
                          <Copy />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </div>
                {data.visibility === "public" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void mutate(() => api<Sharing>(`/api/files/${file!.id}/sharing/link`, { method: "DELETE" }))}
                  >
                    <Link2Off /> Revoke link
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void mutate(() => api<Sharing>(`/api/files/${file!.id}/sharing/link`, { method: "POST" }))}
                  >
                    <Globe /> Create public link
                  </Button>
                )}
              </section>

              <section aria-labelledby="people" className="space-y-2">
                <h3 id="people" className="text-sm font-semibold">
                  Members with access <span className="font-normal text-slate-500">(view & download)</span>
                </h3>
                <ul className="space-y-1">
                  {data.members.map((m) => (
                    <li key={m.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5">
                      <span className="flex size-8 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold uppercase dark:bg-slate-800">
                        {(m.name ?? m.email).slice(0, 1)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{m.name ?? m.email}</span>
                        <span className="block truncate text-xs text-slate-500">{m.email}</span>
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove ${m.email}`}
                        disabled={busy}
                        onClick={() => void setMembers(memberIds.filter((id) => id !== m.id))}
                      >
                        <X />
                      </Button>
                    </li>
                  ))}
                  {!data.members.length ? <li className="px-2 text-sm text-slate-500">Not shared with any member yet.</li> : null}
                </ul>
                <Label htmlFor="member-search" className="sr-only">
                  Add member
                </Label>
                <Input id="member-search" placeholder="Add members by name or email" value={q} onChange={(e) => setQ(e.target.value)} />
                {candidates.length ? (
                  <ul className="max-h-40 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800" aria-label="Suggestions">
                    {candidates.map((m) => (
                      <li key={m.id}>
                        <button
                          className="flex min-h-11 w-full items-center gap-3 px-3 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                          disabled={busy}
                          onClick={() => void setMembers([...memberIds, m.id])}
                        >
                          <UserPlus className="size-4 text-slate-500" />
                          <span className="truncate">{m.name ? `${m.name} · ${m.email}` : m.email}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Preview streams from /api/files/:id/preview (same origin only). */
export function PreviewDialog({ file, onClose }: { file: FileItem | null; onClose: () => void }) {
  const src = file ? `/api/files/${file.id}/preview` : "";
  const t = file?.contentType ?? "";
  let body = <p className="p-6 text-sm text-slate-500">Preview is not available for this file type. Download it to open.</p>;
  if (file?.inline) {
    if (t.startsWith("image/")) body = <img src={src} alt={file.name} className="mx-auto max-h-[70dvh] max-w-full object-contain" />;
    else if (t.startsWith("video/"))
      body = <video src={src} controls playsInline preload="metadata" className="mx-auto max-h-[70dvh] max-w-full" />;
    else if (t.startsWith("audio/")) body = <audio src={src} controls preload="metadata" className="m-6 w-[calc(100%-3rem)]" />;
    else body = <iframe src={src} title={file.name} className="h-[70dvh] w-full border-0 bg-white" />;
  }
  return (
    <Dialog open={!!file} onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader title={file?.name ?? ""} description={file ? formatBytes(file.size) : undefined} />
        <div className="min-h-40 overflow-auto bg-slate-100 dark:bg-slate-950">{file ? body : null}</div>
        <DialogFooter>
          <Button asChild variant="outline">
            <a href={file ? `/api/files/${file.id}/download` : "#"}>
              <Download /> Download
            </a>
          </Button>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
