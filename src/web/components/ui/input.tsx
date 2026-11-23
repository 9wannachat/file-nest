import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm placeholder:text-slate-400 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-sm font-medium text-slate-700 dark:text-slate-300", className)} {...props} />;
}
