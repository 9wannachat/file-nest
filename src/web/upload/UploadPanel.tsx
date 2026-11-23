import { CheckCircle2, ChevronDown, ChevronUp, RotateCcw, X, XCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
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
  const done = items.filter((i) => i.state === "done").length;

  return (
    <Card
      role="region"
      aria-label="Uploads"
      className="fixed inset-x-2 bottom-2 z-30 gap-0 overflow-hidden py-0 shadow-xl sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-96"
    >
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <div className="flex-1">
          <h2 className="text-sm font-semibold" aria-live="polite">
            {active ? `Uploading ${active} file${active > 1 ? "s" : ""}` : failed ? `${failed} upload${failed > 1 ? "s" : ""} failed` : "Uploads complete"}
          </h2>
          <p className="text-xs text-muted-foreground">
            {done} done{failed ? ` · ${failed} failed` : ""}
          </p>
        </div>
        {!active ? (
          <Button size="sm" variant="ghost" onClick={clearFinished}>
            Clear
          </Button>
        ) : null}
        <Button size="icon-sm" variant="ghost" className="size-10 md:size-8" aria-label={open ? "Collapse uploads" : "Expand uploads"} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown /> : <ChevronUp />}
        </Button>
      </header>
      {open ? (
        <ul className="max-h-72 divide-y overflow-y-auto">
          {items.map((i) => (
            <li key={i.key} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{i.file.name}</div>
                <div className={cn("text-xs", i.state === "error" ? "text-destructive" : "text-muted-foreground")}>
                  {i.state === "error" ? i.error : `${label[i.state]} · ${formatBytes(i.file.size)}`}
                </div>
                {i.state === "uploading" || i.state === "finalizing" ? (
                  <Progress value={Math.round(i.progress * 100)} aria-label={`${i.file.name} progress`} className="mt-1.5 h-1.5" />
                ) : null}
              </div>
              {i.state === "done" ? <CheckCircle2 className="size-5 text-success" aria-label="Done" /> : null}
              {i.state === "canceled" ? <XCircle className="size-5 text-muted-foreground" aria-label="Canceled" /> : null}
              {i.state === "error" ? (
                <Button size="sm" variant="outline" onClick={() => retry(i.key)}>
                  <RotateCcw /> Retry
                </Button>
              ) : null}
              {["queued", "uploading"].includes(i.state) ? (
                <Button size="icon-sm" variant="ghost" className="size-10 md:size-8" aria-label={`Cancel ${i.file.name}`} onClick={() => cancel(i.key)}>
                  <X />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
