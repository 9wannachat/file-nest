import { ArrowDown, ArrowUp, File, FileImage, FileText, FileVideo, Folder, Globe, MoreVertical, Music, Users } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { DriveItem, FileItem } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn, formatBytes, formatDate } from "@/lib/utils";
import { t } from "@/i18n";

export interface ItemAction {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  separatorBefore?: boolean;
  shortcut?: string;
}

export type SortKey = "name" | "updated" | "size";
export type SortState = { key: SortKey; dir: "asc" | "desc" };
export type ViewMode = "list" | "grid";

export const itemKey = (i: DriveItem) => `${i.kind}:${i.id}`;

export function fileIcon(f: FileItem, className = "") {
  const ct = f.contentType;
  if (ct.startsWith("image/")) return <FileImage className={cn("text-violet-600 dark:text-violet-400", className)} />;
  if (ct.startsWith("video/")) return <FileVideo className={cn("text-rose-600 dark:text-rose-400", className)} />;
  if (ct.startsWith("audio/")) return <Music className={cn("text-amber-600 dark:text-amber-400", className)} />;
  if (ct === "application/pdf" || ct.startsWith("text/")) return <FileText className={cn("text-sky-600 dark:text-sky-400", className)} />;
  return <File className={cn("text-muted-foreground", className)} />;
}

function ItemIcon({ item, className }: { item: DriveItem; className?: string }) {
  return item.kind === "folder" ? <Folder className={cn("fill-primary/15 text-primary", className)} /> : fileIcon(item, className);
}

function sortItems(items: DriveItem[], sort: SortState): DriveItem[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  const by = (a: DriveItem, b: DriveItem) => {
    if (sort.key === "size") return ((a.kind === "file" ? a.size : -1) - (b.kind === "file" ? b.size : -1)) * dir;
    if (sort.key === "updated") return ((a.trashedAt ?? a.updatedAt) - (b.trashedAt ?? b.updatedAt)) * dir;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) * dir;
  };
  // Folders always first.
  return [...items].sort((a, b) => (a.kind === b.kind ? by(a, b) : a.kind === "folder" ? -1 : 1));
}

