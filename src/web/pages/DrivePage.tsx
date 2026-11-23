import { ChevronRight, FolderPlus, Upload, UploadCloud } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import type { DriveItem, FolderListing } from "@shared/types";
import { FileList, ListSkeleton } from "@/components/FileList";
import { NameDialog } from "@/components/dialogs";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/misc";
import { useItemActions } from "@/components/useItemActions";
import { api } from "@/lib/api";
import { useApi, useOnline } from "@/lib/hooks";
import { UPLOADED_EVENT, useUploads } from "@/upload/UploadProvider";

export function DrivePage() {
  const { folderId } = useParams();
  const current = folderId ?? null;
  const { data, error, loading, reload } = useApi<FolderListing>(current ? `/api/folders/${current}` : "/api/folders/root");
  const { enqueue } = useUploads();
  const online = useOnline();
  const [newFolder, setNewFolder] = useState(false);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const { actionsFor, open, dialogs } = useItemActions("drive", reload);

  useEffect(() => {
    const onUploaded = (e: Event) => {
      if ((e as CustomEvent<{ folderId: string | null }>).detail.folderId === current) void reload();
    };
    window.addEventListener(UPLOADED_EVENT, onUploaded);
    return () => window.removeEventListener(UPLOADED_EVENT, onUploaded);
  }, [current, reload]);

  const startUpload = (files: FileList | null) => {
    if (!files?.length) return;
    if (!online) return toast.error("You are offline. Connect to the internet to upload.");
    enqueue(files, current);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    startUpload(e.dataTransfer.files);
  };

  const items: DriveItem[] = data ? [...data.folders, ...data.files] : [];
  const title = data?.folder?.name ?? "My Drive";

  return (
    <div
      className="relative min-h-full pb-28"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        depth.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-center gap-2 px-4 pt-4 pb-2 sm:px-6">
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
          <ol className="flex flex-wrap items-center gap-1 text-lg font-semibold">
            <li>
              {current ? (
                <Link to="/" className="rounded px-1 text-slate-500 hover:text-slate-900 hover:underline dark:hover:text-white">
                  My Drive
                </Link>
              ) : (
                <h1 className="px-1">My Drive</h1>
              )}
            </li>
            {data?.breadcrumb.map((b, i) => (
              <li key={b.id} className="flex min-w-0 items-center gap-1">
                <ChevronRight className="size-4 shrink-0 text-slate-400" aria-hidden />
                {i === data.breadcrumb.length - 1 ? (
                  <h1 className="truncate px-1" aria-current="page">
                    {b.name}
                  </h1>
                ) : (
                  <Link to={`/folders/${b.id}`} className="truncate rounded px-1 text-slate-500 hover:underline">
                    {b.name}
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </nav>
        <Button variant="outline" onClick={() => setNewFolder(true)}>
          <FolderPlus /> <span className="hidden sm:inline">New folder</span>
          <span className="sr-only sm:hidden">New folder</span>
        </Button>
        <Button onClick={() => input.current?.click()}>
          <Upload /> Upload
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={(e) => {
            startUpload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <ListSkeleton /> : null}
      {data && !items.length ? (
        <EmptyState icon={<UploadCloud />} title={current ? "This folder is empty" : "Your Drive is empty"}>
          Drag files here or use <strong>Upload</strong>. New files are private until you share them.
        </EmptyState>
      ) : null}
      {items.length ? <FileList items={items} actionsFor={actionsFor} onOpen={open} /> : null}
      {data?.truncated ? <p className="px-6 py-3 text-sm text-slate-500">Showing the first 2,000 items.</p> : null}

      {dragging ? (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-brand-600 bg-brand-50/80 dark:bg-brand-800/30">
          <div className="flex flex-col items-center gap-2 text-brand-800 dark:text-brand-100">
            <UploadCloud className="size-10" aria-hidden />
            <p className="font-semibold">Drop to upload to {title}</p>
          </div>
        </div>
      ) : null}

      <NameDialog
        open={newFolder}
        title="New folder"
        initial="Untitled folder"
        submitLabel="Create"
        onClose={() => setNewFolder(false)}
        onSubmit={async (name) => {
          await api("/api/folders", { method: "POST", body: { name, parentId: current } });
          void reload();
        }}
      />
      {dialogs}
    </div>
  );
}
