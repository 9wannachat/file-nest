import { Download, Eye, FolderInput, Pencil, RotateCcw, Share2, Trash2, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import type { DriveItem, FileItem } from "@shared/types";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import { itemKey, type ItemAction } from "./FileList";
import { withListParams } from "./listControls";
import { USAGE_CHANGED_EVENT } from "@/auth";
import { ConfirmDialog, MoveDialog, NameDialog, PreviewDialog, ShareDialog } from "./dialogs";

export type ListMode = "drive" | "shared" | "trash" | "search";

const path = (i: DriveItem) => (i.kind === "folder" ? `/api/folders/${i.id}` : `/api/files/${i.id}`);
const owned = (i: DriveItem) => i.kind === "folder" || i.isOwner;

function download(file: FileItem) {
  const a = document.createElement("a");
  a.href = `/api/files/${file.id}/download`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Run with at most `limit` requests in flight. */
async function settleLimited<T>(items: T[], fn: (i: T) => Promise<unknown>, limit = 6): Promise<PromiseSettledResult<unknown>[]> {
  const out: PromiseSettledResult<unknown>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]!) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Drop items whose parent folder is also selected (the parent operation already covers them). */
function withoutCoveredChildren(items: DriveItem[]): DriveItem[] {
  const folders = new Set(items.filter((i) => i.kind === "folder").map((i) => i.id));
  return items.filter((i) => {
    const parent = i.kind === "folder" ? i.parentId : i.folderId;
    return !(parent && folders.has(parent));
  });
}

async function runAll(items: DriveItem[], fn: (i: DriveItem) => Promise<unknown>, verb: string) {
  const results = await settleLimited(withoutCoveredChildren(items), fn);
  const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  const ok = results.length - failed.length;
  if (ok) toast.success(`${verb} ${ok} item${ok > 1 ? "s" : ""}`);
  if (failed.length) toast.error(`${failed.length} item(s) failed: ${errorMessage(failed[0]!.reason)}`);
}

/**
 * Actions, dialogs and multi-select for a list. `items` lets `?preview=<fileId>`
 * (used by the command palette) open the preview for an item in the list.
 */
export function useItemActions(mode: ListMode, reload: () => void, items: DriveItem[] = [], loaded = true) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [rename, setRename] = useState<DriveItem | null>(null);
  const [move, setMove] = useState<DriveItem[] | null>(null);
  const [share, setShare] = useState<FileItem | null>(null);
  const [preview, setPreview] = useState<FileItem | null>(null);
  const [purge, setPurge] = useState<DriveItem[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Deep link: ?preview=<fileId> (command palette). The param drives the dialog,
  // so browser Back closes it too.
  const previewParam = mode === "trash" ? null : params.get("preview");
  const fromParam = previewParam ? (items.find((i): i is FileItem => i.kind === "file" && i.id === previewParam) ?? null) : null;
  const dropPreviewParam = () => {
    const next = new URLSearchParams(params);
    next.delete("preview");
    setParams(next, { replace: true });
  };
  useEffect(() => {
    if (previewParam && loaded && !fromParam) {
      toast.error("That file isn’t in this list any more.");
      dropPreviewParam();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewParam, loaded, fromParam]);
  const shownPreview = fromParam ?? preview;
  const closePreview = () => {
    setPreview(null);
    if (previewParam) dropPreviewParam();
  };

  // Drop selections that no longer exist after a reload.
  useEffect(() => {
    setSelected((cur) => {
      if (!cur.size) return cur;
      const live = new Set(items.map(itemKey));
      const next = new Set([...cur].filter((k) => live.has(k)));
      return next.size === cur.size ? cur : next;
    });
  }, [items]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const open = (item: DriveItem) => {
    if (mode === "trash") return;
    if (item.kind === "folder") navigate(withListParams(`/folders/${item.id}`, params));
    else setPreview(item);
  };

  const actionsFor = (item: DriveItem): ItemAction[] => {
    if (mode === "trash") {
      return [
        { id: "restore", label: "Restore", icon: <RotateCcw />, onSelect: () => void act(() => api(`${path(item)}/restore`, { method: "POST" }), `Restored “${item.name}”`) },
        { id: "purge", label: "Delete forever", icon: <XCircle />, destructive: true, separatorBefore: true, onSelect: () => setPurge([item]) },
      ];
    }
    const list: ItemAction[] = [];
    if (item.kind === "file") {
      list.push({ id: "preview", label: "Preview", icon: <Eye />, onSelect: () => setPreview(item) });
      list.push({ id: "download", label: "Download", icon: <Download />, onSelect: () => download(item) });
      if (owned(item)) list.push({ id: "share", label: "Share", icon: <Share2 />, onSelect: () => setShare(item) });
    }
    if (owned(item)) {
      list.push({ id: "rename", label: "Rename", icon: <Pencil />, shortcut: "F2", onSelect: () => setRename(item), separatorBefore: item.kind === "file" });
      list.push({ id: "move", label: "Move to…", icon: <FolderInput />, onSelect: () => setMove([item]) });
      list.push({
        id: "trash",
        label: "Move to trash",
        icon: <Trash2 />,
        destructive: true,
        separatorBefore: true,
        shortcut: "Del",
        onSelect: () => void act(() => api(`${path(item)}/trash`, { method: "POST" }), `Moved “${item.name}” to trash`),
      });
    }
    return list;
  };

  const selectedItems = items.filter((i) => selected.has(itemKey(i)));
  const canSelect = mode !== "shared";
  const clear = () => setSelected(new Set());
  const bulk = async (fn: (i: DriveItem) => Promise<unknown>, verb: string) => {
    setBusy(true);
    try {
      await runAll(selectedItems, fn, verb);
      clear();
      reload();
    } finally {
      setBusy(false);
    }
  };

  const bulkBar =
    canSelect && selectedItems.length ? (
      <div
        role="toolbar"
        aria-label="Selection actions"
        className="sticky top-0 z-10 mx-2 mb-2 flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-sm sm:mx-4"
      >
        <Button size="icon" variant="ghost" aria-label="Clear selection" onClick={clear}>
          <X />
        </Button>
        <span className="mr-auto text-sm font-medium" aria-live="polite">
          {selectedItems.length} selected
        </span>
        {mode === "trash" ? (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void bulk((i) => api(`${path(i)}/restore`, { method: "POST" }), "Restored")}>
              <RotateCcw /> Restore
            </Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => setPurge(selectedItems)}>
              <XCircle /> Delete forever
            </Button>
          </>
        ) : selectedItems.every(owned) ? (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setMove(selectedItems)}>
              <FolderInput /> Move
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void bulk((i) => api(`${path(i)}/trash`, { method: "POST" }), "Moved to trash")}>
              <Trash2 /> Trash
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Some selected items are shared with you and can’t be changed.</span>
        )}
      </div>
    ) : null;

  const dialogs = (
    <>
      <NameDialog
        open={!!rename}
        title={`Rename ${rename?.kind ?? ""}`}
        initial={rename?.name ?? ""}
        submitLabel="Rename"
        onClose={() => setRename(null)}
        onSubmit={async (name) => {
          await api(path(rename!), { method: "PATCH", body: { name } });
          reload();
        }}
      />
      <MoveDialog
        open={!!move}
        itemName={move && move.length > 1 ? `${move.length} items` : (move?.[0]?.name ?? "")}
        excludeFolderIds={(move ?? []).filter((i) => i.kind === "folder").map((i) => i.id)}
        onClose={() => setMove(null)}
        onMove={async (dest) => {
          const list = move ?? [];
          if (list.length === 1) {
            const it = list[0]!;
            await api(path(it), { method: "PATCH", body: it.kind === "folder" ? { parentId: dest } : { folderId: dest } });
            toast.success(`Moved “${it.name}”`);
          } else {
            await runAll(list, (it) => api(path(it), { method: "PATCH", body: it.kind === "folder" ? { parentId: dest } : { folderId: dest } }), "Moved");
            clear();
          }
          reload();
        }}
      />
      <ShareDialog file={share} onClose={() => setShare(null)} onChanged={reload} />
      <PreviewDialog file={shownPreview} onClose={closePreview} />
      <ConfirmDialog
        open={!!purge}
        title="Delete forever?"
        body={
          purge && purge.length > 1
            ? `${purge.length} items will be permanently deleted. This cannot be undone.`
            : `“${purge?.[0]?.name ?? ""}”${purge?.[0]?.kind === "folder" ? " and everything in it" : ""} will be permanently deleted. This cannot be undone.`
        }
        confirmLabel="Delete forever"
        destructive
        onClose={() => setPurge(null)}
        onConfirm={async () => {
          await runAll(purge ?? [], (i) => api(path(i), { method: "DELETE" }), "Deleted");
          clear();
          reload();
          window.dispatchEvent(new Event(USAGE_CHANGED_EVENT));
        }}
      />
    </>
  );

  return {
    actionsFor,
    open,
    dialogs,
    bulkBar,
    selection: canSelect ? { selected, onSelectedChange: setSelected } : {},
  };
}
