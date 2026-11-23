import { Search, Share2, Trash2 } from "lucide-react";
import { useMemo } from "react";
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
  return (
    <div className="pb-24">
      <PageHeader title="Trash" description="Items in trash are deleted forever after the retention period." />
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