function ActionsMenu({ item, actions }: { item: DriveItem; actions: ItemAction[] }) {
  const isMobile = useIsMobile();
  const [sheet, setSheet] = useState(false);
  if (!actions.length) return null;
  const trigger = (
    <Button
      size="icon"
      variant="ghost"
      className="tap-target size-10 md:size-8"
      aria-label={t("Actions for {name}", { name: item.name })}
      onClick={isMobile ? (e) => (e.stopPropagation(), setSheet(true)) : (e) => e.stopPropagation()}
    >
      <MoreVertical />
    </Button>
  );
  if (isMobile) {
    return (
      <>
        {trigger}
        <Sheet open={sheet} onOpenChange={setSheet}>
          <SheetContent side="bottom" className="rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]">
            <SheetHeader className="pb-0">
              <SheetTitle className="flex items-center gap-2 truncate pr-8">
                <ItemIcon item={item} className="size-5 shrink-0" />
                <span className="truncate">{item.name}</span>
              </SheetTitle>
              <SheetDescription className="sr-only">{t("Actions")}</SheetDescription>
            </SheetHeader>
            <ul className="px-2" role="menu" aria-label={t("Actions for {name}", { name: item.name })}>
              {actions.map((a) => (
                <li key={a.id} role="none">
                  {a.separatorBefore ? <div className="my-1 h-px bg-border" /> : null}
                  <button
                    role="menuitem"
                    className={cn(
                      "flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-accent [&_svg]:size-5 [&_svg]:text-muted-foreground",
                      a.destructive && "text-destructive [&_svg]:text-destructive",
                    )}
                    onClick={() => {
                      setSheet(false);
                      a.onSelect();
                    }}
                  >
                    {a.icon}
                    {a.label}
                  </button>
                </li>
              ))}
            </ul>
          </SheetContent>
        </Sheet>
      </>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {actions.map((a) => (
          <div key={a.id}>
            {a.separatorBefore ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem variant={a.destructive ? "destructive" : "default"} onSelect={a.onSelect}>
              {a.icon}
              {a.label}
              {a.shortcut ? <DropdownMenuShortcut>{a.shortcut}</DropdownMenuShortcut> : null}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RowContextMenu({ actions, children }: { actions: ItemAction[]; children: ReactNode }) {
  if (!actions.length) return <>{children}</>;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {actions.map((a) => (
          <div key={a.id}>
            {a.separatorBefore ? <ContextMenuSeparator /> : null}
            <ContextMenuItem variant={a.destructive ? "destructive" : "default"} onSelect={a.onSelect}>
              {a.icon}
              {a.label}
              {a.shortcut ? <ContextMenuShortcut>{a.shortcut}</ContextMenuShortcut> : null}
            </ContextMenuItem>
          </div>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function SharingBadges({ item }: { item: DriveItem }) {
  if (item.kind !== "file") return null;
  return (
    <>
      {item.hasPublicLink ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Globe className="size-4 shrink-0 text-primary" aria-label={t("Public link")} />
          </TooltipTrigger>
          <TooltipContent>{t("Anyone with the link")}</TooltipContent>
        </Tooltip>
      ) : null}
      {item.sharedWithCount > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Users className="size-4 shrink-0 text-muted-foreground" aria-label={t("Shared with {sharedWithCount}", { sharedWithCount: item.sharedWithCount })} />
          </TooltipTrigger>
          <TooltipContent>{t("Shared with")}{" "}{item.sharedWithCount}{" "}{t("member(s)")}</TooltipContent>
        </Tooltip>
      ) : null}
    </>
  );
}

function SortHeader({
  k,
  sort,
  onSort,
  children,
  className,
}: {
  k: SortKey;
  sort: SortState;
  onSort: (k: SortKey) => void;
  children: string;
  className?: string;
}) {
  const active = sort.key === k;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      className={cn("inline-flex items-center gap-1 rounded hover:text-foreground", active && "text-foreground", className)}
      aria-label={t(!active ? "Sort by {col}" : sort.dir === "asc" ? "Sort by {col}, ascending" : "Sort by {col}, descending", { col: String(children) })}
    >
      {children}
      {active ? sort.dir === "asc" ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" /> : null}
    </button>
  );
}

/** Number of grid columns currently rendered (tiles sharing the first tile's row). */
function gridColumns(container: HTMLElement | null): number {
  const tiles = container?.querySelectorAll<HTMLElement>("[data-row]");
  if (!tiles?.length) return 1;
  const top = tiles[0]!.offsetTop;
  let n = 0;
  for (const tile of tiles) {
    if (tile.offsetTop !== top) break;
    n++;
  }
  return Math.max(1, n);
}

interface Props {
  items: DriveItem[];
  actionsFor: (item: DriveItem) => ItemAction[];
  onOpen: (item: DriveItem) => void;
  showOwner?: boolean;
  dateLabel?: string;
  view?: ViewMode;
  sort: SortState;
  onSort: (key: SortKey) => void;
  selected?: Set<string>;
  onSelectedChange?: (next: Set<string>) => void;
}

export function FileList({
  items,
  actionsFor,
  onOpen,
  showOwner,
  dateLabel = t("Modified"),
  view = "list",
  sort,
  onSort,
  selected,
  onSelectedChange,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const sorted = useMemo(() => sortItems(items, sort), [items, sort]);
  const selectable = !!onSelectedChange && !!selected;
  const allSelected = selectable && sorted.length > 0 && sorted.every((i) => selected.has(itemKey(i)));
  const someSelected = selectable && !allSelected && sorted.some((i) => selected.has(itemKey(i)));

  const toggle = (item: DriveItem, on?: boolean) => {
    if (!selectable) return;
    const next = new Set(selected);
    const k = itemKey(item);
    if (on ?? !next.has(k)) next.add(k);
    else next.delete(k);
    onSelectedChange(next);
  };

  const focusRow = (idx: number) => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-row]");
    if (!rows?.length) return;
    rows[Math.max(0, Math.min(rows.length - 1, idx))]?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLElement>, item: DriveItem, idx: number) => {
    if (e.target !== e.currentTarget) return; // let inner controls handle their own keys
    const run = (id: string) => actionsFor(item).find((a) => a.id === id)?.onSelect();
    const step = view === "grid" ? gridColumns(listRef.current) : 1;
    const keys: Record<string, () => void> = {
      Enter: () => onOpen(item),
      ...(selectable ? { " ": () => toggle(item) } : {}),
      ArrowDown: () => focusRow(idx + step),
      ArrowUp: () => focusRow(idx - step),
      ...(view === "grid" ? { ArrowRight: () => focusRow(idx + 1), ArrowLeft: () => focusRow(idx - 1) } : {}),
      Home: () => focusRow(0),
      End: () => focusRow(sorted.length - 1),
      F2: () => run("rename"),
      Delete: () => run("trash"),
    };
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  const selectBox = (item: DriveItem) =>
    selectable ? (
      <Checkbox
        checked={selected.has(itemKey(item))}
        onCheckedChange={(v) => toggle(item, v === true)}
        onClick={(e) => e.stopPropagation()}
        aria-label={t("Select {name}", { name: item.name })}
        className="size-5 md:size-4"
      />
    ) : null;

  if (view === "grid") {
    return (
      <div className="px-4 pb-4 sm:px-6">
        <div className="mb-2 flex items-center gap-3 text-xs text-muted-foreground">
          {selectable ? (
            <Checkbox
              checked={allSelected ? true : someSelected ? "indeterminate" : false}
              onCheckedChange={(v) => onSelectedChange(v === true ? new Set(sorted.map(itemKey)) : new Set())}
              aria-label={t("Select all")}
            />
          ) : null}
          <span>{t("Sort:")}</span>
          <SortHeader k="name" sort={sort} onSort={onSort}>{t("Name")}</SortHeader>
          <SortHeader k="updated" sort={sort} onSort={onSort}>{dateLabel}</SortHeader>
          <SortHeader k="size" sort={sort} onSort={onSort}>{t("Size")}</SortHeader>
        </div>
        <div ref={listRef} role="list" aria-label={t("Files and folders")} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {sorted.map((item, idx) => {
            const actions = actionsFor(item);
            const isSel = selected?.has(itemKey(item));
            return (
              <RowContextMenu key={itemKey(item)} actions={actions}>
                <div
                  role="listitem"
                  data-row
                  tabIndex={0}
                  aria-label={t(item.kind === "folder" ? "Folder {name}" : "File {name}", { name: item.name })}
                  onDoubleClick={() => onOpen(item)}
                  onKeyDown={(e) => onKey(e, item, idx)}
                  className={cn(
                    "group relative flex flex-col rounded-xl border bg-card p-3 text-card-foreground shadow-xs outline-none transition-colors hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    isSel && "border-primary bg-accent/60",
                  )}
                >
                  <div className="absolute top-2 left-2">{selectBox(item)}</div>
                  <div className="absolute top-1 right-1">
                    <ActionsMenu item={item} actions={actions} />
                  </div>
                  <button type="button" tabIndex={-1} onClick={() => onOpen(item)} className="flex min-w-0 flex-col gap-1 text-left">
                    <span className="flex justify-center pt-6 pb-1">
                      <ItemIcon item={item} className="size-12 stroke-[1.25]" />
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-sm font-medium" title={item.name}>
                        {item.name}
                      </span>
                      <SharingBadges item={item} />
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {item.kind === "file" ? `${formatBytes(item.size)} · ` : ""}
                      {formatDate(item.trashedAt ?? item.updatedAt)}
                    </span>
                  </button>
                </div>
              </RowContextMenu>
            );
          })}
        </div>
      </div>
    );
  }

  const cols = showOwner
    ? "md:grid-cols-[auto_minmax(0,1fr)_11rem_11rem_6rem_2.5rem]"
    : "md:grid-cols-[auto_minmax(0,1fr)_11rem_6rem_2.5rem]";

  return (
    <div className="px-2 pb-4 sm:px-4">
      <div
        className={cn(
          "hidden items-center gap-3 border-b px-3 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase md:grid",
          cols,
        )}
      >
        <span className="flex w-5 justify-center">
          {selectable ? (
            <Checkbox
              checked={allSelected ? true : someSelected ? "indeterminate" : false}
              onCheckedChange={(v) => onSelectedChange(v === true ? new Set(sorted.map(itemKey)) : new Set())}
              aria-label={t("Select all")}
            />
          ) : null}
        </span>
        <SortHeader k="name" sort={sort} onSort={onSort}>{t("Name")}</SortHeader>
        {showOwner ? <span>{t("Owner")}</span> : null}
        <SortHeader k="updated" sort={sort} onSort={onSort}>{dateLabel}</SortHeader>
        <SortHeader k="size" sort={sort} onSort={onSort} className="justify-self-end">
          {t("Size")}
        </SortHeader>
        <span />
      </div>
      <div ref={listRef} role="list" aria-label={t("Files and folders")} className="divide-y divide-border/60">
        {sorted.map((item, idx) => {
          const actions = actionsFor(item);
          const isSel = selected?.has(itemKey(item));
          return (
            <RowContextMenu key={itemKey(item)} actions={actions}>
              <div
                role="listitem"
                data-row
                tabIndex={0}
                aria-label={t(item.kind === "folder" ? "Folder {name}" : "File {name}", { name: item.name })}
                onDoubleClick={() => onOpen(item)}
                onKeyDown={(e) => onKey(e, item, idx)}
                className={cn(
                  "group grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-1.5 outline-none hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40",
                  cols,
                  isSel && "bg-accent/70",
                )}
              >
                <span className="flex w-5 justify-center">{selectBox(item)}</span>
                <button type="button" tabIndex={-1} onClick={() => onOpen(item)} className="flex min-w-0 items-center gap-3 text-left">
                  <ItemIcon item={item} className="size-5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{item.name}</span>
                    <span className="block truncate text-xs text-muted-foreground md:hidden">
                      {item.kind === "file" ? `${formatBytes(item.size)} · ` : ""}
                      {formatDate(item.trashedAt ?? item.updatedAt)}
                      {showOwner && item.kind === "file" ? ` · ${item.owner.name ?? item.owner.email}` : ""}
                    </span>
                  </span>
                  <SharingBadges item={item} />
                </button>
                {showOwner ? (
                  <span className="hidden truncate text-sm text-muted-foreground md:block">
                    {item.kind === "file" ? (item.isOwner ? "me" : (item.owner.name ?? item.owner.email)) : ""}
                  </span>
                ) : null}
                <span className="hidden text-sm whitespace-nowrap text-muted-foreground md:block">{formatDate(item.trashedAt ?? item.updatedAt)}</span>
                <span className="hidden text-right text-sm text-muted-foreground tabular-nums md:block">
                  {item.kind === "file" ? formatBytes(item.size) : "—"}
                </span>
                <span className="flex justify-end">
                  <ActionsMenu item={item} actions={actions} />
                </span>
              </div>
            </RowContextMenu>
          );
        })}
      </div>
    </div>
  );
}
