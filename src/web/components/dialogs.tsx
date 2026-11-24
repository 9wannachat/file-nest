import { ChevronRight, Copy, Download, Eye, EyeOff, Folder, Globe, Home, KeyRound, Lock, UserPlus, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { FileItem, FolderListing, MemberLite, Sharing } from "@shared/types";
import { ErrorState, Spinner } from "@/components/states";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatBytes } from "@/lib/utils";
import { t } from "@/i18n";

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
    if (!name.trim()) return setError(t("Name is required"));
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
        className="sm:max-w-md"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          const el = (e.currentTarget as HTMLElement).querySelector("input");
          el?.focus();
          const dot = initial.lastIndexOf(".");
          el?.setSelectionRange(0, dot > 0 ? dot : initial.length);
        }}
      >
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">{title}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="name-input">{t("Name")}</Label>
            <Input
              id="name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={255}
              aria-invalid={!!error}
              aria-describedby={error ? "name-error" : undefined}
            />
            {error ? (
              <p id="name-error" role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner className="text-primary-foreground" /> : null}
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
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className={destructive ? buttonVariants({ variant: "destructive" }) : undefined}
            disabled={busy}
            onClick={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Folder picker for "Move to". */
export function MoveDialog({
  open,
  itemName,
  excludeFolderIds = [],
  onClose,
  onMove,
}: {
  open: boolean;
  itemName: string;
  excludeFolderIds?: string[];
  onClose: () => void;
  onMove: (folderId: string | null) => Promise<void>;
}) {
  const [at, setAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, loading, error, reload } = useApi<FolderListing>(open ? (at ? `/api/folders/${at}` : "/api/folders/root") : null);
  useEffect(() => {
    if (open) setAt(null);
  }, [open]);
  const folders = data?.folders.filter((f) => !excludeFolderIds.includes(f.id)) ?? [];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Move “")}{itemName}”</DialogTitle>
          <DialogDescription>{t("Choose a destination folder")}</DialogDescription>
        </DialogHeader>
        <nav aria-label={t("Destination path")} className="flex flex-wrap items-center gap-1 text-sm">
          <Button variant="ghost" size="sm" onClick={() => setAt(null)}>
            <Home />{" "}{t("My Drive")}
          </Button>
          {data?.breadcrumb.map((b) => (
            <span key={b.id} className="inline-flex items-center gap-1">
              <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
              <Button variant="ghost" size="sm" onClick={() => setAt(b.id)}>
                {b.name}
              </Button>
            </span>
          ))}
        </nav>
        <ScrollArea className="h-64 rounded-md border">
          <div className="p-1">
            {loading ? <Spinner className="m-4" /> : null}
            {error ? <ErrorState message={error} onRetry={reload} /> : null}
            {data && !folders.length ? <p className="p-4 text-sm text-muted-foreground">{t("No subfolders here.")}</p> : null}
            {folders.map((f) => (
              <button
                key={f.id}
                className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-accent"
                onClick={() => setAt(f.id)}
              >
                <Folder className="size-5 fill-primary/15 text-primary" /> <span className="flex-1 truncate">{f.name}</span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </button>
            ))}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
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
            {t("Move here")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Optional password on the public link. The password is never shown again after saving. */
function LinkPasswordControl({
  fileId,
  protectedNow,
  busy,
  onChange,
}: {
  fileId: string;
  protectedNow: boolean;
  busy: boolean;
  onChange: (fn: () => Promise<Sharing>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const tooShort = [...pw].length < 8;
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (tooShort) return;
    onChange(async () => {
      const r = await api<Sharing>(`/api/files/${fileId}/sharing/link/password`, { method: "PUT", body: { password: pw } });
      setPw("");
      setEditing(false);
      toast.success(t("Password saved. Send it separately from the link."));
      return r;
    });
  };
  return (
    <div className="grid gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2 text-sm">
        <KeyRound className="size-4 text-muted-foreground" aria-hidden />
        <span className="flex-1 font-medium">{protectedNow ? t("Password required to open") : t("No password")}</span>
        <Badge variant={protectedNow ? "default" : "secondary"}>{protectedNow ? t("Protected") : t("Open")}</Badge>
      </div>
      {editing ? (
        <form onSubmit={save} className="grid gap-2">
          <Label htmlFor="link-password">{protectedNow ? t("New password") : t("Password")}</Label>
          <div className="flex gap-2">
            <Input
              id="link-password"
              type={show ? "text" : "password"}
              autoComplete="new-password"
              value={pw}
              maxLength={128}
              onChange={(e) => setPw(e.target.value)}
              aria-describedby="link-password-help"
              autoFocus
            />
            <Button type="button" size="icon" variant="outline" aria-label={show ? t("Hide password") : t("Show password")} onClick={() => setShow(!show)}>
              {show ? <EyeOff /> : <Eye />}
            </Button>
          </div>
          <p id="link-password-help" className="text-xs text-muted-foreground">
            {t("8–128 characters. Viewers must enter it to preview or download. It cannot be shown again.")}
          </p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || tooShort}>
              {t("Save password")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => (setEditing(false), setPw(""))}>
              {t("Cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
            <KeyRound /> {protectedNow ? t("Change password") : t("Add password")}
          </Button>
          {protectedNow ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => onChange(() => api<Sharing>(`/api/files/${fileId}/sharing/link/password`, { method: "DELETE" }))}
            >
              {t("Remove password")}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

const initials = (s: string) => s.slice(0, 1).toUpperCase();

export function ShareDialog({ file, onClose, onChanged }: { file: FileItem | null; onClose: () => void; onChanged: () => void }) {
  const open = !!file;
  const { data, error, loading, reload, setData } = useApi<Sharing>(file ? `/api/files/${file.id}/sharing` : null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<MemberLite[]>([]);
  const [busy, setBusy] = useState(false);

  // Fresh member search for every file.
  useEffect(() => {
    setQ("");
    setResults([]);
  }, [file?.id]);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      api<{ members: MemberLite[] }>(`/api/members?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => setResults(r.members))
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(timer);
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
  const setAccess = (v: string) =>
    mutate(() => api<Sharing>(`/api/files/${file!.id}/sharing/link`, { method: v === "public" ? "POST" : "DELETE" }));
  const memberIds = data?.members.map((m) => m.id) ?? [];
  const candidates = results.filter((r) => !memberIds.includes(r.id));

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("Link copied"));
    } catch {
      toast.error(t("Could not copy. Select the link and copy it manually."));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{t("Share “")}{file?.name ?? ""}”</DialogTitle>
          <DialogDescription>{t("Choose who can open this file.")}</DialogDescription>
        </DialogHeader>
        {loading && !data ? <Spinner /> : null}
        {error ? <ErrorState message={error} onRetry={reload} /> : null}
        {data ? (
          <div className="grid gap-5">
            <section aria-labelledby="people" className="grid gap-2">
              <h3 id="people" className="text-sm font-medium">
                {t("Members with access")}{" "}<span className="font-normal text-muted-foreground">{t("(view & download)")}</span>
              </h3>
              <div className="relative">
                <UserPlus className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  aria-label={t("Add member")}
                  placeholder={t("Add members by name or email")}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  className="pl-9"
                />
              </div>
              {candidates.length ? (
                <ul className="max-h-40 overflow-y-auto rounded-md border" aria-label={t("Suggestions")}>
                  {candidates.map((m) => (
                    <li key={m.id}>
                      <button
                        className="flex min-h-11 w-full items-center gap-3 px-3 text-left text-sm hover:bg-accent"
                        disabled={busy}
                        onClick={() => void setMembers([...memberIds, m.id])}
                      >
                        <Avatar className="size-7">
                          <AvatarFallback className="text-xs">{initials(m.name ?? m.email)}</AvatarFallback>
                        </Avatar>
                        <span className="truncate">{m.name ? `${m.name} · ${m.email}` : m.email}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <ul className="grid gap-1">
                {data.members.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 rounded-md px-1 py-1">
                    <Avatar className="size-8">
                      <AvatarFallback className="text-xs">{initials(m.name ?? m.email)}</AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{m.name ?? m.email}</span>
                      <span className="block truncate text-xs text-muted-foreground">{m.email}</span>
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("Remove {email}", { email: m.email })}
                      disabled={busy}
                      onClick={() => void setMembers(memberIds.filter((id) => id !== m.id))}
                    >
                      <X />
                    </Button>
                  </li>
                ))}
                {!data.members.length ? <li className="px-1 text-sm text-muted-foreground">{t("Not shared with any member yet.")}</li> : null}
              </ul>
            </section>

            <Separator />

            <section aria-labelledby="general-access" className="grid gap-3">
              <h3 id="general-access" className="text-sm font-medium">
                {t("General access")}
              </h3>
              <div className="flex items-start gap-3">
                <span
                  className={
                    data.visibility === "public"
                      ? "flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary"
                      : "flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                  }
                >
                  {data.visibility === "public" ? <Globe className="size-4" /> : <Lock className="size-4" />}
                </span>
                <div className="grid min-w-0 flex-1 gap-1">
                  <Select value={data.visibility} onValueChange={(v) => void setAccess(v)} disabled={busy}>
                    <SelectTrigger aria-label={t("General access")} className="w-full sm:w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="private">{t("Restricted")}</SelectItem>
                      <SelectItem value="public" disabled={data.policy?.publicLinksEnabled === false}>
                        {t("Anyone with the link")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {data.visibility === "public"
                      ? t("Anyone with the link can view and download without signing in.")
                      : t("Only you and the members above can open this file.")}
                  </p>
                </div>
              </div>
              {data.policy?.publicLinksEnabled === false ? (
                <p role="note" className="text-xs text-muted-foreground">
                  {t("Public links are turned off by an Admin.")}
                </p>
              ) : null}
              {data.publicLink && data.policy?.requirePassword && !data.publicLink.passwordProtected ? (
                <p role="alert" className="rounded-md border border-warning/50 bg-warning/15 p-2 text-xs">
                  {t("Your organization requires a password on public links. This link won’t open until you add one.")}
                </p>
              ) : null}
              {data.publicLink ? (
                <>
                  <div className="flex gap-2">
                    <Input readOnly value={data.publicLink.url} aria-label={t("Public link")} onFocus={(e) => e.currentTarget.select()} className="text-xs" />
                    <Button variant="outline" aria-label={t("Copy link")} onClick={() => void copy(data.publicLink!.url)}>
                      <Copy />{" "}{t("Copy")}
                    </Button>
                  </div>
                  <LinkPasswordControl fileId={file!.id} protectedNow={data.publicLink.passwordProtected} busy={busy} onChange={(fn) => void mutate(fn)} />
                </>
              ) : null}
            </section>
          </div>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose}>{t("Done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Preview streams from /api/files/:id/preview (same origin only). */
export function PreviewDialog({ file, onClose }: { file: FileItem | null; onClose: () => void }) {
  const src = file ? `/api/files/${file.id}/preview` : "";
  const ct = file?.contentType ?? "";
  let body = <p className="p-6 text-sm text-muted-foreground">{t("Preview is not available for this file type. Download it to open.")}</p>;
  if (file?.inline) {
    if (ct.startsWith("image/")) body = <img src={src} alt={file.name} className="mx-auto max-h-[70dvh] max-w-full object-contain" />;
    else if (ct.startsWith("video/")) body = <video src={src} controls playsInline preload="metadata" className="mx-auto max-h-[70dvh] max-w-full" />;
    else if (ct.startsWith("audio/")) body = <audio src={src} controls preload="metadata" className="m-6 w-[calc(100%-3rem)]" />;
    else body = <iframe src={src} title={file.name} className="h-[70dvh] w-full border-0 bg-white" />;
  }
  return (
    <Dialog open={!!file} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-3 p-4 sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{file?.name ?? ""}</DialogTitle>
          <DialogDescription>{file ? formatBytes(file.size) : ""}</DialogDescription>
        </DialogHeader>
        <div className="min-h-40 overflow-auto rounded-md bg-muted">{file ? body : null}</div>
        <DialogFooter>
          <Button asChild variant="outline">
            <a href={file ? `/api/files/${file.id}/download` : "#"}>
              <Download />{" "}{t("Download")}
            </a>
          </Button>
          <Button onClick={onClose}>{t("Close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
