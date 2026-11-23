import { AlertTriangle, HardDrive } from "lucide-react";
import { Link } from "react-router";
import type { Me } from "@shared/types";
import { cn, formatBytes } from "@/lib/utils";

export type QuotaLevel = "ok" | "warn" | "critical";

/** Usage summary for the signed-in member (trash counts toward the quota). */
export function quotaState(user: Me["user"]) {
  const unlimited = !!user.quotaUnlimited;
  const pct = unlimited || user.quotaBytes <= 0 ? 0 : (user.usedBytes / user.quotaBytes) * 100;
  const level: QuotaLevel = unlimited ? "ok" : pct >= 95 ? "critical" : pct >= 80 ? "warn" : "ok";
  const remaining = unlimited ? null : Math.max(0, user.quotaBytes - user.usedBytes);
  return { unlimited, pct, level, remaining, trashed: user.trashedBytes ?? 0 };
}

export function QuotaBar({ user, className }: { user: Me["user"]; className?: string }) {
  const q = quotaState(user);
  const usedPct = Math.min(100, q.pct);
  const trashPct = q.unlimited || user.quotaBytes <= 0 ? 0 : Math.min(usedPct, (q.trashed / user.quotaBytes) * 100);
  return (
    <div className={cn("grid gap-1.5", className)}>
      <div className="flex items-center gap-2 text-xs opacity-80">
        <HardDrive className="size-3.5" aria-hidden /> Storage
      </div>
      {q.unlimited ? null : (
        <div
          role="meter"
          aria-label="Storage used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(usedPct)}
          className="relative h-2 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              "absolute inset-y-0 left-0 rounded-full",
              q.level === "critical" ? "bg-destructive" : q.level === "warn" ? "bg-warning" : "bg-primary",
            )}
            style={{ width: `${usedPct}%` }}
          />
          {trashPct > 0 ? (
            <div className="absolute inset-y-0 rounded-r-full bg-muted-foreground/40" style={{ left: `${usedPct - trashPct}%`, width: `${trashPct}%` }} />
          ) : null}
        </div>
      )}
      <p className="text-xs opacity-75">
        {q.unlimited ? `${formatBytes(user.usedBytes)} used · no limit` : `${formatBytes(user.usedBytes)} of ${formatBytes(user.quotaBytes)} used`}
        {q.trashed > 0 ? ` · ${formatBytes(q.trashed)} in trash` : ""}
      </p>
    </div>
  );
}

/** Banner at 80% (warning) and 95%+ (critical). */
export function QuotaBanner({ user }: { user: Me["user"] }) {
  const q = quotaState(user);
  if (q.level === "ok") return null;
  const full = q.remaining === 0;
  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-2 px-4 py-2 text-sm",
        q.level === "critical" ? "bg-destructive/15 text-foreground" : "bg-warning/20 text-foreground",
      )}
    >
      <AlertTriangle className={cn("size-4 shrink-0", q.level === "critical" ? "text-destructive" : "text-warning")} aria-hidden />
      <span className="flex-1">
        {full ? "Your storage is full. New uploads are blocked." : `You’ve used ${Math.round(q.pct)}% of your storage.`}{" "}
        {q.trashed > 0 ? `Emptying the trash frees ${formatBytes(q.trashed)}.` : "Delete files you no longer need, or ask an Admin for more space."}
      </span>
      {q.trashed > 0 ? (
        <Link to="/trash" className="font-medium underline underline-offset-2">
          Open trash
        </Link>
      ) : null}
    </div>
  );
}
