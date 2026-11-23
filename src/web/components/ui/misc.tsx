import { Switch as S } from "radix-ui";
import { AlertTriangle, Loader2 } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export function Badge({ className, tone = "slate", ...p }: React.HTMLAttributes<HTMLSpanElement> & { tone?: "slate" | "green" | "amber" | "red" | "brand" }) {
  const tones = {
    slate: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    red: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
    brand: "bg-brand-100 text-brand-800 dark:bg-brand-800/40 dark:text-brand-100",
  };
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", tones[tone], className)} {...p} />;
}

export function Switch({ className, ...p }: React.ComponentProps<typeof S.Root>) {
  return (
    <S.Root
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-slate-300 transition-colors data-[state=checked]:bg-brand-700 disabled:opacity-50 dark:bg-slate-700",
        className,
      )}
      {...p}
    >
      <S.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[22px]" />
    </S.Root>
  );
}

export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-2 text-slate-500", className)}>
      <Loader2 className="size-5 animate-spin" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800", className)} />;
}

export function EmptyState({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-700 dark:bg-brand-800/30 dark:text-brand-100 [&_svg]:size-7">
        {icon}
      </div>
      <h2 className="text-base font-semibold">{title}</h2>
      {children ? <div className="max-w-sm text-sm text-slate-500 dark:text-slate-400">{children}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="m-4 flex flex-col items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 sm:flex-row sm:items-center dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
      <AlertTriangle className="size-5 shrink-0" aria-hidden />
      <span className="flex-1">{message}</span>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
