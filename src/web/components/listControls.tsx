import { LayoutGrid, List } from "lucide-react";
import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { SortKey, SortState, ViewMode } from "./FileList";
import { t } from "@/i18n";

const LIST_PARAMS = ["view", "sort", "dir"] as const;

/** Append the current view/sort params to an in-app path so navigation keeps them. */
export function withListParams(path: string, current: URLSearchParams): string {
  const keep = new URLSearchParams();
  for (const k of LIST_PARAMS) {
    const v = current.get(k);
    if (v) keep.set(k, v);
  }
  const q = keep.toString();
  return q ? `${path}${path.includes("?") ? "&" : "?"}${q}` : path;
}

/** Sort and view mode live in the URL (?sort=name&dir=asc&view=grid), not in storage. */
export function useListView(defaultSort: SortState = { key: "name", dir: "asc" }) {
  const [params, setParams] = useSearchParams();
  const view: ViewMode = params.get("view") === "grid" ? "grid" : "list";
  const key = params.get("sort");
  const sort: SortState =
    key === "name" || key === "updated" || key === "size" ? { key, dir: params.get("dir") === "desc" ? "desc" : "asc" } : defaultSort;

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v === null ? next.delete(k) : next.set(k, v));
    setParams(next, { replace: true });
  };

  return {
    view,
    setView: (v: ViewMode) => update({ view: v === "grid" ? "grid" : null }),
    sort,
    onSort: (k: SortKey) =>
      update({ sort: k, dir: sort.key === k ? (sort.dir === "asc" ? "desc" : "asc") : k === "name" ? "asc" : "desc" }),
  };
}

export function ViewToggle({ view, setView }: { view: ViewMode; setView: (v: ViewMode) => void }) {
  return (
    <div className="flex rounded-md border p-0.5" role="group" aria-label={t("View")}>
      {(
        [
          ["list", List, t("List view")],
          ["grid", LayoutGrid, t("Grid view")],
        ] as const
      ).map(([v, Icon, label]) => (
        <Tooltip key={v}>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              className="tap-target"
              variant={view === v ? "secondary" : "ghost"}
              aria-label={label}
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              <Icon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
