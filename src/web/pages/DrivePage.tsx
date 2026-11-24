import { FolderPlus, Plus, Upload, UploadCloud } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import type { DriveItem, FolderListing } from "@shared/types";
import { FileList } from "@/components/FileList";
import { NameDialog } from "@/components/dialogs";
import { useListView, ViewToggle, withListParams } from "@/components/listControls";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/states";
import { useItemActions } from "@/components/useItemActions";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useApi, useOnline } from "@/lib/hooks";
import { UPLOADED_EVENT, useUploads } from "@/upload/UploadProvider";
import { t } from "@/i18n";

export function DrivePage() {
  const { folderId } = useParams();
  const current = folderId ?? null;
  const { data, error, loading, reload } = useApi<FolderListing>(current ? `/api/folders/${current}` : "/api/folders/root");
  const { enqueue, items: uploadItems } = useUploads();
  const [params] = useSearchParams();
  const online = useOnline();
  const [newFolder, setNewFolder] = useState(false);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const items: DriveItem[] = useMemo(() => (data ? [...data.folders, ...data.files] : []), [data]);
  const { actionsFor, open, dialogs, bulkBar, selection } = useItemActions("drive", reload, items, !!data);
  const { view, setView, sort, onSort } = useListView();

  useEffect(() => {
    const onUploaded = (e: Event) => {
      if ((e as CustomEvent<{ folderId: string | null }>).detail.folderId === current) void reload();
    };
    window.addEventListener(UPLOADED_EVENT, onUploaded);
    return () => window.removeEventListener(UPLOADED_EVENT, onUploaded);
  }, [current, reload]);

  const startUpload = (files: FileList | null) => {
    if (!files?.length) return;
    if (!online) return toast.error(t("You are offline. Connect to the internet to upload."));
    enqueue(files, current);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    startUpload(e.dataTransfer.files);
  };

  const title = data?.folder?.name ?? t("My Drive");
  const crumbs = data?.breadcrumb ?? [];

  return (
    <div
      className="relative min-h-full pb-28"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes(t("Files"))) return;
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
      <div className="flex flex-wrap items-center gap-2 px-4 pt-5 pb-3 sm:px-6">
        <div className="min-w-0 flex-1">
          {current ? (
            <Breadcrumb>
              <BreadcrumbList className="text-base">
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link to={withListParams("/", params)}>{t("My Drive")}</Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                {crumbs.map((b, i) => (
                  <Fragment key={b.id}>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem className="min-w-0">
                      {i === crumbs.length - 1 ? (
                        <BreadcrumbPage className="truncate">
                          <h1 className="truncate text-xl font-semibold tracking-tight">{b.name}</h1>
                        </BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink asChild className="truncate">
                          <Link to={withListParams(`/folders/${b.id}`, params)}>{b.name}</Link>
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                ))}
              </BreadcrumbList>
            </Breadcrumb>
          ) : (
            <h1 className="text-xl font-semibold tracking-tight">{t("My Drive")}</h1>
          )}
        </div>
        <ViewToggle view={view} setView={setView} />
        <Button variant="outline" onClick={() => setNewFolder(true)} aria-label={t("New folder")}>
          <FolderPlus /> <span className="hidden sm:inline">{t("New folder")}</span>
        </Button>
        <Button onClick={() => input.current?.click()} aria-label={t("Upload")}>
          <Upload /> <span className="hidden sm:inline">{t("Upload")}</span>
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

      {bulkBar}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <ListSkeleton /> : null}
      {data && !items.length ? (
        <EmptyState icon={<UploadCloud />} title={current ? t("This folder is empty") : t("Your Drive is empty")}>
          {t("Drag files here or use")}{" "}<strong>{t("Upload")}</strong>{t(". New files are private until you share them.")}
        </EmptyState>
      ) : null}
      {items.length ? (
        <FileList items={items} actionsFor={actionsFor} onOpen={open} view={view} sort={sort} onSort={onSort} {...selection} />
      ) : null}
      {data?.truncated ? <p className="px-6 py-3 text-sm text-muted-foreground">{t("Showing the first 2,000 items.")}</p> : null}

      {/* Mobile: floating upload button (hidden while the upload panel occupies the bottom edge) */}
      {uploadItems.length ? null : <Button
        size="icon-lg"
        className="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-20 size-14 min-h-[52px] min-w-[52px] rounded-full shadow-lg md:hidden"
        aria-label={t("Upload")}
        onClick={() => input.current?.click()}
      >
        <Plus className="size-6" />
      </Button>}

      {dragging ? (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-accent/80">
          <div className="flex flex-col items-center gap-2 text-accent-foreground">
            <UploadCloud className="size-10" aria-hidden />
            <p className="font-semibold">{t("Drop to upload to")}{" "}{title}</p>
          </div>
        </div>
      ) : null}

      <NameDialog
        open={newFolder}
        title={t("New folder")}
        initial="Untitled folder"
        submitLabel={t("Create")}
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
