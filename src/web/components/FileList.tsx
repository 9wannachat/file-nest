import { File, FileImage, FileText, FileVideo, Folder, Globe, MoreVertical, Music, Users } from "lucide-react";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import type { DriveItem, FileItem } from "@shared/types";
import { cn, formatBytes, formatDate } from "@/lib/utils";
import { Button } from "./ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/menu";

export interface ItemAction {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  separatorBefore?: boolean;
  shortcut?: string;
}

export function fileIcon(f: FileItem) {
  const t = f.contentType;
  if (t.startsWith("image/")) return <FileImage className="text-violet-600" />;
  if (t.startsWith("video/")) return <FileVideo className="text-rose-600" />;
  if (t.startsWith("audio/")) return <Music className="text-amber-600" />;
  if (t === "application/pdf" || t.startsWith("text/")) return <FileText className="text-sky-600" />;
  return <File className="text-slate-500" />;
}

interface Props {
  items: DriveItem[];
  actionsFor: (item: DriveItem) => ItemAction[];
  onOpen: (item: DriveItem) => void;
  showOwner?: boolean;
  dateLabel?: string;
}

export function FileList({ items, actionsFor, onOpen, showOwner, dateLabel = "Modified" }: Props) {
  const listRef = useRef<HTMLUListElement>(null);

  const focusRow = (idx: number) => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-row]");
    if (!rows?.length) return;
    rows[Math.max(0, Math.min(rows.length - 1, idx))]?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLElement>, item: DriveItem, idx: number) => {
    const actions = actionsFor(item);
    const run = (id: string) => actions.find((a) => a.id === id)?.onSelect();
    if (e.key === "Enter") {
      e.preventDefault();
      onOpen(item);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(idx + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(idx - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusRow(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusRow(items.length - 1);
    } else if (e.key === "F2") {
      e.preventDefault();
      run("rename");
    } else if (e.key === "Delete") {
      e.preventDefault();
      run("trash");
    }
  };

  return (
    <div className="px-2 sm:px-4">
      <div
        aria-hidden
        className="hidden grid-cols-[minmax(0,1fr)_10rem_11rem_6rem_3rem] gap-3 border-b border-slate-200 px-3 py-2 text-xs font-medium tracking-wide text-slate-500 uppercase md:grid dark:border-slate-800"
      >
        <span>Name</span>
        <span>{showOwner ? "Owner" : ""}</span>
        <span>{dateLabel}</span>
        <span className="text-right">Size</span>
        <span />
      </div>
      <ul ref={listRef} aria-label="Files and folders" className="divide-y divide-slate-100 dark:divide-slate-800/70">
        {items.map((item, idx) => {
          const actions = actionsFor(item);
          const label = item.kind === "folder" ? `Folder ${item.name}` : `File ${item.name}`;
          return (
            <ContextMenu key={`${item.kind}-${item.id}`}>
              <ContextMenuTrigger asChild>
                <li
                  data-row
                  tabIndex={0}
                  aria-label={label}
                  onDoubleClick={() => onOpen(item)}
                  onKeyDown={(e) => onKey(e, item, idx)}
                  className="group grid min-h-14 cursor-default grid-cols-[minmax(0,1fr)_3rem] items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-100/70 focus:bg-brand-50 focus:outline-none md:grid-cols-[minmax(0,1fr)_10rem_11rem_6rem_3rem] dark:hover:bg-slate-800/50 dark:focus:bg-brand-800/20"
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => onOpen(item)}
                    className="flex min-w-0 items-center gap-3 text-left [&_svg]:size-5 [&_svg]:shrink-0"
                  >
                    {item.kind === "folder" ? <Folder className="fill-brand-100 text-brand-700" /> : fileIcon(item)}
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{item.name}</span>
                      <span className="block truncate text-xs text-slate-500 md:hidden">
                        {item.kind === "file" ? `${formatBytes(item.size)} · ` : ""}
                        {formatDate(item.trashedAt ?? item.updatedAt)}
                        {showOwner && item.kind === "file" ? ` · ${item.owner.name ?? item.owner.email}` : ""}
                      </span>
                    </span>
                    {item.kind === "file" && item.hasPublicLink ? (
                      <Globe className="!size-4 text-brand-700" aria-label="Public link" />
                    ) : null}
                    {item.kind === "file" && item.sharedWithCount > 0 ? (
                      <Users className="!size-4 text-slate-500" aria-label={`Shared with ${item.sharedWithCount}`} />
                    ) : null}
                  </button>
                  <span className="hidden truncate text-sm text-slate-500 md:block">
                    {showOwner && item.kind === "file" ? (item.owner.name ?? item.owner.email) : ""}
                  </span>
                  <span className="hidden text-sm whitespace-nowrap text-slate-500 md:block">{formatDate(item.trashedAt ?? item.updatedAt)}</span>
                  <span className="hidden text-right text-sm text-slate-500 tabular-nums md:block">
                    {item.kind === "file" ? formatBytes(item.size) : "—"}
                  </span>
                  <span className="flex justify-end">
                    {actions.length ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="ghost" aria-label={`Actions for ${item.name}`}>
                            <MoreVertical />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          {actions.map((a) => (
                            <div key={a.id}>
                              {a.separatorBefore ? <DropdownMenuSeparator /> : null}
                              <DropdownMenuItem destructive={a.destructive} onSelect={a.onSelect}>
                                {a.icon}
                                <span className="flex-1">{a.label}</span>
                                {a.shortcut ? <kbd className="hidden text-xs text-slate-400 sm:inline">{a.shortcut}</kbd> : null}
                              </DropdownMenuItem>
                            </div>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </span>
                </li>
              </ContextMenuTrigger>
              {actions.length ? (
                <ContextMenuContent>
                  {actions.map((a) => (
                    <div key={a.id}>
                      {a.separatorBefore ? <ContextMenuSeparator /> : null}
                      <ContextMenuItem destructive={a.destructive} onSelect={a.onSelect}>
                        {a.icon}
                        <span className="flex-1">{a.label}</span>
                        {a.shortcut ? <kbd className="hidden text-xs text-slate-400 sm:inline">{a.shortcut}</kbd> : null}
                      </ContextMenuItem>
                    </div>
                  ))}
                </ContextMenuContent>
              ) : null}
            </ContextMenu>
          );
        })}
      </ul>
    </div>
  );
}

export function ListSkeleton() {
  return (
    <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading files">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2">
          <div className="size-5 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
          <div className={cn("h-4 animate-pulse rounded bg-slate-200 dark:bg-slate-800", i % 2 ? "w-1/3" : "w-1/2")} />
        </div>
      ))}
    </div>
  );
}
