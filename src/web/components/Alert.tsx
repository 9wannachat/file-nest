import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** Minimal shadcn-style alert. */
export function Alert({ className, variant = "default", ...p }: HTMLAttributes<HTMLDivElement> & { variant?: "default" | "destructive" }) {
  return (
    <div
      role="alert"
      className={cn(
        "rounded-lg border px-4 py-3 text-sm",
        variant === "destructive" ? "border-destructive/40 bg-destructive/10 text-destructive" : "bg-card text-card-foreground",
        className,
      )}
      {...p}
    />
  );
}

export function AlertDescription({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-sm", className)} {...p} />;
}
