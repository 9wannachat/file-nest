import { CheckCircle2, ChevronDown, ChevronUp, RotateCcw, X, XCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn, formatBytes } from "@/lib/utils";
import { useUploads, type UploadItem } from "./UploadProvider";

const label: Record<UploadItem["state"], string> = {
  queued: "Waiting",
  uploading: "Uploading",
  finalizing: "Verifying",
  done: "Done",
  error: "Failed",
  canceled: "Canceled",
};

export function UploadPanel() {
  const { items, active, retry, cancel, clearFinished } = useUploads();
  const [open, setOpen] = useState(true);
  if (!items.length) return null;
  const failed = items.filter((i) => i.state === "error").length;

  return (
    <section
      aria-label="Uploads"
      className="fixed inset-x-2 bottom-2 z-30 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-96 dark:border-slate-800 dark:bg-slate-900"
    >
      <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-2 dark:border-slate-800">
        <h2 className="flex-1 text-sm font-semibold" aria-live="polite">
          {active ? `Uploading ${active} file${active > 1 ? "s" : ""}` : failed ? `${failed} upload${failed > 1 ? "s" : ""} failed` : "Uploads complete"}
        </h2>
        {!active ? (
          <Button size="sm" variant="ghost" onClick={clearFinished}>
            Clear
          </Button>
        ) : null}
        <Button size="icon" variant="ghost" aria-label={open ? "Collapse uploads" : "Expand uploads"} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown /> : <ChevronUp />}
        </Button>
      </header>
      {open ? (
        <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
          {items.map((i) => (
            <li key={i.key} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{i.file.name}</div>
                <div className={cn("text-xs", i.state === "error" ? "text-red-600 dark:text-red-400" : "text-slate-500")}>
                  {i.state === "error" ? i.error : `${label[i.state]} · ${formatBytes(i.file.size)}`}
                </div>
                {i.state === "uploading" || i.state === "finalizing" ? (
                  <div
                    className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
                    role="progressbar"
                    aria-label={`${i.file.name} progress`}
                    aria-valuenow={Math.round(i.progress * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div className="h-full bg-brand-600 transition-[width]" style={{ width: `${Math.round(i.progress * 100)}%` }} />
                  </div>
                ) : null}
              </div>
              {i.state === "done" ? <CheckCircle2 className="size-5 text-emerald-600" aria-label="Done" /> : null}
              {i.state === "canceled" ? <XCircle className="size-5 text-slate-400" aria-label="Canceled" /> : null}
              {i.state === "error" ? (
                <Button size="sm" variant="outline" onClick={() => retry(i.key)}>
                  <RotateCcw /> Retry
                </Button>
              ) : null}
              {["queued", "uploading"].includes(i.state) ? (
                <Button size="icon" variant="ghost" aria-label={`Cancel ${i.file.name}`} onClick={() => cancel(i.key)}>
                  <X />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
