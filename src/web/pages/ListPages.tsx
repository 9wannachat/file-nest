import { Search, Share2, Trash2 } from "lucide-react";
import { useSearchParams } from "react-router";
import type { DriveItem, FileItem, FolderItem } from "@shared/types";
import { FileList, ListSkeleton } from "@/components/FileList";
import { EmptyState, ErrorState } from "@/components/ui/misc";
import { useItemActions } from "@/components/useItemActions";
import { useApi } from "@/lib/hooks";

function PageTitle({ children, sub }: { children: string; sub?: string }) {
  return (
    <div className="px-4 pt-4 pb-2 sm:px-6">
      <h1 className="text-lg font-semibold">{children}</h1>
      {sub ? <p className="text-sm text-slate-500">{sub}</p> : null}
    </div>
  );
}

export function SharedPage() {
  const { data, error, loading, reload } = useApi<{ files: FileItem[] }>("/api/shared");
  const { actionsFor, open, dialogs } = useItemActions("shared", reload);
  return (
    <div className="pb-24">
      <PageTitle sub="Files other members shared with you (view and download).">Shared with me</PageTitle>
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <ListSkeleton /> : null}
      {data && !data.files.length ? (
        <EmptyState icon={<Share2 />} title="Nothing shared with you yet" />
      ) : null}
      {data?.files.length ? <FileList items={data.files} actionsFor={actionsFor} onOpen={open} showOwner /> : null}
      {dialogs}
    </div>
  );
}

export function TrashPage() {
  const { data, error, loading, reload } = useApi<{ folders: FolderItem[]; files: FileItem[] }>("/api/trash");
  const { actionsFor, open, dialogs } = useItemActions("trash", reload);
  const items: DriveItem[] = data ? [...data.folders, ...data.files] : [];
  return (
    <div className="pb-24">
      <PageTitle sub="Items in trash are deleted forever after the retention period.">Trash</PageTitle>
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <ListSkeleton /> : null}
      {data && !items.length ? <EmptyState icon={<Trash2 />} title="Trash is empty" /> : null}
      {items.length ? <FileList items={items} actionsFor={actionsFor} onOpen={open} dateLabel="Trashed" /> : null}
      {dialogs}
    </div>
  );
}

export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get("q") ?? "";
  const { data, error, loading, reload } = useApi<{ folders: FolderItem[]; files: FileItem[] }>(
    q ? `/api/search?q=${encodeURIComponent(q)}` : null,
  );
  const { actionsFor, open, dialogs } = useItemActions("search", reload);
  const items: DriveItem[] = data ? [...data.folders, ...data.files] : [];
  return (
    <div className="pb-24">
      <PageTitle>{`Results for “${q}”`}</PageTitle>
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <ListSkeleton /> : null}
      {data && !items.length ? (
        <EmptyState icon={<Search />} title="No matches">
          Search looks at names of your files and files shared with you.
        </EmptyState>
      ) : null}
      {items.length ? <FileList items={items} actionsFor={actionsFor} onOpen={open} showOwner /> : null}
      {dialogs}
    </div>
  );
}
