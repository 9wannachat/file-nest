import { Download, Eye, FolderInput, Pencil, RotateCcw, Share2, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type { DriveItem, FileItem } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import type { ItemAction } from "./FileList";
import { ConfirmDialog, MoveDialog, NameDialog, PreviewDialog, ShareDialog } from "./dialogs";

export type ListMode = "drive" | "shared" | "trash" | "search";

const path = (i: DriveItem) => (i.kind === "folder" ? `/api/folders/${i.id}` : `/api/files/${i.id}`);

function download(file: FileItem) {
  const a = document.createElement("a");
  a.href = `/api/files/${file.id}/download`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function useItemActions(mode: ListMode, reload: () => void) {
  const navigate = useNavigate();
  const [rename, setRename] = useState<DriveItem | null>(null);
  const [move, setMove] = useState<DriveItem | null>(null);
  const [share, setShare] = useState<FileItem | null>(null);
  const [preview, setPreview] = useState<FileItem | null>(null);
  const [purge, setPurge] = useState<DriveItem | null>(null);

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
    if (item.kind === "folder") navigate(`/folders/${item.id}`);
    else setPreview(item);
  };

  const actionsFor = (item: DriveItem): ItemAction[] => {
    if (mode === "trash") {
      return [
        { id: "restore", label: "Restore", icon: <RotateCcw />, onSelect: () => void act(() => api(`${path(item)}/restore`, { method: "POST" }), `Restored “${item.name}”`) },
        { id: "purge", label: "Delete forever", icon: <XCircle />, destructive: true, separatorBefore: true, onSelect: () => setPurge(item) },
      ];
    }
    const owned = item.kind === "folder" || item.isOwner;
    const list: ItemAction[] = [];
    if (item.kind === "file") {
      list.push({ id: "preview", label: "Preview", icon: <Eye />, onSelect: () => setPreview(item) });
      list.push({ id: "download", label: "Download", icon: <Download />, onSelect: () => download(item) });
      if (owned) list.push({ id: "share", label: "Share", icon: <Share2 />, onSelect: () => setShare(item) });
    }
    if (owned) {
      list.push({ id: "rename", label: "Rename", icon: <Pencil />, shortcut: "F2", onSelect: () => setRename(item), separatorBefore: item.kind === "file" });
      list.push({ id: "move", label: "Move to…", icon: <FolderInput />, onSelect: () => setMove(item) });
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
        itemName={move?.name ?? ""}
        excludeFolderId={move?.kind === "folder" ? move.id : undefined}
        onClose={() => setMove(null)}
        onMove={async (dest) => {
          await api(path(move!), { method: "PATCH", body: move!.kind === "folder" ? { parentId: dest } : { folderId: dest } });
          toast.success(`Moved “${move!.name}”`);
          reload();
        }}
      />
      <ShareDialog file={share} onClose={() => setShare(null)} onChanged={reload} />
      <PreviewDialog file={preview} onClose={() => setPreview(null)} />
      <ConfirmDialog
        open={!!purge}
        title="Delete forever?"
        body={`“${purge?.name ?? ""}”${purge?.kind === "folder" ? " and everything in it" : ""} will be permanently deleted. This cannot be undone.`}
        confirmLabel="Delete forever"
        destructive
        onClose={() => setPurge(null)}
        onConfirm={async () => {
          await api(path(purge!), { method: "DELETE" });
          toast.success("Deleted permanently");
          reload();
        }}
      />
    </>
  );

  return { actionsFor, open, dialogs, errorMessage };
}
