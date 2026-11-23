import { Search, Share2, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { USAGE_CHANGED_EVENT } from "@/auth";
import { ConfirmDialog } from "@/components/dialogs";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useSearchParams } from "react-router";
import type { DriveItem, FileItem, FolderItem } from "@shared/types";
import { FileList } from "@/components/FileList";
import { useListView, ViewToggle } from "@/components/listControls";
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from "@/components/states";
import { useItemActions } from "@/components/useItemActions";
import { useApi } from "@/lib/hooks";

export function SharedPage() {
  const { data, error, loading, reload } = useApi<{ files: FileItem[] }>("/api/shared");
  const items = useMemo(() => data?.files ?? [], [data]);
  const { actionsFor, open, dialogs } = useItemActions("shared", reload, items, !!data);
  const { view, setView, sort, onSort } = useListView({ key: "updated", dir: "desc" });
  return (
    <div className="pb-24">
      <PageHeader title="Shared with me" description="Files other members shared with you (view and download).">
        <ViewToggle view={view} setView={setView} />
      </PageHeader>
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <ListSkeleton /> : null}
      {data && !items.length ? <EmptyState icon={<Share2 />} title="Nothing shared with you yet" /> : null}
      {items.length ? <FileList items={items} actionsFor={actionsFor} onOpen={open} showOwner view={view} sort={sort} onSort={onSort} /> : null}
      {dialogs}
    </div>
  );
}

export function TrashPage() {
  const { data, error, loading, reload } = useApi<{ folders: FolderItem[]; files: FileItem[] }>("/api/trash");
  const items: DriveItem[] = useMemo(() => (data ? [...data.folders, ...data.files] : []), [data]);
  const { actionsFor, open, dialogs, bulkBar, selection } = useItemActions("trash", reload, items, !!data);
  const { sort, onSort } = useListView({ key: "updated", dir: "desc" });
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  return (
    <div className="pb-24">
      <PageHeader title="Trash" description="Items in trash still count toward your storage and are deleted forever after the retention period.">
        {items.length ? (
          <Button variant="outline" onClick={() => setConfirmEmpty(true)}>
            <Trash2 /> Empty trash
          </Button>
        ) : null}
      </PageHeader>
      <ConfirmDialog
        open={confirmEmpty}
        title="Empty trash?"
        body="Everything in your trash will be permanently deleted. This cannot be undone."
        confirmLabel="Empty trash"
        destructive
        onClose={() => setConfirmEmpty(false)}
        onConfirm={async () => {
          let left = 1;
          let purged = 0;
          // The server works in batches; keep going until nothing is left.
          for (let i = 0; i < 50 && left > 0; i++) {
            const r = await api<{ purged: number; remaining: number }>("/api/trash/empty", { method: "POST" });
            purged += r.purged;
            left = r.remaining;
          }
          toast.success(`Deleted ${purged} item${purged === 1 ? "" : "s"} permanently`);
          window.dispatchEvent(new Event(USAGE_CHANGED_EVENT));
          reload();
        }}
      />
      {bulkBar}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <ListSkeleton /> : null}
      {data && !items.length ? <EmptyState icon={<Trash2 />} title="Trash is empty" /> : null}
      {items.length ? (
        <FileList items={items} actionsFor={actionsFor} onOpen={open} dateLabel="Trashed" sort={sort} onSort={onSort} {...selection} />
      ) : null}
      {dialogs}
    </div>
  );
}

export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get("q") ?? "";
  const { data, error, loading, reload } = useApi<{ folders: FolderItem[]; files: FileItem[] }>(q ? `/api/search?q=${encodeURIComponent(q)}` : null);
  const items: DriveItem[] = useMemo(() => (data ? [...data.folders, ...data.files] : []), [data]);
  const { actionsFor, open, dialogs, bulkBar, selection } = useItemActions("search", reload, items, !!data);
  const { view, setView, sort, onSort } = useListView();
  return (
    <div className="pb-24">
      <PageHeader title={`Results for “${q}”`}>
        <ViewToggle view={view} setView={setView} />
      </PageHeader>
      {bulkBar}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <ListSkeleton /> : null}
      {data && !items.length ? (
        <EmptyState icon={<Search />} title="No matches">
          Search looks at names of your files and files shared with you.
        </EmptyState>
      ) : null}
      {items.length ? (
        <FileList items={items} actionsFor={actionsFor} onOpen={open} showOwner view={view} sort={sort} onSort={onSort} {...selection} />
      ) : null}
      {dialogs}
    </div>
  );
}
