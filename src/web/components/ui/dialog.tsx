import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  className,
  children,
  wide,
  ...props
}: React.ComponentProps<typeof D.Content> & { wide?: boolean }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-[1px]" />
      <D.Content
        className={cn(
          "fixed z-50 flex max-h-[92dvh] flex-col overflow-hidden bg-white shadow-xl dark:bg-slate-900",
          "inset-x-0 bottom-0 rounded-t-2xl sm:inset-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl",
          wide ? "sm:w-[min(92vw,1100px)]" : "sm:w-[min(92vw,480px)]",
          className,
        )}
        {...props}
      >
        {children}
        <D.Close
          className="absolute right-3 top-3 inline-flex size-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          aria-label="Close"
        >
          <X className="size-5" />
        </D.Close>
      </D.Content>
    </D.Portal>
  );
}

export function DialogHeader({ title, description }: { title: React.ReactNode; description?: React.ReactNode }) {
  return (
    <div className="border-b border-slate-200 px-5 py-4 pr-14 dark:border-slate-800">
      <D.Title className="truncate text-base font-semibold">{title}</D.Title>
      {description ? (
        <D.Description className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{description}</D.Description>
      ) : (
        <D.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</D.Description>
      )}
    </div>
  );
}

export function DialogBody({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("overflow-y-auto px-5 py-4", className)} {...p} />;
}

export function DialogFooter({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-3 sm:flex-row sm:justify-end dark:border-slate-800", className)}
      {...p}
    />
  );
}
